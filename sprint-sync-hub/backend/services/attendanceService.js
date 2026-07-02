'use strict';

/**
 * attendanceService.js — Unified attendance service.
 *
 * Merges data sources in priority order (later sources override earlier ones):
 *   1. Zoho Chat presence   — /_chat/v2/users, confirmed working, no check-in time
 *   2. Zoho Webhook data    — stored from real-time push events, overrides presence
 *      with real check-in/out times when configured (Zoho People → Settings →
 *      Integrations → Webhooks → POST /api/webhooks/zoho-attendance)
 *   3. Slack first message  — guaranteed fallback for anyone the above missed
 *
 * The Zoho People Attendance REST API (getAttendance/getAbsence/etc.) is not
 * used here — it returns error 7201 (module disabled) on every endpoint
 * variant on this account, so polling it was pure wasted work. If Zoho People
 * attendance is ever re-enabled, that data source can be added back.
 *
 * External code never needs to know which source is active.
 * getTodayAttendance() NEVER throws — it catches all errors and falls back.
 */

const { query }    = require('../db');
const zohoService  = require('./zohoService');

const ORG_ID          = () => parseInt(process.env.ORGANISATION_ID || '1', 10);
const WORK_START_TIME = () => process.env.WORK_START_TIME  || '09:00';
const LATE_GRACE_MINS = () => parseInt(process.env.LATE_GRACE_MINUTES || '15', 10);

// ─── Timezone-correct date helper ─────────────────────────────────────────────
// Using UTC would return yesterday's date after midnight IST — always use IST.

function getTodayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0]; // YYYY-MM-DD in IST
}

// ─── Time utilities ───────────────────────────────────────────────────────────

