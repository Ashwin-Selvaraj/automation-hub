'use strict';

const jiraService        = require('../../services/jiraService');
const performanceService = require('../../services/performanceService');
const taskRepo           = require('../../repositories/taskRepository');
const memberRepo         = require('../../repositories/memberRepository');
const sprintRepo         = require('../../repositories/sprintRepository');
const notifRepo          = require('../../repositories/notificationRepository');
const notifier           = require('../../core/notifier');
const idempotency        = require('../../core/idempotency');
const slackText          = require('../../utils/slackText');
const { dateOnlyString, todayInZone } = require('../../utils/dateOnly');
const { onDays }         = require('../schedule');

/**
 * Tells people about tasks of theirs that are past their due date.
 *
 * It is one of the two person-facing messages worth keeping, because it is about
 * the recipient's own work and is something they would want to know. What it used
 * to do around that was not worth keeping, and is gone:
 *
 *  - one DM per overdue task, repeated every day while it stayed overdue — a
 *    person with six overdue tasks got six messages a day, indefinitely;
 *  - a second "critically overdue, update its status immediately" DM after three
 *    days;
 *  - a DM to the manager that the lead never saw first.
 *
 * Now it is one digest per person per day, each task is mentioned at most once a
 * week, nobody is escalated to, and the wording is fixed text rather than a model
 * call per task. The lead sees all overdue work in the daily brief and decides
 * what, if anything, needs a conversation.
 */

const MAX_LISTED = 8;
const WEEKLY_CLAIM_HOURS = 8 * 24;

function jiraBase() {
  return String(process.env.JIRA_SITE_URL || '').replace(/\/+$/, '');
}

/** Monday of the week containing a YYYY-MM-DD date, as YYYY-MM-DD. */
function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().substring(0, 10);
}

/** Whole calendar days from `dueDate` to `today` (both YYYY-MM-DD). */
function daysPast(dueDate, today) {
  return Math.round((new Date(`${today}T00:00:00.000Z`) - new Date(`${dueDate}T00:00:00.000Z`)) / 86_400_000);
}

