'use strict';

const db          = require('../../db');
const jiraService = require('../../services/jiraService');
const taskRepo    = require('../../repositories/taskRepository');
const memberRepo  = require('../../repositories/memberRepository');
const sprintRepo  = require('../../repositories/sprintRepository');
const auditLog    = require('../../core/auditLog');
const cursorStore = require('../../core/cursor');
const idempotency = require('../../core/idempotency');
const { dateInZone } = require('../../utils/dateOnly');
const crypto = require('crypto');

/**
 * Keeps the `tasks` table in step with Jira.
 *
 * Until this existed, `tasks` was written only by the in-app sprint planner. Jira
 * issues created or changed anywhere else were read each day for matching and
 * then thrown away, so everything built on `tasks` — the overdue and stalled
 * lists, the forecast, WIP, scope creep, the standup matcher's idea of which
 * tasks are "yours" — only ever saw planner-created work. A normal Jira task was
 * classified as somebody else's and raised a false mismatch.
 *
 * It also fixes what "completed" means. The old completion time was when this
 * system first noticed a task was Done. Jira's own resolution date is used now,
 * so a task finished months ago and first seen today is dated when it was
 * finished — which a performance review depends on.
 *
 * Failures are meant to be loud. If the sprint field is not found, or the read is
 * cut short, that is written to the activity log as a failure rather than left to
 * show up later as a quietly incomplete brief.
 */

// Held for the duration of a run, so a manual "Run now" and the schedule cannot
// write the same issues at once.
const SYNC_LOCK = 4711002;

const COVERS_FROM_KEY = 'jira_task_sync:covers_from';

function lookbackDays() {
  const n = Math.floor(Number(process.env.JIRA_SYNC_LOOKBACK_DAYS));
  return Number.isFinite(n) && n > 0 ? Math.min(730, n) : 120;
}

function jiraConfigured(cfg) {
  return Boolean(
    process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_SITE_URL && cfg.projectKey
  );
}

/**
 * Which sprint a task should be attached to.
 *
 * Only the ACTIVE Jira sprint attaches, to the active sprint in our database.
 * Anything else — backlog, a closed sprint, a future one — leaves the task's
 * existing attachment alone (undefined), rather than guessing a sprint for it.
 */
function chooseSprint(issue, activeSprintId) {
  if (!activeSprintId) return undefined;
  return issue.sprints.some((s) => s.state === 'active') ? activeSprintId : undefined;
}

/** Builds lookups from Jira identity to our member id. Account id wins; email is the fallback. */
function buildMemberIndex(members) {
  const byAccount = new Map();
  const byEmail = new Map();
  for (const m of members) {
    if (m.jira_account_id) byAccount.set(m.jira_account_id, m.id);
    if (m.email) byEmail.set(String(m.email).toLowerCase(), m.id);
  }
  return (issue) => {
    if (issue.assigneeAccountId && byAccount.has(issue.assigneeAccountId)) return byAccount.get(issue.assigneeAccountId);
    if (issue.assigneeEmail && byEmail.has(issue.assigneeEmail.toLowerCase())) return byEmail.get(issue.assigneeEmail.toLowerCase());
    return null;
  };
}

async function run({ orgId, cfg }) {
  if (!jiraConfigured(cfg)) return { skipped: 'Jira is not configured' };

  const lock = await db.query('SELECT pg_try_advisory_lock($1) AS acquired', [SYNC_LOCK]);
  if (!lock.rows[0].acquired) return { skipped: 'another sync is already running' };

  try {
    return await sync(orgId, cfg);
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK]).catch(() => {});
  }
}

