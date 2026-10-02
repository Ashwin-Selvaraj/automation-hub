'use strict';

const prReviewService = require('../../services/prReviewService');
const notifier        = require('../../core/notifier');
const slackText       = require('../../utils/slackText');
const { onDays }      = require('../schedule');

/**
 * One message to each person who owes reviews, listing what is waiting on them.
 *
 * This is the only part of the GitHub integration that messages an engineer, so
 * it is deliberately narrow and ships switched OFF:
 *
 *  - It is about the recipient's own work queue — something they were asked to
 *    do, which is blocking a colleague — in the same family as the overdue-task
 *    alert, and nothing like a message about their own compliance.
 *  - It sends a single digest per person per day, never one message per pull
 *    request, so a busy reviewer gets one message, not eight.
 *  - Only waits past the SLA are included, and nothing parked for weeks: nudging
 *    someone about a pull request that has sat for two months is noise, and it
 *    is the lead's call what to do with it (the brief counts them).
 *  - Reviewers with no linked Slack account are skipped and counted in the run
 *    summary, never guessed at. Team requests cannot be tied to a person and are
 *    left to the lead, who sees them in the brief.
 *
 * The lead can read exactly what this would say before enabling it: the same
 * waits appear in the daily brief.
 */

function toDateStr(d) {
  return d.toISOString().substring(0, 10);
}

/** Builds the digest for one reviewer. Pure, so the wording can be tested. */
function buildDigest(name, items) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const count = items.length;
  const hours = (h) => `${Math.round(h)} working ${Math.round(h) === 1 ? 'hour' : 'hours'}`;

  const lines = items.map((e) => {
    const label = slackText.link(e.url, `${e.repo}#${e.number} ${e.title}`, { max: 70 });
    const author = e.author ? `opened by ${slackText.escape(e.author)}, ` : '';
    return `• ${label} — ${author}waiting ${hours(e.waitingHours)}`;
  });

  return [
    `Hi ${slackText.escape(first)} 👋 ${count === 1 ? '1 pull request is' : `${count} pull requests are`} waiting for your review:`,
    '',
    ...lines,
    '',
    'Whenever you have a gap, a quick look helps unblock whoever is waiting. — Sprint-Sync Hub',
  ].join('\n');
}

async function run({ orgId }) {
  // This runs on a schedule and sends messages, so it insists on current data
  // and is willing to wait for it.
  const assessment = await prReviewService.assessWithin(orgId, { maxAgeMs: 0, budgetMs: 60_000 });

  if (!assessment.configured) return { skipped: assessment.reason || 'GitHub is not configured' };
  if (assessment.pending) return { skipped: 'GitHub did not respond in time' };

  const current = assessment.waiting.filter((e) => e.overSla && !e.stale);
  const teamRequests = current.filter((e) => e.kind === 'team').length;

  const byMember = new Map();
  const unlinked = new Set();
  for (const e of current.filter((x) => x.kind === 'reviewer')) {
    if (!e.member || !e.member.slackUserId) { unlinked.add(e.reviewer.toLowerCase()); continue; }
    if (!byMember.has(e.member.id)) byMember.set(e.member.id, { member: e.member, items: [] });
    byMember.get(e.member.id).items.push(e);
  }

  const today = toDateStr(new Date());
  let sent = 0;
  let heldOrDuplicate = 0;

  for (const { member, items } of byMember.values()) {
    const outcome = await notifier.sendDM({
      orgId,
      slackUserId: member.slackUserId,
      text: buildDigest(member.name, items),
      dedupeKey: `pr-review-digest:${member.id}:${today}`,
      type: 'pr_review_digest',
      userName: member.name,
      action: `Review digest sent (${items.length} pull request${items.length === 1 ? '' : 's'})`,
    });
    if (outcome.sent) sent++; else heldOrDuplicate++;
  }

  return {
    reviewers: byMember.size,
    sent,
    heldOrDuplicate,
    reviewersNotLinked: unlinked.size,
    teamRequestsLeftToLead: teamRequests,
  };
}

module.exports = {
  key:         'pr-review-nudge',
  name:        'Review digest',
  description: 'One message a day to each person who owes pull request reviews past the SLA. Off by default; the same waits already appear in your daily brief.',
  category:    'code',
  audience:    'reviewer',
  defaultEnabled: false,
  schedule: (cfg) => onDays(cfg.reviewNudgeTime, '10:30', cfg.workdays || '1-5'),
  run,
  buildDigest,
};
