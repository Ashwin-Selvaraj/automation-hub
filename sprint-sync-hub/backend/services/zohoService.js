'use strict';

/**
 * zohoService.js — Zoho People attendance and leave integration.
 *
 * Required env vars:
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 *   ZOHO_ORG_IDENTIFIER — company slug (e.g. "marmafintech"), NOT a numeric ID
 *   ZOHO_DOMAIN         — zoho.in | zoho.com | zoho.eu  (default: zoho.in)
 *
 * OAuth token:  https://accounts.{ZOHO_DOMAIN}/oauth/v2/token
 * People API:   https://www.zohoapis.{tld}/people/api/...
 *               e.g. https://www.zohoapis.in/people/api/attendance/getAttendance
 *
 * All public functions return null / empty array if Zoho is not configured,
 * so the rest of the app degrades gracefully when the integration is disabled.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// File used to persist the token across server restarts — avoids hitting
// the token endpoint on every cold start and triggering Zoho rate limits.
const TOKEN_CACHE_FILE = path.join(__dirname, '..', '.zoho_token_cache.json');

// ─── Structured logger ────────────────────────────────────────────────────────

function zohoLog(level, message, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    service:   'ZohoService',
    level,
    message,
    ...(data || {}),
  };
  if (level === 'ERROR') console.error(JSON.stringify(entry));
  else if (level === 'WARN') console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ─── Config ───────────────────────────────────────────────────────────────────

function getConfig() {
  const domain = process.env.ZOHO_DOMAIN || 'zoho.in';
  const tld    = domain.includes('.') ? domain.substring(domain.indexOf('.')) : '.in';
  return {
    clientId:      process.env.ZOHO_CLIENT_ID      || '',
    clientSecret:  process.env.ZOHO_CLIENT_SECRET  || '',
    refreshToken:  process.env.ZOHO_REFRESH_TOKEN  || '',
    orgIdentifier: process.env.ZOHO_ORG_IDENTIFIER || '',
    domain,
    tld,
    accountsHost: `accounts.${domain}`,          // e.g. accounts.zoho.in
    apiHost:      `www.zohoapis${tld}`,           // e.g. www.zohoapis.in
    peopleHost:   `people.${domain}`,             // e.g. people.zoho.in (fallback)
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.clientId && c.clientSecret && c.refreshToken);
}

// ─── Token cache (in-memory + file-backed) ───────────────────────────────────

let _token         = null;
let _tokenExpiry   = 0;
let _refreshPromise = null; // mutex: prevents concurrent refresh calls

/**
 * Load a previously persisted token from disk (survives server restarts).
 * Only called once at startup.
 */
function loadCachedTokenFromDisk() {
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      const { token, expiresAt } = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
      if (token && expiresAt && Date.now() < expiresAt - 300_000) {
        _token       = token;
        _tokenExpiry = expiresAt;
        zohoLog('INFO', 'Token loaded from disk cache', { expiresAt: new Date(expiresAt).toISOString() });
      }
    }
  } catch (_) { /* non-fatal — will refresh from Zoho */ }
}

function saveTokenToDisk(token, expiresAt) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token, expiresAt }), 'utf8');
  } catch (err) {
    zohoLog('WARN', 'Could not persist token to disk', { error: err.message });
  }
}

// Load disk cache immediately on module load
loadCachedTokenFromDisk();

/**
 * Returns a valid OAuth access token.
 *
 * - Uses in-memory cache first (fastest path)
 * - Falls back to disk cache (survives server restarts, avoids rate limits)
 * - Only calls Zoho token endpoint when both caches are empty or expired
 * - Mutex prevents concurrent refresh calls (important for batch attendance fetches)
 */
