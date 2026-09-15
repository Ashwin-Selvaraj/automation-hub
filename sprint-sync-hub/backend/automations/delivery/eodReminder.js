'use strict';

const slackService       = require('../../services/slackService');
const claudeService      = require('../../services/claudeService');
const performanceService = require('../../services/performanceService');
const attendanceService  = require('../../services/attendanceService');
const memberRepo         = require('../../repositories/memberRepository');
const statsRepo          = require('../../repositories/statsRepository');
const notifRepo          = require('../../repositories/notificationRepository');
const sprintRepo         = require('../../repositories/sprintRepository');
const auditLog           = require('../../core/auditLog');
const notifier           = require('../../core/notifier');
const { onDays, parseTime } = require('../schedule');

/**
 * End-of-day nudge for anyone who has not posted a standup, or posted one that
 * matched no Jira task.
 *
 * Scheduled for retirement: in the target design this becomes a line in the
 * daily lead brief rather than a message to the individual. It is kept here,
 * behind a toggle, so the behaviour change is yours to make rather than one
 * that arrives with a deploy.
 */

function toDateStr(d) {
  return d.toISOString().substring(0, 10);
}

async function run({ orgId, cfg }) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = toDateStr(new Date());

  const messages = await slackService.getChannelMessages(
    cfg.channelId, todayStart.getTime() / 1000, Date.now() / 1000
  );
  const postedUserIds = new Set(messages.map((m) => m.user));

  // From the durable audit log, not a 500-entry array a restart could empty.
  const matchedUserIds = await auditLog.userIdsWithEntrySince(orgId, 'match', todayStart.toISOString());

  const sprint   = await sprintRepo.getActiveSprint(orgId);
  const sprintId = sprint ? sprint.id : null;

  let attendanceBySlackId = new Map();
  try {
    const attendance = await attendanceService.getTodayAttendance(orgId);
    attendanceBySlackId = new Map((attendance.members || []).map((m) => [m.slackUserId, m]));
  } catch (err) {
    console.warn('[eod-reminder] attendance lookup failed, proceeding without it:', err.message);
  }

  let sent = 0, skipped = 0;

  for (const member of cfg.teamMembers) {
    const didPost  = postedUserIds.has(member.id);
    const didMatch = matchedUserIds.has(member.id);
    if (didPost && didMatch) continue;

    try {
      const dbMember = await memberRepo.findOrCreate(orgId, member.id, member.name, member.email || null);
      const att      = attendanceBySlackId.get(member.id);

      // Skip only on positive evidence of absence. `attendanceKnown` is false
      // when the only signal was the Slack fallback, which infers presence from
      // having posted — so treating that as absence skipped exactly the people
      // this reminder exists for.
      if (att && att.attendanceKnown && !att.checkedIn) {
        skipped++;
        auditLog.record(orgId, {
          type: 'absent_skip', userId: member.id, userName: member.name,
          action: 'Skipped EOD DM — recorded absent today', success: true,
        });
        if (sprintId) {
          try { await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, today, { checked_in: false, posted_standup: false }); }
          catch (statErr) { console.warn('[eod-reminder] absent stat write failed:', statErr.message); }
        }
        continue;
      }

      // Skip anyone who finished well before the reminder fires.
      if (att?.checkOutTime) {
        const eod = parseTime(cfg.eodCheckTime, '18:30');
        const [coh, com] = att.checkOutTime.split(':').map(Number);
        if ((eod.hour * 60 + eod.minute) - (coh * 60 + com) > 60) {
          skipped++;
          auditLog.record(orgId, {
            type: 'early_checkout_skip', userId: member.id, userName: member.name,
            action: `Skipped EOD DM — checked out at ${att.checkOutTime}`, success: true,
          });
          continue;
        }
      }

      if (!await performanceService.shouldSendTaskDM(dbMember.id)) {
        skipped++;
        auditLog.record(orgId, {
          type: 'missing_update_dm', userId: member.id, userName: member.name,
          action: 'Skipped EOD DM — managerial role exempt', success: true,
        });
        continue;
      }

      let text, type, action;
      if (!didPost) {
        text   = await claudeService.draftMissingUpdateDM(member.name, cfg.channelId, cfg.sprintName);
        type   = 'missing_update_dm';
        action = 'Missing standup DM sent';
      } else {
        const boardUrl = `${(process.env.JIRA_SITE_URL || '').replace(/\/$/, '')}/jira/software/projects/${cfg.projectKey}/boards`;
        text   = `Hey ${member.name} 👋 Thanks for your standup today! I noticed I couldn't automatically match it to a Jira task in ${cfg.sprintName}.\n\nCould you update your tasks on the board so the team has full visibility? → ${boardUrl}`;
        type   = 'no_match_dm';
        action = 'EOD: no Jira match — asked to update tasks';
      }

      // The checkout watcher claims this same key, so the two jobs cannot both
      // message one person about the same missing standup on the same evening.
      const dedupeKey = didPost
        ? `eod-no-match:${dbMember.id}:${today}`
        : `missing-standup:${dbMember.id}:${today}`;

      const outcome = await notifier.sendDM({
        orgId, slackUserId: member.id, text, dedupeKey, type,
        userName: member.name, action,
      });

      if (!outcome.sent) { skipped++; continue; }
      sent++;

      if (sprintId) {
        try {
          const attFields = att ? {
            checked_in:     att.checkedIn,
            check_in_time:  att.checkInTime || null,
            check_out_time: att.checkOutTime || null,
          } : {};
          if (!didPost) {
            await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, today, { posted_standup: false, ...attFields });
          }
          await notifRepo.recordNotification(orgId, dbMember.id, didPost ? 'no_match_dm' : 'missing_standup', 'dm', null);
        } catch (perfErr) {
          console.error('[eod-reminder] DB update error:', perfErr.message);
        }
      }
    } catch (err) {
      console.error(`[eod-reminder] error for ${member.name}:`, err.message);
      auditLog.record(orgId, {
        type: 'missing_update_dm', userId: member.id, userName: member.name,
        action: 'EOD DM failed', success: false, details: err.message,
      });
    }
  }

  return { sent, skipped };
}

module.exports = {
  key:         'eod-reminder',
  name:        'End-of-day standup reminder',
  description: 'DMs anyone who has not posted a standup, or whose post matched no Jira task. Skips people recorded absent.',
  category:    'delivery',
  audience:    'member',
  defaultEnabled: true,
  schedule: (cfg) => onDays(cfg.eodCheckTime, '18:30', cfg.workdays || '1-5'),
  run,
};
