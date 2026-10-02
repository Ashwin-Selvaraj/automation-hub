'use strict';

/**
 * Checkout history. Mounted at /api/checkout in server.js.
 *
 * The nudge endpoint that lived here was removed along with the checkout
 * watcher: messaging someone because they logged off without posting reads as
 * surveillance, and the same fact now reaches the lead as one line in the
 * daily brief. What remains is read-only history for the Performance tab.
 */

const express            = require('express');
const router             = express.Router();
const memberRepo         = require('../repositories/memberRepository');
const standupRepo        = require('../repositories/standupRepository');
const notifRepo          = require('../repositories/notificationRepository');
const sprintRepo         = require('../repositories/sprintRepository');
const statsRepo          = require('../repositories/statsRepository');
const { getOrgId } = require('../core/orgContext');
const teamClock = require('../utils/teamClock');
const { dateOnlyString, addDays, weekdayOf } = require('../utils/dateOnly');
const { parseWorkdays } = require('../utils/workingTime');
const { localParts } = require('../utils/timeZone');

// A pg DATE arrives as a Date at local midnight; dateOnlyString reads it back
// with local components, where toISOString() would give the previous day on a
// server east of UTC.
function toDateStr(d) {
  return dateOnlyString(d) || teamClock.today();
}

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
    const todayStr = teamClock.today();
    const calendarDays = [];
    for (let i = days - 1; i >= 0; i--) calendarDays.push(addDays(todayStr, -i));
    const workdaySet = parseWorkdays(teamClock.workdays());

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
      const isWeekend = !workdaySet.has(weekdayOf(date));

      const checkedOut    = stat ? (stat.check_out_time != null) : false;
      const postedStandup = standup != null;
      const checkedIn     = stat ? (stat.checked_in !== false) : false;
      // Covered only via a later bulk/retroactive catch-up message that
      // mentioned this date — not a same-day post. Distinct from postedStandup
      // so the UI can show "caught up late" instead of a plain miss or a
      // genuine on-time post.
      const bulkCatchup   = !postedStandup && stat?.is_bulk_post === true;

      return {
        date,
        isWeekend,
        checkedOut,
        checkOutTime: stat?.check_out_time
          ? String(stat.check_out_time).substring(0, 5)
          : null,
        postedStandup,
        bulkCatchup,
        standupStatus: isWeekend ? 'weekend' : postedStandup ? 'posted' : bulkCatchup ? 'bulk' : 'missed',
        standupPostTime: standup?.created_at
          ? (() => { const t = localParts(standup.created_at, teamClock.teamZone()); return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`; })()
          : null,
        onLeave:    stat?.on_leave   ?? false,
        leaveType:  stat?.leave_type ?? null,
        absent:     !isWeekend && !checkedIn && !stat?.on_leave,
      };
    });

    // Summary counters (per working day, mutually exclusive buckets)
    const workdays = history.filter((d) => !d.isWeekend);
    const summary  = {
      postedOnTime:    workdays.filter((d) => d.postedStandup).length,
      bulkCatchupDays: workdays.filter((d) => d.bulkCatchup).length,
      missed:          workdays.filter((d) => !d.postedStandup && !d.bulkCatchup && !d.absent && !d.onLeave).length,
      absent:          workdays.filter((d) => d.absent).length,
      onLeave:         workdays.filter((d) => d.onLeave).length,
      // Legacy fields kept for any other consumers of this endpoint
      checkoutWithStandup:    workdays.filter((d) => d.checkedOut && d.postedStandup).length,
      checkoutWithoutStandup: workdays.filter((d) => d.checkedOut && !d.postedStandup).length,
    };

    res.json({ memberId, days, history, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
