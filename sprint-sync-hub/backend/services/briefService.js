'use strict';

const briefRepo   = require('../repositories/briefRepository');
const sprintRepo  = require('../repositories/sprintRepository');
const memberRoleRepository = require('../repositories/memberRoleRepository');
const attendanceService = require('./attendanceService');
const deliveryRiskService = require('./deliveryRiskService');
const prReviewService = require('./prReviewService');
const slackText = require('../utils/slackText');
const claudeService = require('./claudeService');
const { getSprintWindow } = require('../utils/dateUtils');
const { dateOnlyString, todayInZone } = require('../utils/dateOnly');
const configService = require('./configService');

/**
 * The daily lead brief.
 *
 * This replaces five automations that each messaged an individual engineer to
 * tell them they were out of compliance. Those produced compliance, not
 * information: people learned to write the standup that satisfied the matcher.
 * The same signals, collected and handed to one person who can act on them,
 * answer the questions a lead actually has on a Tuesday morning — who is stuck,
 * what is going to slip, and what to raise in the next conversation.
 *
 * Structure is assembled from database facts. Only two things go through the
 * model: extracting blockers from free-text standups, and the one-line "look at
 * this first" call. Everything else is a query, so it cannot be hallucinated.
 */

const STALE_DAYS    = 3;
const DUE_SOON_DAYS = 2;

function toDateStr(d) {
  return d.toISOString().substring(0, 10);
}

function yesterdayOf(date) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return toDateStr(d);
}

/** Working days left in the sprint, counting today. Both dates are YYYY-MM-DD. */
function workingDaysRemaining(endDate, todayStr) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const cursor = new Date(`${todayStr}T00:00:00.000Z`);
  let count = 0;
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * Gathers every signal for a given day.
 *
 * @param {number} organisationId
 * @param {object} [opts]
 * @param {string} [opts.date]      Defaults to today.
 * @param {boolean} [opts.withFocus] Whether to ask the model for the focus line.
 */
