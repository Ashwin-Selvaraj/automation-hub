'use strict';

const peopleService = require('../../services/peopleService');
const notifier      = require('../../core/notifier');
const { todayInZone } = require('../../utils/dateOnly');
const { weekly }    = require('../schedule');

/**
 * Once a week, a DM to the lead listing specific things worth a thank-you:
 * long-running work that finally landed, work finished well ahead of its date,
 * bugs fixed, and reviews done for teammates — the glue work that never shows up
 * in a sprint report.
 *
 * It suggests; it never posts. Recognition in a bot's voice is worth nothing,
 * and a public list compiled by a machine is a leaderboard. The lead decides
 * what to say, to whom, and where.
 */

async function run({ orgId, cfg }) {
  const recipient = process.env.TEAM_LEAD_SLACK_ID || cfg.managerSlackId;
  if (!recipient) return { skipped: 'no TEAM_LEAD_SLACK_ID or manager configured' };

  const to = todayInZone(cfg.timezone);
  const from = peopleService.addDays(to, -6);
  const rec = await peopleService.recognition(orgId, { from, to, githubBudgetMs: 60_000 });

  const outcome = await notifier.sendDM({
    orgId,
    slackUserId: recipient,
    text: peopleService.renderRecognition(rec),
    dedupeKey: `weekly-recognition:${recipient}:${to}`,
    type: 'weekly_recognition',
    action: 'Recognition suggestions sent to lead',
    urgent: true,
  });

  return {
    sent: outcome.sent,
    reason: outcome.reason,
    people: rec.people.length,
    github: rec.github,
  };
}

module.exports = {
  key:         'weekly-recognition',
  name:        'Recognition suggestions',
  description: 'Weekly DM to you with specific work worth acknowledging — long-running tasks landed, bugs fixed, reviews done for teammates. Nothing is posted; you choose what to say.',
  category:    'people',
  audience:    'lead',
  defaultEnabled: true,
  schedule: (cfg) => weekly(cfg.recognitionDay, cfg.recognitionTime, '14:00'),
  run,
};