async function getAccessToken() {
  // In-memory cache hit
  if (_token && Date.now() < _tokenExpiry - 300_000) return _token;

  // If a refresh is already in progress, wait for it — don't make a second call
  if (_refreshPromise) return _refreshPromise;

  const c = getConfig();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    throw new Error('Zoho credentials missing — check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in .env');
  }

  _refreshPromise = (async () => {
    try {
      zohoLog('INFO', 'Refreshing Zoho access token');
      const response = await axios.post(
        `https://${c.accountsHost}/oauth/v2/token`,
        null,
        {
          params: {
            grant_type:    'refresh_token',
            client_id:     c.clientId,
            client_secret: c.clientSecret,
            refresh_token: c.refreshToken,
          },
          timeout: 12_000,
        }
      );

      if (!response.data.access_token) {
        throw new Error(`Token response missing access_token: ${JSON.stringify(response.data)}`);
      }

      _token       = response.data.access_token;
      _tokenExpiry = Date.now() + parseInt(response.data.expires_in || '3600', 10) * 1_000;

      saveTokenToDisk(_token, _tokenExpiry);
      zohoLog('INFO', 'Token refreshed and cached', {
        expiresIn:   response.data.expires_in,
        tokenPrefix: _token.substring(0, 15),
      });

      return _token;
    } catch (err) {
      const isRateLimit = err.response?.data?.error === 'Access Denied' ||
        String(err.response?.data?.error_description || '').includes('too many requests');

      if (isRateLimit) {
        // Don't wipe the in-memory token if we're just rate-limited — the old
        // token may still be valid for another hour. Only clear if truly expired.
        if (_token && Date.now() < _tokenExpiry) {
          zohoLog('WARN', 'Rate limited by Zoho token endpoint — reusing existing token', {
            tokenValidUntil: new Date(_tokenExpiry).toISOString(),
          });
          return _token;
        }
        zohoLog('ERROR', 'Rate limited and no valid cached token available', {
          hint: 'Wait ~10 minutes before retrying, or restart after the rate limit clears',
        });
      }

      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      zohoLog('ERROR', 'Token refresh failed', { detail });
      throw new Error(`Zoho token refresh failed: ${detail}`);
    } finally {
      _refreshPromise = null; // release mutex
    }
  })();

  return _refreshPromise;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getTodayDateString() {
  // Uses local time (not UTC) so the date matches what Zoho records
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  const d   = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDateStr(d) {
  if (!d) return getTodayDateString();
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().split('T')[0];
}

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':');
  if (parts.length < 2) return null;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Extract standardised attendance fields from a single Zoho record.
 * Handles all field-name variations Zoho uses across API versions.
 */
function extractAttendanceFields(record) {
  const checkIn = record.checkIn   || record.CheckIn   || record.check_in
    || record.attendanceCheckIn    || record.checkinTime || null;
  const checkOut = record.checkOut  || record.CheckOut  || record.check_out
    || record.attendanceCheckOut   || record.checkoutTime || null;
  const hours = record.hoursWorked || record.hours_worked || record.totalHours
    || record.workHours || null;
  const status = record.attendanceStatus || record.status || record.Status
    || (checkIn ? 'Present' : 'Absent');

  return {
    checkedIn:    !!checkIn,
    checkInTime:  checkIn  ? String(checkIn).substring(0, 5)  : null,
    checkedOut:   !!checkOut,
    checkOutTime: checkOut ? String(checkOut).substring(0, 5) : null,
    hoursWorked:  hours ? parseFloat(hours) : null,
    status:       String(status),
  };
}

/**
 * Parse a Zoho People API response into a consistent attendance object.
 * Returns null if the shape is unrecognised (caller should try next endpoint).
 */