async function sync(orgId, cfg) {
  const days = lookbackDays();
  const { issues, truncated, sprintField } = await jiraService.listProjectIssues(cfg.projectKey, { sinceDays: days });

  const members = await memberRepo.findAll(orgId);
  const memberFor = buildMemberIndex(members);
  const sprint = await sprintRepo.getActiveSprint(orgId);
  const activeSprintId = sprint ? sprint.id : null;

  const counts = {
    fetched: issues.length, created: 0, updated: 0, failed: 0,
    done: 0, attachedToActiveSprint: 0,
    assignedOutsideTeam: 0, unassigned: 0,
  };

  let firstFailure = null;

  for (const issue of issues) {
    const assigneeId = memberFor(issue);
    if (!issue.assigneeAccountId && !issue.assigneeEmail && !issue.assigneeName) counts.unassigned++;
    else if (!assigneeId) counts.assignedOutsideTeam++;

    const sprintId = chooseSprint(issue, activeSprintId);
    if (sprintId) counts.attachedToActiveSprint++;
    if (issue.isDone) counts.done++;

    try {
      const result = await taskRepo.syncFromJira(orgId, {
        jiraKey: issue.key,
        title: issue.summary,
        status: issue.status,
        priority: issue.priority,
        assigneeId,
        dueDate: issue.duedate,
        // The day it was created in the team's calendar, not the UTC date.
        createdOn: issue.created ? dateInZone(issue.created, cfg.timezone) : null,
        updatedAt: issue.updated,
        issueType: issue.issueType,
        isDone: issue.isDone,
        resolvedAt: issue.resolved,
        sprintId,
      });
      if (result.inserted) counts.created++; else counts.updated++;
    } catch (err) {
      // One bad issue must not abort the rest; it is counted and reported.
      counts.failed++;
      if (!firstFailure) firstFailure = { key: issue.key, message: err.message };
    }
  }

  // ── Say so loudly when the picture may be incomplete ──────────────────────
  const warnings = [];

  if (truncated) {
    warnings.push(`Jira returned more issues than the sync reads in one run; only the ${issues.length} most recently updated were synced.`);
  }
  if (issues.length > 0 && !issues.some((i) => i.sprintFieldPresent)) {
    warnings.push(`None of the ${issues.length} issues carried the sprint field "${sprintField}", so none could be attached to the active sprint. Set JIRA_SPRINT_FIELD to this instance's Sprint field id.`);
  }
  if (!activeSprintId) {
    warnings.push('There is no active sprint in the database, so no issue was attached to one.');
  }
  if (counts.failed > 0) {
    warnings.push(`${counts.failed} issue${counts.failed === 1 ? '' : 's'} could not be saved — for example ${firstFailure.key}: ${firstFailure.message}`);
  }
  if (counts.assignedOutsideTeam > 0 && counts.assignedOutsideTeam >= issues.length * 0.5) {
    warnings.push(`${counts.assignedOutsideTeam} of ${issues.length} issues are assigned to people who are not linked to a team member. Run the member Jira-ID sync, or set IDs on the Team tab.`);
  }

  // The sync runs hourly. A condition that persists (no active sprint, a wrong
  // sprint field) would otherwise write the same warning twenty-four times a day
  // and bury everything else in the log, so each distinct warning is recorded once
  // per day.
  const today = dateInZone(new Date(), cfg.timezone);
  for (const message of warnings) {
    const digest = crypto.createHash('sha1').update(message).digest('hex').slice(0, 12);
    if (await idempotency.claim(orgId, `jira-task-sync-warning:${digest}:${today}`, 24)) {
      auditLog.record(orgId, { type: 'jira_task_sync', action: 'Jira task sync warning', success: false, details: message });
    }
  }

  // ── How far back the data goes ────────────────────────────────────────────
  // Recorded only for a complete read, so a later report can say honestly how
  // far back its figures can be trusted.
  if (!truncated) {
    const fromStr = dateInZone(new Date(Date.now() - days * 86_400_000), cfg.timezone);
    const existing = await cursorStore.get(orgId, COVERS_FROM_KEY);
    if (!existing || fromStr < existing) await cursorStore.set(orgId, COVERS_FROM_KEY, fromStr);
  }

  return { ...counts, lookbackDays: days, truncated, warnings };
}

module.exports = {
  key:         'jira-task-sync',
  name:        'Jira task sync',
  description: 'Keeps the task list in step with Jira each hour — status, assignee, due date and when each task was really finished — so every report reads real work, not only tasks created in the planner.',
  category:    'delivery',
  audience:    'system',
  defaultEnabled: true,
  schedule: () => '5 * * * *',
  run,
  chooseSprint,
  buildMemberIndex,
  COVERS_FROM_KEY,
};
