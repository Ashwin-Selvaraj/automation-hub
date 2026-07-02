'use strict';

/**
 * Checkout routes — manual nudge and history.
 * Mounted at /api/checkout in server.js.
 *
 * The "today's checkout status" endpoint was removed — it derived "checked
 * out" from Zoho Chat presence going offline, which is not the same signal
 * as a real Zoho People check-out and was misleading. Real-time checkout
 * detection (cron Job 5 in cron.js) already only fires on genuine Zoho
 * webhook check-out events; see attendanceService.js.
 */

const express            = require('express');
const router             = express.Router();
const attendanceService  = require('../services/attendanceService');
const performanceService = require('../services/performanceService');
const memberRepo         = require('../repositories/memberRepository');
const standupRepo        = require('../repositories/standupRepository');
const notifRepo          = require('../repositories/notificationRepository');
const sprintRepo         = require('../repositories/sprintRepository');
const statsRepo          = require('../repositories/statsRepository');
const activityLog        = require('../services/activityLog');

function getOrgId() {
  return parseInt(process.env.ORGANISATION_ID || '1', 10);
}

function toDateStr(d) {
  if (!d) return new Date().toISOString().split('T')[0];
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().split('T')[0];
}

// ─── POST /api/checkout/nudge/:memberId ──────────────────────────────────────
// Manually trigger a checkout nudge DM for a specific member.

router.post('/nudge/:memberId', async (req, res) => {
  try {
    const orgId    = getOrgId();
    const memberId = parseInt(req.params.memberId, 10);
    const reason   = req.body?.reason || 'manual trigger';

    const sprint   = await sprintRepo.getActiveSprint(orgId);
    if (!sprint) return res.status(400).json({ error: 'No active sprint found' });

    const member = await memberRepo.findById(memberId);
    if (!member || member.organisation_id !== orgId) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Use today's real checkout time if the unified attendance source has one
    // (only ever populated from a genuine Zoho webhook event) — otherwise
    // fall back to now.
    let checkoutTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    try {
      const attendanceToday = await attendanceService.getTodayAttendance(orgId);
      const att = (attendanceToday.members || []).find((m) => m.memberId === memberId);
      if (att?.checkOutTime) checkoutTime = att.checkOutTime;
    } catch (_) { /* non-fatal — fall back to now */ }

    activityLog.addEntry({
      type: 'manual_nudge', userId: member.slack_user_id, userName: member.name,
      action: `Manual nudge triggered — reason: ${reason}`, success: true,
    });

    const result = await performanceService.recordCheckoutWithoutStandup(
      orgId, sprint.id, memberId, checkoutTime
    );

    res.json({
      success: true,
      dmSent:  result.dmSent,
      message: result.reason,
      member:  { id: member.id, name: member.name, slackUserId: member.slack_user_id },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/checkout/history ────────────────────────────────────────────────
// Returns checkout + standup history for a member for the last N days.

router.get('/history', async (req, res) => {
  try {
    const orgId    = getOrgId();
    const memberId = parseInt(req.query.memberId, 10);
    const days     = Math.min(parseInt(req.query.days || '30', 10), 90);

    if (!memberId) return res.status(400).json({ error: 'memberId is required' });

    const member = await memberRepo.findById(memberId);
    if (!member || member.organisation_id !== orgId) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Generate the list of calendar days
    const calendarDays = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      calendarDays.push(toDateStr(d));
    }

    // Fetch daily stats from DB for these days (single query)
    const sprint = await sprintRepo.getActiveSprint(orgId);
    let dailyStats = [];
    if (sprint) {
      dailyStats = await statsRepo.getDailyStats(memberId, sprint.id).catch(() => []);
    }
    const statsByDate = {};
    for (const s of dailyStats) statsByDate[toDateStr(s.stat_date)] = s;

    // Fetch all standup posts for this member
    const standupPosts = sprint
      ? await standupRepo.getPostsForMemberInSprint(memberId, sprint.id).catch(() => [])
      : [];
    const standupByDate = {};
    for (const p of standupPosts) {
      const d = toDateStr(p.post_date);
      if (!standupByDate[d]) standupByDate[d] = p;
    }

    // Build daily records
    const history = calendarDays.map((date) => {
      const stat    = statsByDate[date];
      const standup = standupByDate[date];
      const dow     = new Date(date + 'T12:00:00').getDay(); // 0=Sun, 6=Sat
      const isWeekend = dow === 0 || dow === 6;

      const checkedOut    = stat ? (stat.check_out_time != null) : false;
      const postedStandup = standup != null;
      const checkedIn     = stat ? (stat.checked_in !== false) : false;

      return {
        date,
        isWeekend,
        checkedOut,
        checkOutTime: stat?.check_out_time
          ? String(stat.check_out_time).substring(0, 5)
          : null,
        postedStandup,
        standupPostTime: standup?.created_at
          ? new Date(standup.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : null,
        onLeave:    stat?.on_leave   ?? false,
        leaveType:  stat?.leave_type ?? null,
        absent:     !isWeekend && !checkedIn && !stat?.on_leave,
      };
    });

    // Summary counters
    const workdays = history.filter((d) => !d.isWeekend);
    const summary  = {
      checkoutWithStandup:    workdays.filter((d) => d.checkedOut && d.postedStandup).length,
      checkoutWithoutStandup: workdays.filter((d) => d.checkedOut && !d.postedStandup).length,
      absent:                 workdays.filter((d) => d.absent).length,
      onLeave:                workdays.filter((d) => d.onLeave).length,
    };

    res.json({ memberId, days, history, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