function parseAttendanceResponse(data, contextLabel) {
  if (!data) return null;

  // Shape 1: { response: { result: [ {...} ] } }
  if (data?.response?.result) {
    const records = Array.isArray(data.response.result)
      ? data.response.result
      : [data.response.result];
    if (records.length > 0) return extractAttendanceFields(records[0]);
    // result is an empty array → no attendance record for this date
    return {
      checkedIn: false, checkInTime: null, checkedOut: false,
      checkOutTime: null, hoursWorked: null, status: 'No Record',
    };
  }

  // Shape 2: Direct array [ {...} ]
  if (Array.isArray(data)) {
    if (data.length > 0) return extractAttendanceFields(data[0]);
    return {
      checkedIn: false, checkInTime: null, checkedOut: false,
      checkOutTime: null, hoursWorked: null, status: 'No Record',
    };
  }

  // Shape 3: { data: [ {...} ] }
  if (data?.data && Array.isArray(data.data)) {
    if (data.data.length > 0) return extractAttendanceFields(data.data[0]);
    return {
      checkedIn: false, checkInTime: null, checkedOut: false,
      checkOutTime: null, hoursWorked: null, status: 'No Record',
    };
  }

  // Shape 4: Top-level record object
  if (data?.checkIn || data?.CheckIn || data?.check_in || data?.attendanceCheckIn) {
    return extractAttendanceFields(data);
  }

  // Shape 5: Error response from Zoho
  if (data?.response?.errors || data?.errors) {
    const errDetail = JSON.stringify(data?.response?.errors || data?.errors);
    zohoLog('WARN', 'Zoho API returned error shape', { context: contextLabel, errors: errDetail });
    return {
      checkedIn: false, checkInTime: null, checkedOut: false,
      checkOutTime: null, hoursWorked: null, status: 'API Error',
    };
  }

  // Unrecognised — log so we can fix the parser
  zohoLog('WARN', 'Unrecognised Zoho response shape', {
    context: contextLabel,
    sample:  JSON.stringify(data).substring(0, 300),
  });
  return null;
}

// ─── Presence API (/_chat/v2/users) ──────────────────────────────────────────

/**
 * Fetch all Zoho organisation members with real-time presence data.
 * Uses /_chat/v2/users — confirmed working on this account.
 * Handles has_more pagination automatically.
 *
 * Required scope: ZohoCliq.users.READ (in addition to People scopes)
 *
 * @returns {Promise<Array<{
 *   iamuid: string, email: string, fullName: string,
 *   firstName: string, lastName: string, employeeId: string,
 *   department: string, designation: string,
 *   isPresent: boolean, presenceStatus: string,
 *   statusMessage: string, rawPresence: object
 * }>>}
 */
async function getAllUsersWithPresence() {
  const token = await getAccessToken();
  const all   = [];

  // Zoho returns all users in one call for small orgs (has_more=false).
  // If has_more=true, Zoho Chat uses a cursor in the next_token field.
  let nextToken = null;

  while (true) {
    const params = { fields: 'all,presence', nocache: Date.now() };
    if (nextToken) params.from = nextToken; // cursor for next page

    const response = await axios.get(
      'https://people.zoho.in/_chat/v2/users',
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params,
        timeout: 15_000,
      }
    );

    const body = response.data;
    if (!body?.data || !Array.isArray(body.data)) {
      zohoLog('ERROR', 'Unexpected response from /_chat/v2/users', {
        sample: JSON.stringify(body).substring(0, 300),
      });
      break;
    }

    const mapped = body.data.map(user => {
      const presence = user.presence || {};
      const st    = String(presence.st    || '0');
      const scode = String(presence.scode || '0');

      let presenceStatus = 'offline';
      if (st === '1') {
        if      (scode === '1') presenceStatus = 'busy';
        else if (scode === '2') presenceStatus = 'away';
        else                    presenceStatus = 'online';
      }

      return {
        iamuid:        String(user.iamuid || user.id || ''),
        email:         (user.email_id || '').toLowerCase().trim(),
        fullName:      user.full_name    || user.display_name || '',
        firstName:     user.first_name  || '',
        lastName:      user.last_name   || '',
        employeeId:    user.employee_id || '',
        department:    user.department?.name  || '',
        designation:   user.designation?.name || '',
        isPresent:     st === '1',
        presenceStatus,
        statusMessage: presence.smsg || '',
        rawPresence:   presence,
      };
    });

    all.push(...mapped);

    // Paginate only if Zoho signals more data exists
    if ((body.has_more === true || body.has_more === 'true') && body.next_token) {
      nextToken = body.next_token;
    } else {
      break; // done — all users fetched
    }
  }

  zohoLog('INFO', 'Presence data fetched', {
    total:   all.length,
    present: all.filter(u => u.isPresent).length,
  });

  return all;
}

