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

// ─── Token cache ──────────────────────────────────────────────────────────────

let cachedToken   = null;
let tokenExpiresAt = null;

/**
 * Returns a valid OAuth access token, refreshing via the refresh_token grant if expired.
 * Token is cached for (expires_in - 5 minutes) to avoid redundant refreshes.
 */
async function getAccessToken() {
  // Return cached token if still valid with a 5-minute safety buffer
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 300_000) {
    return cachedToken;
  }

  const c = getConfig();
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    throw new Error('Zoho credentials missing — check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in .env');
  }

  try {
    // Zoho requires params as query string on the POST URL (not in request body)
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

    cachedToken    = response.data.access_token;
    tokenExpiresAt = Date.now() + (parseInt(response.data.expires_in || '3600', 10)) * 1_000;

    zohoLog('INFO', 'Token refreshed', {
      expiresIn:   response.data.expires_in,
      tokenPrefix: cachedToken.substring(0, 15),
    });

    return cachedToken;
  } catch (err) {
    // Invalidate cache on failure
    cachedToken    = null;
    tokenExpiresAt = null;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    zohoLog('ERROR', 'Token refresh failed', { detail });
    throw new Error(`Zoho token refresh failed: ${detail}`);
  }
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

// ─── Core API function ────────────────────────────────────────────────────────

/**
 * Fetch today's attendance for a single employee.
 * Tries multiple endpoint variants until one succeeds.
 * Never throws — returns a safe default on any failure.
 */
async function getTodayAttendance(employeeEmail) {
  const defaultResult = {
    checkedIn: false, checkInTime: null,
    checkedOut: false, checkOutTime: null,
    hoursWorked: null, status: 'No Record',
  };

  if (!employeeEmail) {
    zohoLog('WARN', 'getTodayAttendance called with no email');
    return defaultResult;
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    zohoLog('ERROR', 'getTodayAttendance: token refresh failed', { email: employeeEmail, error: err.message });
    return defaultResult;
  }

  const c     = getConfig();
  const today = getTodayDateString();

  const endpoints = [
    // Primary: zohoapis.in (the account's stated API domain)
    {
      label:  'zohoapis',
      url:    `https://${c.apiHost}/people/api/attendance/getAttendance`,
      params: { empId: employeeEmail, startDate: today, endDate: today, dateFormat: 'yyyy-MM-dd' },
    },
    // Fallback 1: people.zoho.in with dateFormat
    {
      label:  'people-with-fmt',
      url:    `https://${c.peopleHost}/people/api/attendance/getAttendance`,
      params: { empId: employeeEmail, startDate: today, endDate: today, dateFormat: 'yyyy-MM-dd' },
    },
    // Fallback 2: people.zoho.in without dateFormat
    {
      label:  'people-no-fmt',
      url:    `https://${c.peopleHost}/people/api/attendance/getAttendance`,
      params: { empId: employeeEmail, startDate: today, endDate: today },
    },
  ];

  for (const ep of endpoints) {
    try {
      const response = await axios.get(ep.url, {
        headers: {
          Authorization:  `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
        },
        params:  ep.params,
        timeout: 10_000,
      });

      const parsed = parseAttendanceResponse(response.data, `${ep.label}:${employeeEmail}`);
      if (parsed !== null) {
        zohoLog('INFO', 'Attendance fetched', {
          endpoint:  ep.label,
          email:     employeeEmail,
          checkedIn: parsed.checkedIn,
          status:    parsed.status,
        });
        return parsed;
      }
      // parsed null = shape unrecognised, try next endpoint

    } catch (err) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data || err.message);
      zohoLog('WARN', 'Endpoint failed', { endpoint: ep.label, email: employeeEmail, status, detail: detail.substring(0, 200) });

      if (status === 401) {
        // Token expired — invalidate cache and try to refresh once
        cachedToken = null;
        try { token = await getAccessToken(); } catch (_) {}
      }
      if (status === 403) {
        zohoLog('ERROR', '403 Forbidden — check API scopes in Zoho developer console', { email: employeeEmail });
        return defaultResult; // No point trying more endpoints
      }
    }
  }

  zohoLog('WARN', 'All attendance endpoints failed', { email: employeeEmail, date: today });
  return defaultResult;
}

/**
 * Get today's attendance for ALL active team members.
 * Reads members from the database (preferred) so emails are always current.
 * Processes 3 members in parallel with 300 ms gaps between batches.
 */
async function getAllTodayAttendance() {
  if (!isConfigured()) {
    zohoLog('WARN', 'getAllTodayAttendance skipped — Zoho not configured');
    return [];
  }

  // Read members from DB — this has emails; TEAM_MEMBERS env var does NOT
  let teamMembers = [];
  try {
    const { query } = require('../db');
    const result = await query(
      `SELECT id, name, email, slack_user_id
       FROM members
       WHERE is_active = true
       ORDER BY name`
    );
    teamMembers = result.rows;
    zohoLog('INFO', 'Loading attendance for members from DB', { count: teamMembers.length });
  } catch (dbErr) {
    zohoLog('ERROR', 'Cannot read members from DB', { error: dbErr.message });
    return [];
  }

  if (teamMembers.length === 0) {
    zohoLog('WARN', 'No active members found in DB');
    return [];
  }

  const results    = [];
  const BATCH_SIZE = 3;

  for (let i = 0; i < teamMembers.length; i += BATCH_SIZE) {
    const batch       = teamMembers.slice(i, i + BATCH_SIZE);
    const batchResult = await Promise.all(
      batch.map(async (member) => {
        if (!member.email) {
          zohoLog('WARN', 'Member has no email — skipping attendance lookup', { name: member.name });
          return {
            memberId:     member.id,
            name:         member.name,
            email:        null,
            slackUserId:  member.slack_user_id,
            checkedIn:    false,
            checkInTime:  null,
            checkedOut:   false,
            checkOutTime: null,
            hoursWorked:  null,
            status:       'No Email',
          };
        }

        const att = await getTodayAttendance(member.email);
        return {
          memberId:     member.id,
          name:         member.name,
          email:        member.email,
          slackUserId:  member.slack_user_id,
          ...att,
        };
      })
    );
    results.push(...batchResult);

    // Pause between batches to respect Zoho rate limits
    if (i + BATCH_SIZE < teamMembers.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const checkedInCount = results.filter((m) => m.checkedIn).length;
  zohoLog('INFO', 'Team attendance loaded', {
    total:      results.length,
    checkedIn:  checkedInCount,
    noEmail:    results.filter((m) => m.status === 'No Email').length,
  });

  return results;
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

module.exports = {
  isConfigured,
  getAccessToken,
  getAttendance,
  getTodayAttendance,
  getAllTodayAttendance,
  isOnLeave,
  getAbsentMembers,
  getCheckInTime,
  isLateCheckIn,
  getTeamAttendance,
  testConnection,
};
