'use strict';

const briefService = require('../../services/briefService');
const notifier     = require('../../core/notifier');
const { onDays }   = require('../schedule');

/**
 * One message to the lead each morning, replacing five that went to the team.
 *
 * Everything the retired nags were trying to achieve — someone has not posted,
 * a standup matched no task, work is overdue, someone is off-plan — arrives
 * here as a line the lead can act on, rather than as a DM telling an engineer
 * they are out of compliance.
 *
 * It goes to TEAM_LEAD_SLACK_ID, falling back to the configured manager. If
 * neither is set the automation does nothing rather than guessing a recipient.
 */

function toDateStr(d) {
  return d.toISOString().substring(0, 10);
}

async function run({ orgId, cfg }) {
  const recipient = process.env.TEAM_LEAD_SLACK_ID || cfg.managerSlackId;
  if (!recipient) {
    return { skipped: 'no TEAM_LEAD_SLACK_ID or manager configured' };
  }

  const signals = await briefService.collect(orgId);
  const text    = briefService.render(signals);

  const outcome = await notifier.sendDM({
    orgId,
    slackUserId: recipient,
    text,
    dedupeKey: `daily-brief:${recipient}:${toDateStr(new Date())}`,
    type: 'daily_brief',
    action: 'Daily brief sent to lead',
    // A scheduled brief should arrive at the time it was scheduled for, even if
    // the lead set that outside the team's working hours.
    urgent: true,
  });

  return {
    sent:     outcome.sent,
    reason:   outcome.reason,
    blockers: signals.blockers.length,
    overdue:  signals.overdue.length,
    stale:    signals.stale.length,
    quiet:    signals.noUpdate.length + signals.unmatched.length,
  };
}

module.exports = {
  key:         'daily-brief',
  name:        'Daily brief',
  description: 'One morning DM to you: who is blocked, what is slipping, what has stopped moving, and who was quiet. Replaces the DMs that used to go to the team.',
  category:    'reporting',
  audience:    'lead',
  defaultEnabled: true,
  schedule: (cfg) => onDays(cfg.briefTime, '09:00', cfg.workdays || '1-5'),
  run,
};