/**
 * Get today's attendance for all DB team members by matching them to
 * Zoho presence data. Matches by iamuid → email → first name (fallback).
 *
 * @param {number} organisationId
 * @returns {Promise<Array<{
 *   memberId: number, name: string, email: string, slackUserId: string,
 *   isPresent: boolean, presenceStatus: string, statusMessage: string,
 *   matchedBy: 'iamuid'|'email'|'name'|'none', zohoEmail: string|null,
 *   zohoName: string|null, department: string|null,
 *   checkedIn: boolean  ← alias of isPresent for backward compat
 * }>>}
 */
async function getAllTodayAttendance(organisationId) {
  if (!isConfigured()) {
    zohoLog('WARN', 'getAllTodayAttendance skipped — Zoho not configured');
    return [];
  }

  const { query } = require('../db');
  const orgId     = organisationId || parseInt(process.env.ORGANISATION_ID || '1', 10);

  // Load DB members
  let dbMembers = [];
  try {
    const res = await query(
      `SELECT id, name, email, slack_user_id, zoho_iamuid
       FROM members WHERE is_active = true AND organisation_id = $1 ORDER BY name`,
      [orgId]
    );
    dbMembers = res.rows;
  } catch (err) {
    zohoLog('ERROR', 'Cannot load members from DB', { error: err.message });
    return [];
  }

  if (!dbMembers.length) {
    zohoLog('WARN', 'No active members in DB');
    return [];
  }

  // Fetch Zoho presence (one API call for the whole org)
  let zohoUsers = [];
  try {
    zohoUsers = await getAllUsersWithPresence();
    const presentNames = zohoUsers.filter(u => u.isPresent).map(u => u.fullName);
    zohoLog('INFO', 'Zoho presence loaded', {
      total:   zohoUsers.length,
      present: presentNames.length,
      presentNames: presentNames.join(', ') || 'none',
    });
  } catch (err) {
    zohoLog('ERROR', 'Failed to fetch Zoho presence — returning all as unknown', { error: err.message });
    return dbMembers.map(m => ({
      memberId:      m.id,
      name:          m.name,
      email:         m.email,
      slackUserId:   m.slack_user_id,
      checkedIn:     false,
      isPresent:     false,
      presenceStatus: 'unknown',
      statusMessage: 'Zoho unavailable',
      matchedBy:     'none',
      zohoEmail:     null,
      zohoName:      null,
      department:    null,
    }));
  }

  // Build lookup maps
  const byEmail  = new Map(zohoUsers.map(z => [z.email,  z]));
  const byIamuid = new Map(zohoUsers.map(z => [z.iamuid, z]));

  return dbMembers.map(member => {
    let zohoUser  = null;
    let matchedBy = 'none';

    // 1: zoho_iamuid stored in DB
    if (member.zoho_iamuid && byIamuid.has(String(member.zoho_iamuid))) {
      zohoUser  = byIamuid.get(String(member.zoho_iamuid));
      matchedBy = 'iamuid';
    }

    // 2: exact email match
    if (!zohoUser && member.email) {
      const key = member.email.toLowerCase().trim();
      if (byEmail.has(key)) {
        zohoUser  = byEmail.get(key);
        matchedBy = 'email';
      }
    }

    // 3: name-based fallback — handles email mismatches (e.g. Asaraf: DB has
    //    "Asaraf" / "mohamed@throughbit.com" but Zoho has "Mohamed Asaraf" /
    //    "mdasaraf042@gmail.com"). Check every word in the DB name against
    //    Zoho's full name so "Asaraf" matches "Mohamed Asaraf".
    if (!zohoUser && member.name) {
      const dbWords = member.name.toLowerCase().split(/\s+/);
      const found   = zohoUsers.find(z => {
        const zohoFull = z.fullName.toLowerCase();
        return dbWords.some(w =>
          w.length >= 4 && ( // skip short words like "V", "K", "H", "S"
            z.firstName.toLowerCase() === w ||
            zohoFull.startsWith(w) ||
            zohoFull.includes(w)
          )
        );
      });
      if (found) { zohoUser = found; matchedBy = 'name'; }
    }

    if (!zohoUser) {
      zohoLog('WARN', 'No Zoho match', { name: member.name, email: member.email });
      return {
        memberId:      member.id,
        name:          member.name,
        email:         member.email,
        slackUserId:   member.slack_user_id,
        checkedIn:     false,
        isPresent:     false,
        presenceStatus: 'no_zoho_match',
        statusMessage: '',
        matchedBy:     'none',
        zohoEmail:     null,
        zohoName:      null,
        department:    null,
      };
    }

    return {
      memberId:      member.id,
      name:          member.name,
      email:         member.email,
      slackUserId:   member.slack_user_id,
      checkedIn:     zohoUser.isPresent,   // backward compat alias
      isPresent:     zohoUser.isPresent,
      presenceStatus: zohoUser.presenceStatus,
      statusMessage: zohoUser.statusMessage,
      matchedBy,
      zohoEmail:     zohoUser.email,
      zohoName:      zohoUser.fullName,
      department:    zohoUser.department || null,
    };
  });
}

