'use strict';

/**
 * Debug routes — diagnostic tools for the Zoho integration.
 * Mounted at /api/debug in server.js ONLY in non-production environments.
 *
 * GET /api/debug/zoho   — runs all 8 checks and returns a full diagnostic report
 */

const express = require('express');
const router  = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function analyseResponseStructure(data) {
  if (Array.isArray(data)) {
    return {
      type:          'array',
      length:        data.length,
      firstItemKeys: data.length > 0 ? Object.keys(data[0]) : [],
      firstItem:     data.length > 0 ? JSON.stringify(data[0]).substring(0, 400) : null,
    };
  }
  if (typeof data === 'object' && data !== null) {
    return {
      type:         'object',
      topLevelKeys: Object.keys(data),
      responseKey:  data.response ? Object.keys(data.response) : null,
      hasErrors:    !!(data.response?.errors || data.errors),
      errorDetails: data.response?.errors || data.errors || null,
      sample:       JSON.stringify(data).substring(0, 600),
    };
  }
  return { type: typeof data, value: String(data).substring(0, 200) };
}

// ─── GET /api/debug/zoho ──────────────────────────────────────────────────────

router.get('/zoho', async (req, res) => {
  const report = {
    timestamp: new Date().toISOString(),
    checks:    [],
  };

  function addCheck(name, status, data, error) {
    report.checks.push({ name, status, data: data || null, error: error || null });
    const line = `[ZOHO DEBUG] ${name}: ${status}${error ? ' — ' + error : ''}`;
    if (status === 'FAIL' || status === 'ERROR') console.error(line);
    else console.log(line);
  }

  // ── CHECK 1: Environment variables ──────────────────────────────────────────
  try {
    const envCheck = {
      ZOHO_CLIENT_ID:     !!process.env.ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: !!process.env.ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: !!process.env.ZOHO_REFRESH_TOKEN,
      ZOHO_ORG_IDENTIFIER: process.env.ZOHO_ORG_IDENTIFIER || null,
      ZOHO_DOMAIN:        process.env.ZOHO_DOMAIN || 'zoho.in (default)',
      clientIdPrefix:     process.env.ZOHO_CLIENT_ID?.substring(0, 10) || 'MISSING',
      refreshTokenPrefix: process.env.ZOHO_REFRESH_TOKEN?.substring(0, 12) || 'MISSING',
    };
    const allPresent = envCheck.ZOHO_CLIENT_ID && envCheck.ZOHO_CLIENT_SECRET && envCheck.ZOHO_REFRESH_TOKEN;
    addCheck(
      'Environment Variables',
      allPresent ? 'PASS' : 'FAIL',
      envCheck,
      allPresent ? null : 'One or more Zoho env vars are missing'
    );
  } catch (err) {
    addCheck('Environment Variables', 'ERROR', null, err.message);
  }

  // ── CHECK 2: Token refresh ───────────────────────────────────────────────────
  let accessToken = null;
  try {
    const axios = require('axios');
    const tokenResponse = await axios.post(
      'https://accounts.zoho.in/oauth/v2/token',
      null,
      {
        params: {
          refresh_token: process.env.ZOHO_REFRESH_TOKEN,
          client_id:     process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          grant_type:    'refresh_token',
        },
        timeout: 12000,
      }
    );
    accessToken = tokenResponse.data.access_token;
    addCheck('Token Refresh', accessToken ? 'PASS' : 'FAIL', {
      hasAccessToken: !!accessToken,
      tokenType:      tokenResponse.data.token_type,
      expiresIn:      tokenResponse.data.expires_in,
      tokenPrefix:    accessToken?.substring(0, 15) || null,
    }, accessToken ? null : `Token response: ${JSON.stringify(tokenResponse.data)}`);
  } catch (err) {
    addCheck('Token Refresh', 'FAIL', null,
      `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data) || err.message}`
    );
  }

  if (!accessToken) {
    report.conclusion = 'BLOCKED AT TOKEN REFRESH — fix credentials first';
    return res.json(report);
  }

  const axios  = require('axios');
  const today  = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const domain = process.env.ZOHO_DOMAIN || 'zoho.in';
  const tld    = domain.includes('.') ? domain.substring(domain.indexOf('.')) : '.in';

  // ── CHECK 3: Raw attendance API call — try all known endpoint variants ───────
  let rawAttendanceData = null;
  const endpointVariants = [
    {
      label:  'zohoapis.in/people/api/attendance/getAttendance',
      url:    `https://www.zohoapis${tld}/people/api/attendance/getAttendance`,
      params: { startDate: today, endDate: today, dateFormat: 'yyyy-MM-dd' },
    },
    {
      label:  'people.zoho.in/people/api/attendance/getAttendance',
      url:    `https://people.zoho${tld}/people/api/attendance/getAttendance`,
      params: { startDate: today, endDate: today, dateFormat: 'yyyy-MM-dd' },
    },
    {
      label:  'people.zoho.in (no dateFormat param)',
      url:    `https://people.zoho${tld}/people/api/attendance/getAttendance`,
      params: { startDate: today, endDate: today },
    },
  ];

  for (const variant of endpointVariants) {
    try {
      const response = await axios.get(variant.url, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params:  variant.params,
        timeout: 10000,
      });
      rawAttendanceData = response.data;
      addCheck(`Attendance API: ${variant.label}`, 'PASS', {
        status:       response.status,
        structure:    analyseResponseStructure(response.data),
      });
      break; // stop on first success
    } catch (err) {
      addCheck(`Attendance API: ${variant.label}`, 'FAIL', null,
        `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data || err.message).substring(0, 300)}`
      );
    }
  }

  // ── CHECK 4: Response structure analysis ─────────────────────────────────────
  if (rawAttendanceData) {
    addCheck('Response Structure', 'INFO', analyseResponseStructure(rawAttendanceData));
  }

  // ── CHECK 5: Single member attendance fetch ──────────────────────────────────
  try {
    const { query } = require('../db');
    const memberResult = await query(
      'SELECT id, name, email FROM members WHERE email IS NOT NULL AND is_active = true LIMIT 1'
    );

    if (memberResult.rows.length === 0) {
      addCheck('Single Member Fetch', 'WARN', null, 'No members with email in DB — run POST /api/members/fetch-slack-emails');
    } else {
      const member = memberResult.rows[0];
      addCheck('Database Member', 'INFO', {
        id:       member.id,
        name:     member.name,
        hasEmail: true,
        email:    member.email.replace(/(.{2}).*(@.*)/, '$1***$2'),
      });

      // Try fetching for this specific member
      const singleVariants = [
        {
          label:  'zohoapis.in with empId=email',
          url:    `https://www.zohoapis${tld}/people/api/attendance/getAttendance`,
          params: { empId: member.email, startDate: today, endDate: today, dateFormat: 'yyyy-MM-dd' },
        },
        {
          label:  'people.zoho.in with empId=email',
          url:    `https://people.zoho${tld}/people/api/attendance/getAttendance`,
          params: { empId: member.email, startDate: today, endDate: today },
        },
      ];

      for (const v of singleVariants) {
        try {
          const resp = await axios.get(v.url, {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
            params:  v.params,
            timeout: 10000,
          });
          addCheck(`Single Member (${v.label})`, 'PASS', {
            memberName:   member.name,
            httpStatus:   resp.status,
            structure:    analyseResponseStructure(resp.data),
            rawSample:    JSON.stringify(resp.data).substring(0, 500),
          });
          break;
        } catch (err) {
          addCheck(`Single Member (${v.label})`, 'FAIL', null,
            `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data || err.message).substring(0, 300)}`
          );
        }
      }
    }
  } catch (err) {
    addCheck('Single Member Fetch', 'ERROR', null, err.message);
  }

  // ── CHECK 6: zohoService.getTodayAttendance() ────────────────────────────────
  try {
    const zohoService = require('../services/zohoService');
    const { query }   = require('../db');
    const memberResult = await query(
      'SELECT email, name FROM members WHERE email IS NOT NULL AND is_active = true LIMIT 1'
    );
    if (memberResult.rows.length > 0) {
      const m      = memberResult.rows[0];
      const result = await zohoService.getTodayAttendance(m.email);
      addCheck('zohoService.getTodayAttendance', 'PASS', { member: m.name, result });
    } else {
      addCheck('zohoService.getTodayAttendance', 'SKIP', null, 'No member email to test with');
    }
  } catch (err) {
    addCheck('zohoService.getTodayAttendance', 'ERROR', null, err.message);
  }

  // ── CHECK 7: zohoService.getAllTodayAttendance() ──────────────────────────────
  try {
    const zohoService = require('../services/zohoService');
    const result      = await zohoService.getAllTodayAttendance();
    const checkedIn   = result.filter((m) => m.checkedIn);
    addCheck('zohoService.getAllTodayAttendance', result.length > 0 ? 'PASS' : 'WARN', {
      totalMembers:   result.length,
      checkedInCount: checkedIn.length,
      noEmailCount:   result.filter((m) => m.status === 'No Email').length,
      sample:         result[0] || null,
    }, result.length === 0 ? 'Empty array returned — see earlier checks' : null);
  } catch (err) {
    addCheck('zohoService.getAllTodayAttendance', 'ERROR', null, err.message);
  }

  // ── CHECK 8: DB daily stats for today ─────────────────────────────────────────
  try {
    const { query } = require('../db');
    const statsResult = await query(
      `SELECT
         COUNT(*)                                                   AS total_rows,
         SUM(CASE WHEN checked_in = true THEN 1 ELSE 0 END)        AS checked_in_count,
         COUNT(DISTINCT member_id)                                  AS distinct_members
       FROM member_daily_stats
       WHERE stat_date = CURRENT_DATE`
    );
    const row = statsResult.rows[0];
    addCheck('DB Daily Stats (today)', 'INFO', {
      totalRows:       parseInt(row.total_rows || 0),
      checkedInCount:  parseInt(row.checked_in_count || 0),
      distinctMembers: parseInt(row.distinct_members || 0),
      note: parseInt(row.total_rows || 0) === 0
        ? 'No rows for today — cron has not written stats yet. Attendance is fetched live from Zoho.'
        : 'DB has stats for today',
    });

    const memberResult = await query(
      `SELECT COUNT(*) AS total, COUNT(email) AS with_email
       FROM members WHERE is_active = true`
    );
    const mRow = memberResult.rows[0];
    addCheck('DB Members', 'INFO', {
      total:     parseInt(mRow.total),
      withEmail: parseInt(mRow.with_email),
      noEmail:   parseInt(mRow.total) - parseInt(mRow.with_email),
    }, parseInt(mRow.with_email) === 0 ? 'No members have emails — Zoho lookups will all fail' : null);
  } catch (err) {
    addCheck('DB Daily Stats', 'ERROR', null, err.message);
  }

  // ── Conclusion ────────────────────────────────────────────────────────────────
  const failed  = report.checks.filter((c) => c.status === 'FAIL' || c.status === 'ERROR');
  const warned  = report.checks.filter((c) => c.status === 'WARN');
  report.conclusion = failed.length > 0
    ? `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}`
    : warned.length > 0
    ? `All checks passed with ${warned.length} warning(s): ${warned.map((c) => c.name).join(', ')}`
    : 'All checks passed — integration appears healthy';

  return res.json(report);
});