async function collect(organisationId, {
  date,
  withFocus = true,
  // How long to wait for GitHub. A page load should never stall on it; the
  // morning DM passes a long budget and demands fresh data.
  reviewBudgetMs = 4000,
  freshReviews = false,
} = {}) {
  const timeZone = configService.getSprintConfig().timezone;
  // The team's today, not UTC's: before 05:30 in Kolkata the UTC date is still yesterday.
  const today  = date || todayInZone(timeZone);
  const sprint = await sprintRepo.getActiveSprint(organisationId);
  const sprintId = sprint ? sprint.id : null;

  const [
    standups, silent, overdue, dueSoon, stale, mismatches, progress, managerialKeys,
  ] = await Promise.all([
    briefRepo.standupsOn(organisationId, today),
    briefRepo.silentOn(organisationId, today),
    briefRepo.overdueTasks(organisationId, sprintId),
    briefRepo.dueSoon(organisationId, sprintId, DUE_SOON_DAYS),
    briefRepo.staleInProgress(organisationId, sprintId, STALE_DAYS),
    briefRepo.openMismatches(organisationId, yesterdayOf(today)),
    briefRepo.sprintProgress(organisationId, sprintId),
    memberRoleRepository.getManagerialMemberKeys(organisationId),
  ]);

  // The brief reports on individual contributors. A lead does not need to be
  // told they themselves did not post a standup.
  const isTracked = (name) => !managerialKeys.names.has(name);

  // Someone recorded absent is not silent — they are off. Only positive
  // evidence of absence counts; "no signal" is not absence.
  let absentNames = new Set();
  try {
    const attendance = await attendanceService.getTodayAttendance(organisationId);
    absentNames = new Set(
      (attendance.members || [])
        .filter((m) => m.attendanceKnown && !m.checkedIn)
        .map((m) => m.name)
    );
  } catch (err) {
    console.warn('[brief] attendance lookup failed, treating everyone as present:', err.message);
  }

  // Delivery risk rides along in the brief rather than becoming three more
  // messages. A lead who gets a separate DM for the forecast, one for WIP and
  // one for scope creep is back to being paged all morning.
  //
  // Pull requests waiting on review are read at the same time, so a slow GitHub
  // adds nothing to the time it takes to build the rest.
  const [risk, reviews] = await Promise.all([
    deliveryRiskService.assess(organisationId).catch((err) => {
      console.warn('[brief] delivery risk assessment failed:', err.message);
      return null;
    }),
    prReviewService.assessWithin(organisationId, {
      budgetMs: reviewBudgetMs,
      ...(freshReviews ? { maxAgeMs: 0 } : {}),
    }).catch((err) => {
      console.warn('[brief] review assessment failed:', err.message);
      return null;
    }),
  ]);
  const review = summariseReviews(reviews);

  let blockers = [];
  const updates = standups
    .filter((s) => isTracked(s.name) && s.message_text)
    .map((s) => ({ name: s.name, text: s.message_text }));
  if (updates.length > 0) {
    try {
      blockers = await claudeService.extractBlockers(updates);
    } catch (err) {
      console.warn('[brief] blocker extraction failed:', err.message);
    }
  }

  const unmatched = standups.filter((s) => isTracked(s.name) && !s.matched_task_id);
  const silentToday = silent.filter((m) => isTracked(m.name) && !absentNames.has(m.name));

  const window = getSprintWindow();
  const sprintEnd = (sprint && dateOnlyString(sprint.end_date)) || window.endStr;
  const daysLeft  = workingDaysRemaining(sprintEnd, todayInZone(timeZone));

  const signals = {
    date: today,
    sprint: sprint ? sprint.name : null,
    daysLeft,
    progress,
    blockers,
    overdue:    overdue.map((t)  => ({ key: t.jira_key, title: t.title, assignee: t.assignee, daysOverdue: Number(t.days_overdue) })),
    dueSoon:    dueSoon.map((t)  => ({ key: t.jira_key, title: t.title, assignee: t.assignee, status: t.status, daysUntil: Number(t.days_until) })),
    stale:      stale.map((t)    => ({ key: t.jira_key, title: t.title, assignee: t.assignee, status: t.status, lastMovement: t.last_movement })),
    offPlan:    mismatches.map((m) => ({ name: m.name, detail: m.mismatch_details, key: m.matched_issue_key, type: m.match_type })),
    noUpdate:   silentToday.map((m) => m.name),
    unmatched:  unmatched.map((s) => s.name),
    absent:     [...absentNames],
    postedCount: standups.filter((s) => isTracked(s.name)).length,
    forecast:   risk ? risk.forecast : null,
    wip:        risk ? risk.wip : [],
    wipLimit:   risk ? risk.wipLimit : null,
    scopeAdded: risk ? risk.scopeAdded : [],
    scopeAddedShare: risk ? risk.scopeAddedShare : null,
    ...review,
  };

  if (withFocus && hasAnythingToSay(signals)) {
    try {
      signals.focus = await claudeService.summariseBriefFocus(signals);
    } catch (err) {
      console.warn('[brief] focus line failed:', err.message);
    }
  }

  return signals;
}

/** Who a pull request is waiting on, as a lead would say it. */
function reviewerLabel(entry) {
  if (entry.kind === 'team') return `team ${entry.team}`;
  if (entry.member) return entry.member.name;
  return `@${entry.reviewer}`;
}

/**
 * Reduces an assessment to what the brief shows. A wait is shown individually
 * only when it is over the SLA and not parked; parked ones (waiting so long they
 * are probably abandoned) are counted, not listed, so a handful of months-old
 * pull requests can't bury the ones that are actually blocking someone.
 *
 * Returns the same keys whether or not GitHub is configured, so nothing
 * downstream has to guard against them being missing.
 */