// ─── Single-date attendance ───────────────────────────────────────────────────

async function getAttendance(employeeEmail, date) {
  if (!isConfigured()) return null;

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    zohoLog('ERROR', 'getAttendance: token refresh failed', { email: employeeEmail, error: err.message });
    return null;
  }

  const c       = getConfig();
  const dateStr = toDateStr(date);

  const endpoints = [
    {
      label:  'zohoapis',
      url:    `https://${c.apiHost}/people/api/attendance/getAttendance`,
      params: { empId: employeeEmail, startDate: dateStr, endDate: dateStr, dateFormat: 'yyyy-MM-dd' },
    },
    {
      label:  'people',
      url:    `https://${c.peopleHost}/people/api/attendance/getAttendance`,
      params: { empId: employeeEmail, startDate: dateStr, endDate: dateStr },
    },
  ];

  for (const ep of endpoints) {
    try {
      const response = await axios.get(ep.url, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  ep.params,
        timeout: 10_000,
      });
      const parsed = parseAttendanceResponse(response.data, `getAttendance:${ep.label}:${employeeEmail}`);
      if (parsed !== null) return parsed;
    } catch (err) {
      zohoLog('WARN', 'getAttendance endpoint failed', {
        endpoint: ep.label,
        email:    employeeEmail,
        status:   err.response?.status,
        error:    String(err.response?.data || err.message).substring(0, 200),
      });
      if (err.response?.status === 403) return null;
    }
  }

  return { checkedIn: false, checkInTime: null, checkOutTime: null, hoursWorked: null, status: 'No Record' };
}

// ─── Leave check ──────────────────────────────────────────────────────────────

async function isOnLeave(employeeEmail, date) {
  if (!isConfigured()) return { onLeave: false, leaveType: null, reason: null };
  const dateStr = toDateStr(date);

  let token;
  try {
    token = await getAccessToken();
  } catch {
    return { onLeave: false, leaveType: null, reason: null };
  }

  const c = getConfig();

  const endpoints = [
    `https://${c.apiHost}/people/api/leave/getLeavesByUser`,
    `https://${c.peopleHost}/people/api/leave/getLeavesByUser`,
  ];

  for (const url of endpoints) {
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  { empId: employeeEmail, startDate: dateStr, endDate: dateStr, status: 'approved' },
        timeout: 10_000,
      });
      const data    = response.data;
      const records = data?.response?.result || data?.result || data?.data || [];
      if (!Array.isArray(records) || records.length === 0) {
        return { onLeave: false, leaveType: null, reason: null };
      }
      const leave = records[0];
      return {
        onLeave:   true,
        leaveType: leave.leaveType || leave.Leave_Type || leave.type || 'Leave',
        reason:    leave.reason    || leave.Reason     || null,
      };
    } catch (err) {
      zohoLog('WARN', 'isOnLeave endpoint failed', {
        url, email: employeeEmail, status: err.response?.status,
      });
    }
  }

  return { onLeave: false, leaveType: null, reason: null };
}