// ─── GET /api/debug/zoho/raw?email=xxx ────────────────────────────────────────
// Returns the raw Zoho API response for a single member using all date format variants.
// Useful for diagnosing response shape without restarting the server.

router.get('/zoho/raw', async (req, res) => {
  const email = req.query.email || null;
  if (!email) {
    // Default to first member with email
    try {
      const { query } = require('../db');
      const r = await query('SELECT email, name FROM members WHERE email IS NOT NULL LIMIT 1');
      if (!r.rows.length) return res.status(400).json({ error: 'No email provided and no members with email in DB' });
      return res.redirect(`/api/debug/zoho/raw?email=${encodeURIComponent(r.rows[0].email)}`);
    } catch (e) {
      return res.status(400).json({ error: 'Provide ?email=someone@company.com' });
    }
  }

  let token;
  try {
    const zohoService = require('../services/zohoService');
    token = await zohoService.getAccessToken();
  } catch (err) {
    return res.status(500).json({ error: `Token refresh failed: ${err.message}` });
  }

  const axios   = require('axios');
  const domain  = process.env.ZOHO_DOMAIN || 'zoho.in';
  const tld     = domain.includes('.') ? domain.substring(domain.indexOf('.')) : '.in';
  const today   = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const parts        = today.split('-');
  const dateMMDDYYYY = `${parts[1]}-${parts[2]}-${parts[0]}`;
  const dateDDMMYYYY = `${parts[2]}-${parts[1]}-${parts[0]}`;

  const results = [];
  const variants = [
    { label: 'zohoapis.in YYYY-MM-DD', url: `https://www.zohoapis${tld}/people/api/attendance/getAttendance`, params: { empId: email, startDate: today,        endDate: today,        dateFormat: 'yyyy-MM-dd' } },
    { label: 'people.zoho.in YYYY-MM-DD', url: `https://people.${domain}/people/api/attendance/getAttendance`, params: { empId: email, startDate: today,        endDate: today,        dateFormat: 'yyyy-MM-dd' } },
    { label: 'people.zoho.in MM-DD-YYYY', url: `https://people.${domain}/people/api/attendance/getAttendance`, params: { empId: email, startDate: dateMMDDYYYY, endDate: dateMMDDYYYY } },
    { label: 'people.zoho.in DD-MM-YYYY', url: `https://people.${domain}/people/api/attendance/getAttendance`, params: { empId: email, startDate: dateDDMMYYYY, endDate: dateDDMMYYYY } },
    { label: 'zohoapis.in no-fmt',        url: `https://www.zohoapis${tld}/people/api/attendance/getAttendance`, params: { empId: email, startDate: today,        endDate: today } },
  ];

  for (const v of variants) {
    try {
      const r = await axios.get(v.url, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  v.params,
        timeout: 10_000,
      });
      results.push({ label: v.label, params: v.params, status: r.status, data: r.data });
    } catch (err) {
      results.push({
        label:  v.label,
        params: v.params,
        status: err.response?.status || 'network_error',
        data:   err.response?.data || err.message,
      });
    }
  }

  return res.json({ email, today, results });
});

module.exports = router;
