'use strict';

const briefRepo   = require('../repositories/briefRepository');
const sprintRepo  = require('../repositories/sprintRepository');
const memberRoleRepository = require('../repositories/memberRoleRepository');
const attendanceService = require('./attendanceService');
const deliveryRiskService = require('./deliveryRiskService');
const claudeService = require('./claudeService');
const { getSprintWindow } = require('../utils/dateUtils');

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

/** Working days left in the sprint, counting today. */
function workingDaysRemaining(endDate) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
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
async function collect(organisationId, { date, withFocus = true } = {}) {
  const today  = date || toDateStr(new Date());
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
  let risk = null;
  try {
    risk = await deliveryRiskService.assess(organisationId);
  } catch (err) {
    console.warn('[brief] delivery risk assessment failed:', err.message);
  }

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
  const daysLeft = sprint ? workingDaysRemaining(sprint.end_date ? toDateStr(new Date(sprint.end_date)) : window.endStr)
                          : workingDaysRemaining(window.endStr);

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

function hasAnythingToSay(s) {
  return s.blockers.length > 0 || s.overdue.length > 0 || s.stale.length > 0 ||
         s.offPlan.length > 0 || s.noUpdate.length > 0 || s.unmatched.length > 0 ||
         s.dueSoon.length > 0 || (s.wip || []).length > 0 ||
         ['at-risk', 'stalled'].includes(s.forecast?.status);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
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

module.exports = { collect, render, STALE_DAYS, DUE_SOON_DAYS };