function parseTimeString(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (s.includes('T')) {
    // ISO datetime — convert to IST HH:MM
    const ist = new Date(new Date(s).getTime() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().substring(11, 16);
  }
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function minutesDiff(from, to) {
  if (!from || !to) return 0;
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return (th * 60 + tm) - (fh * 60 + fm);
}

// ─── SOURCE: Zoho Webhook (push-based) ───────────────────────────────────────

/**
 * Process an incoming Zoho People webhook payload and store in DB.
 * Called from POST /api/webhooks/zoho-attendance.
 * Always returns an object — never throws.
 */
async function processZohoWebhook(payload) {
  try {
    const email     = (payload.email || payload.empEmail || payload.employeeEmail || '').toLowerCase().trim();
    const eventType = payload.eventType || payload.event || payload.type || '';
    const timestamp = payload.timestamp || payload.checkInTime || payload.time || new Date().toISOString();

    if (!email) {
      console.warn('[Webhook] No email in payload:', JSON.stringify(payload));
      return { success: false, reason: 'No email in payload' };
    }

    const memberRes = await query(
      'SELECT id, name FROM members WHERE LOWER(email) = $1 AND organisation_id = $2',
      [email, ORG_ID()]
    );
    if (!memberRes.rows.length) {
      console.warn(`[Webhook] No member found for email: ${email}`);
      return { success: false, reason: `No member found for ${email}` };
    }
    const member = memberRes.rows[0];

    const eventDate   = new Date(timestamp);
    // Convert to IST for date/time storage
    const istDate     = new Date(eventDate.getTime() + 5.5 * 60 * 60 * 1000);
    const dateStr     = istDate.toISOString().split('T')[0];
    const timeStr     = istDate.toISOString().substring(11, 16);

    const isCheckIn   = /check.?in|clockin|sign.?in/i.test(eventType);
    const isCheckOut  = /check.?out|clockout|sign.?out/i.test(eventType);

    await query(
      `INSERT INTO attendance_records
         (organisation_id, member_id, attendance_date, source,
          checked_in, check_in_time, checked_out, check_out_time, status, raw_data)
       VALUES ($1,$2,$3,'zoho_webhook',$4,$5,$6,$7,'present',$8)
       ON CONFLICT (organisation_id, member_id, attendance_date, source)
       DO UPDATE SET
         checked_in     = CASE WHEN $4 THEN true ELSE attendance_records.checked_in END,
         check_in_time  = CASE WHEN $4 AND $5::TEXT IS NOT NULL THEN $5 ELSE attendance_records.check_in_time END,
         checked_out    = CASE WHEN $6 THEN true ELSE attendance_records.checked_out END,
         check_out_time = CASE WHEN $6 AND $7::TEXT IS NOT NULL THEN $7 ELSE attendance_records.check_out_time END,
         updated_at     = NOW()`,
      [
        ORG_ID(), member.id, dateStr,
        isCheckIn,  isCheckIn  ? timeStr : null,
        isCheckOut, isCheckOut ? timeStr : null,
        JSON.stringify(payload),
      ]
    );

    console.log(`[Webhook] ✓ ${member.name}: ${eventType} at ${timeStr} on ${dateStr}`);
    return { success: true, member: member.name, event: eventType, time: timeStr, date: dateStr };
  } catch (err) {
    console.error('[Webhook] processZohoWebhook error:', err.message);
    return { success: false, reason: err.message };
  }
}

async function _getWebhookAttendance(date) {
  try {
    const res = await query(
      `SELECT member_id, checked_in, check_in_time::text AS check_in_time,
              checked_out, check_out_time::text AS check_out_time, status
       FROM attendance_records
       WHERE organisation_id = $1 AND attendance_date = $2 AND source = 'zoho_webhook'`,
      [ORG_ID(), date]
    );
    return res.rows;
  } catch (err) {
    console.warn('[Attendance:Webhook] DB query failed:', err.message);
    return [];
  }
}

// ─── SOURCE 3: Slack first message ───────────────────────────────────────────

async function _getSlackPresenceAttendance(members, date) {
  if (!members.length) return [];
  try {
    const res = await query(
      `SELECT member_id,
              MIN(created_at) AS first_post,
              MAX(created_at) AS last_post,
              COUNT(*)        AS post_count
       FROM standup_posts
       WHERE organisation_id = $1
         AND post_date = $2
         AND member_id = ANY($3)
       GROUP BY member_id`,
      [ORG_ID(), date, members.map(m => m.id)]
    );

    const postMap = {};
    res.rows.forEach(row => {
      // Convert to IST
      const firstIST = new Date(new Date(row.first_post).getTime() + 5.5 * 60 * 60 * 1000);
      const lastIST  = new Date(new Date(row.last_post).getTime()  + 5.5 * 60 * 60 * 1000);
      postMap[row.member_id] = {
        firstPostTime: firstIST.toISOString().substring(11, 16),
        lastPostTime:  lastIST.toISOString().substring(11, 16),
        postCount:     parseInt(row.post_count, 10),
      };
    });

    return members.map(m => {
      const post = postMap[m.id];
      if (!post) return { memberId: m.id, checkedIn: false, status: 'absent', source: 'slack_presence' };

      const workStart   = (m.work_start_time || WORK_START_TIME()).substring(0, 5);
      const lateByMins  = Math.max(0, minutesDiff(workStart, post.firstPostTime));
      const isLate      = lateByMins > LATE_GRACE_MINS();

      return {
        memberId:      m.id,
        checkedIn:     true,
        checkInTime:   post.firstPostTime,
        checkOutTime:  post.lastPostTime,
        status:        isLate ? 'late' : 'present',
        isLate,
        lateByMinutes: lateByMins,
        postCount:     post.postCount,
        source:        'slack_presence',
      };
    });
  } catch (err) {
    console.warn('[Attendance:Slack] Failed:', err.message);
    return members.map(m => ({ memberId: m.id, checkedIn: false, status: 'absent', source: 'slack_presence' }));
  }
}

// ─── MAIN: getTodayAttendance ─────────────────────────────────────────────────

/**
 * Get today's attendance for all team members in an org.
 * Tries sources in priority order; NEVER throws.
 *
 * @param {number} [organisationId]
 * @returns {Promise<{
 *   date: string,
 *   source: 'zoho_presence'|'zoho_webhook'|'slack_presence'|'mixed'|'no_data',
 *   members: AttendanceMember[],
 *   present: AttendanceMember[],
 *   absent:  AttendanceMember[],
 *   late:    AttendanceMember[],
 *   summary: { total, present, absent, late, onLeave, noData },
 *   sourceDetails: { zohoPresenceUsed, webhookDataExists, slackUsed },
 *   configured: true,
 * }>}
 */
async function getTodayAttendance(organisationId) {
  const date  = getTodayIST();
  const orgId = organisationId || ORG_ID();

  // Load members
  let members = [];
  try {
    const res = await query(
      `SELECT id, name, email, slack_user_id, zoho_iamuid, zoho_emp_id,
              work_start_time::text AS work_start_time
       FROM members
       WHERE is_active = true AND organisation_id = $1
       ORDER BY name`,
      [orgId]
    );
    members = res.rows;
  } catch (err) {
    console.error('[Attendance] Cannot load members:', err.message);
    return _emptyResult(date);
  }

  if (!members.length) return _emptyResult(date);

  const attendanceMap = {}; // memberId → data
  const sourceDetails = { webhookDataExists: false, slackUsed: false, zohoPresenceUsed: false };
  let primarySource   = 'no_data';

  // ── Source: Zoho Chat Presence (/_chat/v2/users) ──────────────────────────
  // Confirmed working on this account. Real-time online/offline signal, no
  // check-in timestamp. Members not matched in Zoho fall through to Slack.
  try {
    const zohoPresenceData = await zohoService.getAllTodayAttendance(orgId);
    if (zohoPresenceData && zohoPresenceData.length > 0) {
      zohoPresenceData.forEach(d => {
        if (d.isPresent) {
          // Only mark as present if actually online — absent members
          // will be filled by Slack fallback below
          attendanceMap[d.memberId] = {
            memberId:      d.memberId,
            checkedIn:     true,
            checkInTime:   null, // presence doesn't give check-in time
            checkedOut:    false,
            checkOutTime:  null,
            status:        'present',
            source:        'zoho_presence',
          };
        }
      });
      const presentCount = Object.keys(attendanceMap).length;
      sourceDetails.zohoPresenceUsed = true;
      if (presentCount > 0) primarySource = 'zoho_presence';
      console.log(`[Attendance] Zoho Presence: ${presentCount} members online for ${date}`);
    }
  } catch (err) {
    console.warn('[Attendance] Zoho Presence source error:', err.message);
  }

  // ── Source: Zoho Webhook ───────────────────────────────────────────────────
  // Merge on top — webhook gives real check-in times and overrides presence
  try {
    const webhookData = await _getWebhookAttendance(date);
    if (webhookData.length > 0) {
      webhookData.forEach(d => {
        attendanceMap[d.member_id] = {
          memberId:     d.member_id,
          checkedIn:    d.checked_in,
          checkInTime:  d.check_in_time   ? d.check_in_time.substring(0, 5)  : null,
          checkedOut:   d.checked_out,
          checkOutTime: d.check_out_time  ? d.check_out_time.substring(0, 5) : null,
          status:       d.status || 'present',
          source:       'zoho_webhook',
        };
      });
      primarySource = 'zoho_webhook';
      sourceDetails.webhookDataExists = true;
      console.log(`[Attendance] Zoho Webhook: ${webhookData.length} records for ${date}`);
    }
  } catch (err) {
    console.warn('[Attendance] Webhook source error:', err.message);
  }

  // ── Source 3: Slack — fill all remaining gaps ─────────────────────────────
  const membersWithNoData = members.filter(m => !attendanceMap[m.id]);
  if (membersWithNoData.length > 0) {
    try {
      const slackData = await _getSlackPresenceAttendance(membersWithNoData, date);
      slackData.forEach(d => {
        if (!attendanceMap[d.memberId]) attendanceMap[d.memberId] = d;
      });
      sourceDetails.slackUsed = true;
      if (primarySource === 'no_data') {
        primarySource = 'slack_presence';
      } else if (membersWithNoData.length < members.length) {
        primarySource = 'mixed';
      }
      console.log(`[Attendance] Slack filled ${membersWithNoData.length} gaps for ${date}`);
    } catch (err) {
      console.warn('[Attendance] Slack source error:', err.message);
    }
  }

  // ── Build final member list ───────────────────────────────────────────────
  const result = members.map(member => {
    const data      = attendanceMap[member.id];
    const workStart = member.work_start_time
      ? member.work_start_time.substring(0, 5)
      : WORK_START_TIME();

    if (!data || !data.checkedIn) {
      return {
        memberId:      member.id,
        name:          member.name,
        email:         member.email,
        slackUserId:   member.slack_user_id,
        checkedIn:     false,
        checkInTime:   null,
        checkedOut:    false,
        checkOutTime:  null,
        status:        'absent',
        isLate:        false,
        lateByMinutes: 0,
        source:        data?.source || 'no_data',
      };
    }

    const checkInStr  = data.checkInTime ? String(data.checkInTime).substring(0, 5) : null;
    const lateByMins  = checkInStr ? Math.max(0, minutesDiff(workStart, checkInStr)) : 0;
    const isLate      = lateByMins > LATE_GRACE_MINS();

    return {
      memberId:      member.id,
      name:          member.name,
      email:         member.email,
      slackUserId:   member.slack_user_id,
      checkedIn:     true,
      checkInTime:   checkInStr,
      checkedOut:    data.checkedOut  || false,
      checkOutTime:  data.checkOutTime ? String(data.checkOutTime).substring(0, 5) : null,
      status:        isLate ? 'late' : (data.status || 'present'),
      isLate,
      lateByMinutes: lateByMins,
      source:        data.source,
    };
  });

  // ── Persist checked-in records for history ────────────────────────────────
  for (const r of result) {
    if (!r.checkedIn) continue;
    query(
      `INSERT INTO attendance_records
         (organisation_id, member_id, attendance_date, source,
          checked_in, check_in_time, checked_out, check_out_time,
          status, is_late, late_by_minutes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::TIME,$7,$8::TIME,$9,$10,$11,NOW())
       ON CONFLICT (organisation_id, member_id, attendance_date, source)
       DO UPDATE SET
         checked_in      = EXCLUDED.checked_in,
         check_in_time   = COALESCE(EXCLUDED.check_in_time, attendance_records.check_in_time),
         checked_out     = EXCLUDED.checked_out,
         check_out_time  = COALESCE(EXCLUDED.check_out_time, attendance_records.check_out_time),
         status          = EXCLUDED.status,
         is_late         = EXCLUDED.is_late,
         late_by_minutes = EXCLUDED.late_by_minutes,
         updated_at      = NOW()`,
      [
        ORG_ID(), r.memberId, date, r.source,
        r.checkedIn,  r.checkInTime  || null,
        r.checkedOut, r.checkOutTime || null,
        r.status, r.isLate, r.lateByMinutes,
      ]
    ).catch(err => console.warn('[Attendance] Persist error:', err.message));
  }

  const present = result.filter(r => r.checkedIn);
  const absent  = result.filter(r => !r.checkedIn);
  const late    = result.filter(r => r.isLate);

  return {
    configured:    true,
    date,
    source:        primarySource,
    members:       result,
    present,
    absent,
    late,
    onLeave:       [],
    summary: {
      total:   result.length,
      present: present.length,
      absent:  absent.length,
      late:    late.length,
      onLeave: 0,
      noData:  result.filter(r => r.source === 'no_data').length,
    },
    sourceDetails,
  };
}

function _emptyResult(date) {
  return {
    configured: true,
    date,
    source: 'no_data',
    members: [], present: [], absent: [], late: [], onLeave: [],
    summary: { total: 0, present: 0, absent: 0, late: 0, onLeave: 0, noData: 0 },
    sourceDetails: { zohoPresenceUsed: false, webhookDataExists: false, slackUsed: false },
  };
}

// ─── History ──────────────────────────────────────────────────────────────────

async function getMemberAttendanceHistory(memberId, days) {
  const res = await query(
    `SELECT attendance_date::text, source, checked_in,
            check_in_time::text, checked_out, check_out_time::text,
            status, is_late, late_by_minutes
     FROM attendance_records
     WHERE member_id = $1
       AND attendance_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
     ORDER BY attendance_date DESC`,
    [memberId, days || 30]
  );
  return res.rows;
}

async function getTeamAttendanceHistory(organisationId, days) {
  const res = await query(
    `SELECT ar.attendance_date::text, ar.member_id, m.name,
            ar.checked_in, ar.check_in_time::text, ar.status,
            ar.is_late, ar.late_by_minutes, ar.source
     FROM attendance_records ar
     JOIN members m ON m.id = ar.member_id
     WHERE ar.organisation_id = $1
       AND ar.attendance_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
     ORDER BY ar.attendance_date DESC, m.name`,
    [organisationId || ORG_ID(), days || 7]
  );
  return res.rows;
}

module.exports = {
  getTodayAttendance,
  getMemberAttendanceHistory,
  getTeamAttendanceHistory,
  processZohoWebhook,
};
