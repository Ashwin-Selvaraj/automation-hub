'use strict';

const featureFlags       = require('../../services/featureFlags');
const attendanceService  = require('../../services/attendanceService');
const performanceService = require('../../services/performanceService');
const standupRepo        = require('../../repositories/standupRepository');
const sprintRepo         = require('../../repositories/sprintRepository');
const auditLog           = require('../../core/auditLog');
const idempotency        = require('../../core/idempotency');
const { everyNMinutesDuring } = require('../schedule');

/**
 * Polls attendance through the afternoon looking for people who logged off
 * without posting a standup, and nudges them.
 *
 * Recommended for deletion. It reads as surveillance from the receiving end,
 * it depends on a Zoho People API that returns error 7201 on this account, and
 * the same information reaches a lead more usefully as one line in a daily
 * brief. It ships disabled by default and stays behind its feature flag; the
 * decision to remove it is yours.
 */

function toDateStr(d) {
  return d.toISOString().substring(0, 10);
}

async function run({ orgId }) {
  if (!await featureFlags.isZohoAttendanceEnabled()) {
    return { skipped: 'zoho attendance disabled' };
  }

  const sprint = await sprintRepo.getActiveSprint(orgId);
  if (!sprint) return { skipped: 'no active sprint' };

  let attendance;
  try {
    attendance = await attendanceService.getTodayAttendance(orgId);
  } catch (err) {
    auditLog.record(orgId, { type: 'checkout_check', action: `Attendance lookup failed: ${err.message}`, success: false });
    throw err;
  }

  const today = toDateStr(new Date());
  let checkedOut = 0, missingStandup = 0, dmsSent = 0;

  for (const att of (attendance.members || [])) {
    try {
      if (!att.checkedOut) continue;
      checkedOut++;

      const posted = await standupRepo.findByMemberAndDate(att.memberId, today);
      if (posted) {
        if (await idempotency.claim(orgId, `checkout-ok:${att.memberId}:${today}`, 20)) {
          auditLog.record(orgId, {
            type: 'checkout_with_standup', userId: att.slackUserId, userName: att.name,
            action: `Checked out at ${att.checkOutTime} — standup already posted ✓`, success: true,
          });
        }
        continue;
      }

      missingStandup++;

      // Same key the end-of-day reminder uses, so whichever runs first is the
      // only one that messages this person about today's missing standup.
      const key = `missing-standup:${att.memberId}:${today}`;
      if (!await idempotency.claim(orgId, key, 20)) continue;

      const result = await performanceService.recordCheckoutWithoutStandup(
        orgId, sprint.id, att.memberId, att.checkOutTime || '—'
      );

      if (result.dmSent) {
        dmsSent++;
      } else {
        // Nothing was sent, so don't hold the claim against the EOD reminder.
        await idempotency.release(orgId, key);
      }
    } catch (err) {
      console.error(`[checkout-watch] error for ${att.name}:`, err.message);
      auditLog.record(orgId, {
        type: 'checkout_check', userName: att.name,
        action: `Processing error: ${err.message}`, success: false,
      });
    }
  }

  return { checkedOut, missingStandup, dmsSent };
}

module.exports = {
  key:         'checkout-watch',
  name:        'Checkout without standup',
  description: 'Polls attendance in the afternoon and nudges anyone who logged off without posting. Reads as surveillance — consider leaving this off.',
  category:    'delivery',
  audience:    'member',
  defaultEnabled: false,
  schedule: (cfg) => everyNMinutesDuring(15, cfg.checkoutHours, '16-19', cfg.workdays || '1-5'),
  run,
};