function summariseReviews(a) {
  const empty = {
    reviewsConfigured: false, reviewWaiting: [], reviewUnassigned: [], reviewParked: 0,
    reviewSlaHours: null, reviewStaleDays: null, reviewErrors: [], reviewsPending: false, reviewsStale: false,
  };
  if (!a || !a.configured) return empty;

  const live = (list) => list.filter((e) => e.overSla && !e.stale);
  const pick = (e) => ({
    repo: e.repo, number: e.number, title: e.title, url: e.url, author: e.author,
    who: e.kind === 'unassigned' ? null : reviewerLabel(e),
    waitingHours: e.waitingHours, kind: e.kind,
  });

  return {
    reviewsConfigured: true,
    reviewWaiting:    live(a.waiting).map(pick),
    reviewUnassigned: live(a.unassigned).map(pick),
    reviewParked: [...a.waiting, ...a.unassigned].filter((e) => e.overSla && e.stale).length,
    reviewSlaHours: a.slaHours,
    reviewStaleDays: a.staleDays,
    reviewErrors: a.errors || [],
    reviewsPending: Boolean(a.pending),
    reviewsStale: Boolean(a.stale),
  };
}

function hasAnythingToSay(s) {
  return s.blockers.length > 0 || s.overdue.length > 0 || s.stale.length > 0 ||
         s.offPlan.length > 0 || s.noUpdate.length > 0 || s.unmatched.length > 0 ||
         s.dueSoon.length > 0 || (s.wip || []).length > 0 ||
         (s.reviewWaiting || []).length > 0 || (s.reviewUnassigned || []).length > 0 ||
         ['at-risk', 'stalled'].includes(s.forecast?.status);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The "waiting on review" section, as lines. Empty when there is nothing to say. */
function renderReviews(s) {
  if (!s.reviewsConfigured) return [];

  const waiting    = s.reviewWaiting || [];
  const unassigned = s.reviewUnassigned || [];
  const total = waiting.length + unassigned.length;
  const out = [];

  const hours = (h) => `${Math.round(h)} working ${Math.round(h) === 1 ? 'hour' : 'hours'}`;
  const ref = (e) => `${slackText.link(e.url, `${e.repo}#${e.number} ${e.title}`, { max: 70 })}`;

  if (total > 0 || s.reviewParked > 0) {
    out.push('', `*🔍 Waiting on review — ${total}*`);
    const items = [
      ...waiting.map((e) => `• ${ref(e)} — waiting on *${slackText.escape(e.who)}* for ${hours(e.waitingHours)}`),
      ...unassigned.map((e) => `• ${ref(e)} — nobody asked to review it yet, ${hours(e.waitingHours)}`),
    ];
    out.push(...items.slice(0, 8));
    if (items.length > 8) out.push(`_…and ${items.length - 8} more_`);
    if (total > 0) out.push(`_Past the ${s.reviewSlaHours} working-hour mark._`);
    if (s.reviewParked > 0) {
      out.push(`_${s.reviewParked} more ${s.reviewParked === 1 ? 'has' : 'have'} been waiting over ${s.reviewStaleDays} working days — likely parked, so not listed._`);
    }
  }

  // A silent failure would read as "nothing is waiting", which is the one thing
  // a lead must not be told wrongly.
  if ((s.reviewErrors || []).length > 0) {
    const detail = s.reviewErrors.map((e) =>
      `${slackText.escape(e.repo)} (${e.skippedPullRequests ? `${e.skippedPullRequests} pull request${e.skippedPullRequests === 1 ? '' : 's'} couldn't be read` : slackText.escape(slackText.truncate(e.error, 90))})`
    ).join('; ');
    out.push('', `_⚠ Review waits are incomplete — ${detail}._`);
  }
  if (s.reviewsPending) out.push('', '_Review data is still loading from GitHub — refresh in a moment._');

  return out;
}

/** Renders the collected signals as Slack mrkdwn. */
function render(s) {
  const when = new Date(`${s.date}T00:00:00.000Z`)
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  const lines = [`*Daily brief — ${when}*`];

  if (s.focus) lines.push('', `_${s.focus}_`);

  if (s.blockers.length) {
    lines.push('', `*⛔ Blocked — ${s.blockers.length}*`);
    for (const b of s.blockers) {
      lines.push(`• *${b.name}* — ${b.summary}${b.waitingOn ? ` _(waiting on ${b.waitingOn})_` : ''}`);
    }
  }

  if (s.overdue.length) {
    lines.push('', `*⏰ Overdue — ${s.overdue.length}*`);
    for (const t of s.overdue.slice(0, 8)) {
      lines.push(`• ${t.key} ${t.title} — ${t.assignee || 'unassigned'}, ${plural(t.daysOverdue, 'day', 'days')} late`);
    }
    if (s.overdue.length > 8) lines.push(`_…and ${s.overdue.length - 8} more_`);
  }

  if (s.dueSoon.length) {
    lines.push('', `*📅 Due in the next ${DUE_SOON_DAYS} days — ${s.dueSoon.length}*`);
    for (const t of s.dueSoon.slice(0, 6)) {
      const when2 = t.daysUntil === 0 ? 'today' : t.daysUntil === 1 ? 'tomorrow' : `in ${t.daysUntil} days`;
      lines.push(`• ${t.key} ${t.title} — ${t.assignee || 'unassigned'}, ${when2} (${t.status})`);
    }
  }

  if (s.stale.length) {
    lines.push('', `*🕰 No movement in ${STALE_DAYS}+ days — ${s.stale.length}*`);
    for (const t of s.stale.slice(0, 6)) {
      lines.push(`• ${t.key} ${t.title} — ${t.assignee || 'unassigned'} (${t.status})`);
    }
  }

  if (s.offPlan.length) {
    lines.push('', `*🔀 Off-plan work — ${s.offPlan.length}*`);
    for (const m of s.offPlan.slice(0, 6)) {
      lines.push(`• *${m.name}* — ${m.detail || m.type}${m.key ? ` (${m.key})` : ''}`);
    }
  }

  lines.push(...renderReviews(s));

  if ((s.wip || []).length) {
    lines.push('', `*🧺 Holding more than ${s.wipLimit} things at once — ${s.wip.length}*`);
    for (const p of s.wip) {
      lines.push(`• *${p.name}* — ${p.inFlight} in flight: ${p.keys.join(', ')}`);
    }
  }

  if ((s.scopeAdded || []).length) {
    const share = s.scopeAddedShare != null ? ` (${s.scopeAddedShare}% of the sprint)` : '';
    lines.push('', `*➕ Added after the sprint started — ${s.scopeAdded.length}${share}*`);
    for (const t of s.scopeAdded.slice(0, 6)) {
      lines.push(`• ${t.key} ${t.title} — ${t.assignee || 'unassigned'}, added ${t.addedOn}${t.done ? ' (done)' : ''}`);
    }
    if (s.scopeAdded.length > 6) lines.push(`_…and ${s.scopeAdded.length - 6} more_`);
  }

  if (s.noUpdate.length || s.unmatched.length) {
    lines.push('', '*🔇 Quiet today*');
    if (s.noUpdate.length)  lines.push(`• No standup: ${s.noUpdate.join(', ')}`);
    if (s.unmatched.length) lines.push(`• Posted, nothing matched a task: ${s.unmatched.join(', ')}`);
    lines.push('_Context, not a to-do list — the bot has not messaged anyone about this._');
  }

  if (s.forecast && s.forecast.status !== 'no-data') {
    const icon = { 'at-risk': '📉', stalled: '🛑', 'on-track': '📈', 'too-early': '📊' }[s.forecast.status] || '📊';
    lines.push('', `*${icon} Forecast* — ${s.forecast.summary}`);
  } else if (s.progress && s.progress.total > 0) {
    lines.push('', `*📊 Sprint* — ${s.progress.done} of ${s.progress.total} done, ${s.progress.notStarted} not started, ${plural(s.daysLeft, 'working day', 'working days')} left`);
  }

  if (lines.length === 1) {
    lines.push('', 'Nothing needs your attention this morning. No blockers, nothing overdue, nothing stalled.');
  }

  return lines.join('\n');
}

module.exports = { collect, render, summariseReviews, STALE_DAYS, DUE_SOON_DAYS };