// A fixed table rather than toLocaleDateString: the abbreviation for September is
// "Sept" or "Sep" depending on which ICU data the Node build ships, so a message
// formatted through the locale would read differently from host to host.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function humanDate(dateStr) {
  const [, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/** The message for one person. Pure, so the wording can be tested. */
function buildDigest({ name, tasks, today, more = 0 }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const n = tasks.length;

  const lines = tasks.map((t) => {
    const url = jiraBase() ? `${jiraBase()}/browse/${t.taskKey}` : '';
    const ago = daysPast(t.dueDate, today);
    return `• ${slackText.link(url, `${t.taskKey} ${t.title}`, { max: 70 })} — due ${humanDate(t.dueDate)} (${ago} ${ago === 1 ? 'day' : 'days'} ago)`;
  });
  if (more > 0) lines.push(`_…and ${more} more_`);

  return [
    `Hi ${slackText.escape(first)} 👋 ${n === 1 ? '1 task has' : `${n} tasks have`} passed ${n === 1 ? 'its' : 'their'} due date:`,
    '',
    ...lines,
    '',
    'If a date has simply moved, updating it in Jira is enough. — Sprint-Sync Hub',
  ].join('\n');
}

/** Overdue work from Jira directly, for when there is no active sprint in the database. */
async function overdueFromJira(orgId, cfg) {
  const issues = await jiraService.getOverdueIssues(cfg.projectKey);
  const members = await memberRepo.findAll(orgId);
  const items = [];
  for (const issue of issues) {
    const member = members.find((m) =>
      (issue.assigneeEmail && m.email && m.email.toLowerCase() === issue.assigneeEmail.toLowerCase()) ||
      (issue.assigneeName && m.name === issue.assigneeName));
    const dueDate = dateOnlyString(issue.duedate);
    if (!member || !dueDate) continue;
    items.push({
      taskKey: issue.key, taskId: null, title: issue.summary, dueDate,
      memberId: member.id, name: member.name, slackUserId: member.slack_user_id,
    });
  }
  return items;
}

async function deliver(orgId, items, today) {
  const byMember = new Map();
  for (const item of items) {
    if (!byMember.has(item.memberId)) byMember.set(item.memberId, []);
    byMember.get(item.memberId).push(item);
  }

  const out = {
    overdueTasks: items.length, people: byMember.size,
    sent: 0, held: 0, tasksMentioned: 0,
    alreadyToldThisWeek: 0, skippedManagerial: 0, skippedNoSlack: 0,
  };
  const week = weekStart(today);

  for (const [memberId, all] of byMember) {
    const first = all[0];
    if (!first.slackUserId) { out.skippedNoSlack++; continue; }
    // Managerial-only members are not messaged about their own tasks; the lead
    // sees every overdue task in the daily brief regardless.
    if (!await performanceService.shouldSendTaskDM(memberId)) { out.skippedManagerial++; continue; }

    const ordered = [...all].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const shown = ordered.slice(0, MAX_LISTED);

    // Each task is mentioned once a week: claim it before listing it.
    const claimed = [];
    for (const task of shown) {
      if (await idempotency.claim(orgId, `deadline-task:${task.taskKey}:${week}`, WEEKLY_CLAIM_HOURS)) claimed.push(task);
    }
    if (claimed.length === 0) { out.alreadyToldThisWeek++; continue; }

    const outcome = await notifier.sendDM({
      orgId,
      slackUserId: first.slackUserId,
      text: buildDigest({ name: first.name, tasks: claimed, today, more: ordered.length - shown.length }),
      dedupeKey: `deadline-digest:${memberId}:${today}`,
      type: 'deadline_dm',
      userName: first.name,
      action: `Past-due digest sent (${claimed.length} task${claimed.length === 1 ? '' : 's'})`,
    });

    if (outcome.sent) {
      out.sent++;
      out.tasksMentioned += claimed.length;
      // Keeps the per-person notification history on the Performance tab.
      for (const task of claimed) {
        await notifRepo.recordNotification(orgId, memberId, 'deadline_reminder', 'dm', task.taskId).catch(() => {});
      }
    } else {
      out.held++;
      // The message did not go, so these tasks have not really been mentioned.
      for (const task of claimed) await idempotency.release(orgId, `deadline-task:${task.taskKey}:${week}`);
    }
  }
  return out;
}

async function run({ orgId, cfg }) {
  const sprint = await sprintRepo.getActiveSprint(orgId);
  const today  = todayInZone(cfg.timezone);

  let items;
  if (sprint) {
    // Bookkeeping that feeds the performance score; sends nothing.
    await performanceService.recordDeadlineMisses(orgId, sprint.id);
    const rows = await taskRepo.getOverdueTasks(orgId, sprint.id, today);
    items = rows
      .filter((r) => r.assignee_id && dateOnlyString(r.due_date))
      .map((r) => ({
        taskKey: r.jira_key, taskId: r.id, title: r.title, dueDate: dateOnlyString(r.due_date),
        memberId: r.assignee_id, name: r.assignee_name, slackUserId: r.slack_user_id,
      }));
  } else {
    items = await overdueFromJira(orgId, cfg);
  }

  return deliver(orgId, items, today);
}

module.exports = {
  key:         'deadline-check',
  name:        'Past-due task digest',
  description: "One message a day to each person with tasks past their due date — a single digest, each task mentioned once a week, and nobody is escalated to. You see all of it in your daily brief.",
  category:    'delivery',
  audience:    'member',
  defaultEnabled: true,
  schedule: (cfg) => onDays(cfg.deadlineTime, '09:00', cfg.workdays || '1-5'),
  run,
  buildDigest, weekStart, daysPast,
};
