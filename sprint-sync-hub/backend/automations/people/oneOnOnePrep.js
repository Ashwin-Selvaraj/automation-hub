'use strict';

const peopleRepo    = require('../../repositories/peopleRepository');
const peopleService = require('../../services/peopleService');
const notifier      = require('../../core/notifier');
const { todayInZone } = require('../../utils/dateOnly');
const { onDays }    = require('../schedule');

/**
 * On the morning of someone's 1:1, sends the lead a prep pack: the follow-ups
 * either side still owes from last time, what they closed since, what is in
 * progress or has stopped moving, anything they said they were waiting on, and
 * the code-review picture — each turned into a question to ask rather than a
 * verdict.
 *
 * Only people with a 1:1 day set on the People tab are covered, so until the
 * lead sets one this does nothing. It goes to the lead; the person never
 * receives it.
 */

async function run({ orgId, cfg }) {
  const recipient = process.env.TEAM_LEAD_SLACK_ID || cfg.managerSlackId;
  if (!recipient) return { skipped: 'no TEAM_LEAD_SLACK_ID or manager configured' };

  const today = todayInZone(cfg.timezone);
  const scheduled = await peopleRepo.scheduledMembers(orgId);
  const due = scheduled.filter((m) => peopleService.isOneOnOneDue(m, today));

  const out = { scheduled: scheduled.length, due: due.length, sent: 0, held: 0, failed: 0 };
  for (const member of due) {
    try {
      // This is a message, so wait for current GitHub data rather than the
      // dashboard's quick cached answer.
      const prep = await peopleService.oneOnOnePrep(orgId, member.id, { today, reviewBudgetMs: 30_000 });
      if (!prep) continue;

      const outcome = await notifier.sendDM({
        orgId,
        slackUserId: recipient,
        text: peopleService.renderPrep(prep),
        dedupeKey: `one-on-one-prep:${member.id}:${today}`,
        type: 'one_on_one_prep',
        userName: member.name,
        action: `1:1 prep for ${member.name} sent to lead`,
        // Arrives at the time the lead scheduled it, before the 1:1.
        urgent: true,
      });
      if (outcome.sent) out.sent++;
      else out.held++;
    } catch (err) {
      console.error(`[one-on-one-prep] ${member.name}:`, err.message);
      out.failed++;
    }
  }
  return out;
}

module.exports = {
  key:         'one-on-one-prep',
  name:        '1:1 prep',
  description: 'On the morning of each 1:1, a DM to you with open follow-ups, what they closed, what has stalled, what they said they were waiting on, and questions worth asking. Set 1:1 days on the People tab.',
  category:    'people',
  audience:    'lead',
  defaultEnabled: true,
  schedule: (cfg) => onDays(cfg.oneOnOnePrepTime, '08:30', cfg.workdays || '1-5'),
  run,
};
