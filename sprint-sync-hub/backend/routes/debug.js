'use strict';

/**
 * Debug routes — diagnostic tools for the Zoho integration.
 * Mounted at /api/debug in server.js ONLY in non-production environments.
 *
 * GET /api/debug/zoho — runs checks against the sources actually in use
 * (token refresh, Zoho Chat presence, webhook-derived DB data). The old
 * Zoho People Attendance REST API probing was removed — every endpoint
 * variant returned error 7201 (module disabled) on this account.
 */

const express = require('express');
const router  = express.Router();

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
  const envCheck = {
    ZOHO_CLIENT_ID:      !!process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET:  !!process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN:  !!process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_ORG_IDENTIFIER: process.env.ZOHO_ORG_IDENTIFIER || null,
    ZOHO_DOMAIN:         process.env.ZOHO_DOMAIN || 'zoho.in (default)',
  };
  const allPresent = envCheck.ZOHO_CLIENT_ID && envCheck.ZOHO_CLIENT_SECRET && envCheck.ZOHO_REFRESH_TOKEN;
  addCheck('Environment Variables', allPresent ? 'PASS' : 'FAIL', envCheck,
    allPresent ? null : 'One or more Zoho env vars are missing');

  if (!allPresent) {
    report.conclusion = 'BLOCKED — Zoho credentials missing, fix env vars first';
    return res.json(report);
  }

  const zohoService = require('../services/zohoService');

  // ── CHECK 2: Token refresh ───────────────────────────────────────────────────
  try {
    const token = await zohoService.getAccessToken();
    addCheck('Token Refresh', token ? 'PASS' : 'FAIL', { hasAccessToken: !!token, tokenPrefix: token?.substring(0, 15) || null });
  } catch (err) {
    addCheck('Token Refresh', 'FAIL', null, err.message);
    report.conclusion = 'BLOCKED AT TOKEN REFRESH — fix credentials first';
    return res.json(report);
  }

  // ── CHECK 3: Zoho Chat presence (/_chat/v2/users) ─────────────────────────────
  try {
    const users   = await zohoService.getAllUsersWithPresence();
    const present = users.filter((u) => u.isPresent);
    addCheck('Presence API (/_chat/v2/users)', 'PASS', {
      totalUsers:   users.length,
      presentCount: present.length,
      sample:       users[0] || null,
    });
  } catch (err) {
    addCheck('Presence API (/_chat/v2/users)', 'ERROR', null, err.message);
  }

  // ── CHECK 4: getAllTodayAttendance() — matches DB members to Zoho presence ────
  try {
    const result    = await zohoService.getAllTodayAttendance();
    const checkedIn = result.filter((m) => m.checkedIn);
    const noMatch   = result.filter((m) => m.matchedBy === 'none');
    addCheck('getAllTodayAttendance', result.length > 0 ? 'PASS' : 'WARN', {
      totalMembers: result.length,
      checkedIn:    checkedIn.length,
      noZohoMatch:  noMatch.map((m) => ({ name: m.name, email: m.email })),
    }, result.length === 0 ? 'No active members in DB' : null);
  } catch (err) {
    addCheck('getAllTodayAttendance', 'ERROR', null, err.message);
  }

  // ── CHECK 5: Webhook-derived attendance rows for today ────────────────────────
  try {
    const { query } = require('../db');
    const today = new Date().toISOString().split('T')[0];
    const webhookRows = await query(
      `SELECT member_id, checked_in, check_in_time, checked_out, check_out_time
       FROM attendance_records
       WHERE organisation_id = $1 AND attendance_date = $2 AND source = 'zoho_webhook'`,
      [parseInt(process.env.ORGANISATION_ID || '1', 10), today]
    );
    addCheck('Webhook rows (today)', 'INFO', {
      rowCount: webhookRows.rows.length,
      note: webhookRows.rows.length === 0
        ? 'No webhook events received today — configure the webhook in Zoho People → Settings → Integrations → Webhooks, or this is expected if it is not set up'
        : 'Webhook is delivering data',
      rows: webhookRows.rows,
    });
  } catch (err) {
    addCheck('Webhook rows (today)', 'ERROR', null, err.message);
  }

  // ── CHECK 6: DB members have emails ────────────────────────────────────────────
  try {
    const { query } = require('../db');
    const memberResult = await query(
      `SELECT COUNT(*) AS total, COUNT(email) AS with_email
       FROM members WHERE is_active = true`
    );
    const mRow = memberResult.rows[0];
    addCheck('DB Members', 'INFO', {
      total:     parseInt(mRow.total),
      withEmail: parseInt(mRow.with_email),
      noEmail:   parseInt(mRow.total) - parseInt(mRow.with_email),
    }, parseInt(mRow.with_email) === 0 ? 'No members have emails — Zoho matching will all fail' : null);
  } catch (err) {
    addCheck('DB Members', 'ERROR', null, err.message);
  }

  // ── Conclusion ────────────────────────────────────────────────────────────────
  const failed = report.checks.filter((c) => c.status === 'FAIL' || c.status === 'ERROR');
  const warned = report.checks.filter((c) => c.status === 'WARN');
  report.conclusion = failed.length > 0
    ? `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}`
    : warned.length > 0
    ? `All checks passed with ${warned.length} warning(s): ${warned.map((c) => c.name).join(', ')}`
    : 'All checks passed — integration appears healthy';

  return res.json(report);
});

module.exports = router;
