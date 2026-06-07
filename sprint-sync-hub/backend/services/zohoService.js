'use strict';

/**
 * Zoho People service — OAuth 2.0 token management + attendance/leave API.
 *
 * Required env vars (or DB config keys):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
 *   ZOHO_ORG_IDENTIFIER — company slug used in People API URLs (e.g. "marmafintech")
 *   ZOHO_DOMAIN         — one of: zoho.in | zoho.com | zoho.eu  (default: zoho.in)
 *
 * OAuth token endpoint:  https://accounts.{ZOHO_DOMAIN}/oauth/v2/token
 * People API endpoint:   https://www.zohoapis.{tld}/people/api/...
 *   where tld is extracted from ZOHO_DOMAIN (e.g. zoho.in → .in, zoho.com → .com)
 *
 * All API functions return null / empty array if Zoho is not configured, so the
 * rest of the app degrades gracefully when the integration is disabled.
 */

const https = require('https');

// ─── Token cache ──────────────────────────────────────────────────────────────
let _accessToken     = null;
let _tokenExpiry     = 0;   // unix ms

// ─── Config helpers ───────────────────────────────────────────────────────────

function getConfig() {
  const domain = process.env.ZOHO_DOMAIN || 'zoho.in';
  // Derive the zohoapis hostname from the domain.
  // zoho.in  → www.zohoapis.in
  // zoho.com → www.zohoapis.com
  // zoho.eu  → www.zohoapis.eu
  const tld        = domain.includes('.') ? domain.substring(domain.indexOf('.')) : '.in'; // e.g. ".in"
  const apiHost    = `www.zohoapis${tld}`;

  return {
    clientId:      process.env.ZOHO_CLIENT_ID      || '',
    clientSecret:  process.env.ZOHO_CLIENT_SECRET  || '',
    refreshToken:  process.env.ZOHO_REFRESH_TOKEN  || '',
    orgIdentifier: process.env.ZOHO_ORG_IDENTIFIER || '',
    domain,
    apiHost,  // e.g. "www.zohoapis.in"
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.clientId && c.clientSecret && c.refreshToken);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Returns a valid access token, refreshing if expired.
 * Tokens last 1 hour; we refresh 2 minutes early.
 */
async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const c = getConfig();
  if (!isConfigured()) throw new Error('Zoho not configured — set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN');

  const result = await httpsPost(
    `accounts.${c.domain}`,
    '/oauth/v2/token',
    {
      grant_type:    'refresh_token',
      client_id:     c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
    }
  );

  if (!result.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(result)}`);
  }

  _accessToken = result.access_token;
  _tokenExpiry = Date.now() + (parseInt(result.expires_in || '3600', 10) - 120) * 1000;
  console.log('[zohoService] Access token refreshed');
  return _accessToken;
}

// ─── API wrapper ──────────────────────────────────────────────────────────────

async function zohoGet(path) {
  const token = await getAccessToken();
  const c = getConfig();
  // Use www.zohoapis.{tld} as the API host (India: www.zohoapis.in)
  return httpsGet(c.apiHost, path, token);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toDateStr(d) {
  if (!d) return new Date().toISOString().split('T')[0];
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().split('T')[0];
}

/** Parse HH:MM time string to minutes since midnight */
function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':');
  if (parts.length < 2) return null;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a single member's attendance for a given date.
 * @returns {{ checkedIn: boolean, checkInTime: string|null, checkOutTime: string|null, hoursWorked: number|null, status: string }}
 */
async function getAttendance(employeeEmail, date) {
  if (!isConfigured()) return null;
  const dateStr = toDateStr(date);
  try {
    const data = await zohoGet(
      `/people/api/attendance/getAttendance?empId=${encodeURIComponent(employeeEmail)}&startDate=${dateStr}&endDate=${dateStr}`
    );
    const record = data?.response?.result?.[0] || data?.result?.[0] || null;
    if (!record) return { checkedIn: false, checkInTime: null, checkOutTime: null, hoursWorked: null, status: 'Absent' };

    const checkIn  = record.checkIn  || record.Check_In  || null;
    const checkOut = record.checkOut || record.Check_Out || null;
    const hours    = record.hoursWorked || record.Hours_Worked || null;
    const status   = record.status   || record.Status    || (checkIn ? 'Present' : 'Absent');

    return {
      checkedIn:    !!checkIn,
      checkInTime:  checkIn  ? String(checkIn).substring(0, 5)  : null,
      checkOutTime: checkOut ? String(checkOut).substring(0, 5) : null,
      hoursWorked:  hours    ? parseFloat(hours) : null,
      status:       String(status),
    };
  } catch (err) {
    console.warn('[zohoService.getAttendance]', err.message);
    return null;
  }
}

/**
 * Check if a member is on approved leave for a given date.
 * @returns {{ onLeave: boolean, leaveType: string|null, reason: string|null }}
 */
async function isOnLeave(employeeEmail, date) {
  if (!isConfigured()) return { onLeave: false, leaveType: null, reason: null };
  const dateStr = toDateStr(date);
  try {
    const data = await zohoGet(
      `/people/api/leave/getLeavesByUser?empId=${encodeURIComponent(employeeEmail)}&startDate=${dateStr}&endDate=${dateStr}&status=approved`
    );

    // Normalise across API response shapes
    const records = data?.response?.result || data?.result || [];
    if (!Array.isArray(records) || records.length === 0) {
      return { onLeave: false, leaveType: null, reason: null };
    }

    const leave = records[0];
    return {
      onLeave:   true,
      leaveType: leave.leaveType  || leave.Leave_Type  || leave.type || 'Leave',
      reason:    leave.reason     || leave.Reason       || null,
    };
  } catch (err) {
    console.warn('[zohoService.isOnLeave]', err.message);
    return { onLeave: false, leaveType: null, reason: null };
  }
}

/**
 * Returns array of employee emails with no check-in for a given date.
 */
async function getAbsentMembers(date) {
  if (!isConfigured()) return [];
  const dateStr = toDateStr(date);
  try {
    const data = await zohoGet(
      `/people/api/attendance/getAbsence?date=${dateStr}`
    );
    const records = data?.response?.result || data?.result || [];
    if (!Array.isArray(records)) return [];
    return records.map((r) => r.email || r.Email || r.empId || r.empEmail).filter(Boolean);
  } catch (err) {
    console.warn('[zohoService.getAbsentMembers]', err.message);
    return [];
  }
}

/**
 * Returns check-in time string (HH:MM) or null if member didn't check in.
 */
async function getCheckInTime(employeeEmail, date) {
  const att = await getAttendance(employeeEmail, date);
  return att?.checkInTime || null;
}

/**
 * Returns { late: boolean, minutesLate: number }
 * @param {string} expectedTime  — "HH:MM"
 */
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

/**
 * Get attendance for all team members for a given date.
 * @param {Array<{id, name, email}>} members
 * @returns {Array<{ member, attendance, onLeave }>}
 */
async function getTeamAttendance(members, date) {
  if (!isConfigured()) return [];
  const dateStr = toDateStr(date);
  const results = await Promise.all(
    members
      .filter((m) => m.email)
      .map(async (m) => {
        const [attendance, leaveStatus] = await Promise.all([
          getAttendance(m.email, dateStr).catch(() => null),
          isOnLeave(m.email, dateStr).catch(() => ({ onLeave: false })),
        ]);
        return { member: m, attendance, onLeave: leaveStatus };
      })
  );
  return results;
}

/**
 * Get today's attendance record for a single employee.
 * Convenience wrapper over getAttendance() that always uses today's date
 * and also surfaces a normalised `checkedOut` boolean field.
 *
 * @param {string} employeeEmail - Employee's email address
 * @returns {Promise<{
 *   checkedIn: boolean,
 *   checkInTime: string|null,
 *   checkedOut: boolean,
 *   checkOutTime: string|null,
 *   hoursWorked: number|null,
 *   status: string
 * }>}
 */
async function getTodayAttendance(employeeEmail) {
  const defaultResult = {
    checkedIn: false, checkInTime: null,
    checkedOut: false, checkOutTime: null,
    hoursWorked: null, status: 'No Record',
  };
  if (!isConfigured()) return defaultResult;
  try {
    const today = toDateStr(new Date());
    const data  = await zohoGet(
      `/people/api/attendance/getAttendance?empId=${encodeURIComponent(employeeEmail)}&startDate=${today}&endDate=${today}`
    );

    const record = data?.response?.result?.[0] || data?.result?.[0] || null;
    if (!record) return defaultResult;

    const checkIn  = record.checkIn  || record.Check_In  || null;
    const checkOut = record.checkOut || record.Check_Out || null;
    const hours    = record.hoursWorked || record.Hours_Worked || null;
    const status   = record.status   || record.Status    || (checkIn ? 'Present' : 'Absent');

    return {
      checkedIn:    !!checkIn,
      checkInTime:  checkIn  ? String(checkIn).substring(0, 5)  : null,
      checkedOut:   !!checkOut,
      checkOutTime: checkOut ? String(checkOut).substring(0, 5) : null,
      hoursWorked:  hours    ? parseFloat(hours) : null,
      status:       String(status),
    };
  } catch (err) {
    console.warn('[zohoService.getTodayAttendance]', err.message);
    return defaultResult;
  }
}

/**
 * Get today's attendance for ALL configured team members in parallel.
 * Reads TEAM_MEMBERS from the process.env JSON array.
 * Used by the checkout-detection cron job.
 *
 * @returns {Promise<Array<{
 *   email: string,
 *   slackUserId: string,
 *   name: string,
 *   checkedIn: boolean,
 *   checkInTime: string|null,
 *   checkedOut: boolean,
 *   checkOutTime: string|null,
 *   hoursWorked: number|null,
 *   status: string
 * }>>}
 */
async function getAllTodayAttendance() {
  if (!isConfigured()) return [];

  const raw = process.env.TEAM_MEMBERS || '';
  if (!raw.trim()) {
    console.warn('[zohoService.getAllTodayAttendance] TEAM_MEMBERS env var is not set');
    return [];
  }

  let teamMembers = [];
  try {
    const parsed = JSON.parse(raw);
    teamMembers = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[zohoService.getAllTodayAttendance] Failed to parse TEAM_MEMBERS:', err.message);
    return [];
  }

  // Only process members that have an email address for Zoho lookup
  const membersWithEmail = teamMembers.filter((m) => m.email);
  if (membersWithEmail.length === 0) {
    console.warn('[zohoService.getAllTodayAttendance] No team members have an email address configured');
    return [];
  }

  const results = await Promise.all(
    membersWithEmail.map(async (m) => {
      const att = await getTodayAttendance(m.email);
      return {
        email:        m.email,
        slackUserId:  m.id,
        name:         m.name,
        checkedIn:    att.checkedIn,
        checkInTime:  att.checkInTime,
        checkedOut:   att.checkedOut,
        checkOutTime: att.checkOutTime,
        hoursWorked:  att.hoursWorked,
        status:       att.status,
      };
    })
  );

  return results;
}

/**
 * Test that the Zoho integration works — used by /api/config/health.
 * Returns true or throws.
 */
async function testConnection() {
  if (!isConfigured()) throw new Error('Zoho credentials not configured');
  await getAccessToken();
  return true;
}

module.exports = {
  isConfigured,
  getAccessToken,
  getAttendance,
  isOnLeave,
  getAbsentMembers,
  getCheckInTime,
  isLateCheckIn,
  getTeamAttendance,
  getTodayAttendance,
  getAllTodayAttendance,
  testConnection,
};