// ─── Absent members ───────────────────────────────────────────────────────────

async function getAbsentMembers(date) {
  if (!isConfigured()) return [];
  const dateStr = toDateStr(date);

  let token;
  try {
    token = await getAccessToken();
  } catch {
    return [];
  }

  const c = getConfig();

  for (const host of [c.apiHost, c.peopleHost]) {
    try {
      const response = await axios.get(
        `https://${host}/people/api/attendance/getAbsence`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params:  { date: dateStr },
          timeout: 10_000,
        }
      );
      const data    = response.data;
      const records = data?.response?.result || data?.result || data?.data || [];
      if (!Array.isArray(records)) return [];
      return records.map((r) => r.email || r.Email || r.empId || r.empEmail).filter(Boolean);
    } catch (err) {
      zohoLog('WARN', 'getAbsentMembers failed', { host, status: err.response?.status });
    }
  }

  return [];
}

// ─── Late check-in ────────────────────────────────────────────────────────────

async function getCheckInTime(employeeEmail, date) {
  const att = await getAttendance(employeeEmail, date);
  return att?.checkInTime || null;
}

async function isLateCheckIn(employeeEmail, date, expectedTime) {
  if (!isConfigured()) return { late: false, minutesLate: 0 };
  const att = await getAttendance(employeeEmail, date);
  if (!att?.checkedIn || !att.checkInTime) return { late: false, minutesLate: 0 };

  const expected = timeToMinutes(expectedTime || process.env.WORK_START_TIME || '09:00');
  const actual   = timeToMinutes(att.checkInTime);
  if (expected === null || actual === null) return { late: false, minutesLate: 0 };

  const diff = actual - expected;
  return { late: diff > 0, minutesLate: Math.max(0, diff) };
}

// ─── Team attendance ──────────────────────────────────────────────────────────

async function getTeamAttendance(members, date) {
  if (!isConfigured()) return [];
  const dateStr = toDateStr(date);
  const results = await Promise.all(
    members
      .filter((m) => m.email || m.email_address)
      .map(async (m) => {
        const email = m.email || m.email_address;
        const [attendance, leaveStatus] = await Promise.all([
          getAttendance(email, dateStr).catch(() => null),
          isOnLeave(email, dateStr).catch(() => ({ onLeave: false })),
        ]);
        return { member: m, attendance, onLeave: leaveStatus };
      })
  );
  return results;
}

// ─── Connection test ──────────────────────────────────────────────────────────

async function testConnection() {
  if (!isConfigured()) throw new Error('Zoho credentials not configured');
  await getAccessToken();
  return true;
}

/**
 * Directly inject a new access token into the in-memory cache.
 * Called by the OAuth route after a successful token exchange so the
 * new token is used immediately without a server restart.
 */
function _setTokenCache(token, expiresAt) {
  _token       = token;
  _tokenExpiry = expiresAt;
  zohoLog('INFO', 'Token cache updated via OAuth exchange');
}

module.exports = {
  isConfigured,
  getAccessToken,
  getAllUsersWithPresence,
  getAllTodayAttendance,
  getAttendance,
  isOnLeave,
  getAbsentMembers,
  getCheckInTime,
  isLateCheckIn,
  getTeamAttendance,
  testConnection,
  _setTokenCache,
};
