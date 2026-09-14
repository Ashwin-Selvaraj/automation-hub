'use strict';

const jiraService        = require('../../services/jiraService');
const claudeService      = require('../../services/claudeService');
const performanceService = require('../../services/performanceService');
const sprintRepo         = require('../../repositories/sprintRepository');
const notifier           = require('../../core/notifier');
const { onDays }         = require('../schedule');

/**
 * Scans for overdue Jira issues and tells the assignee.
 *
 * This is one of the two person-facing messages worth keeping: it is about the
 * recipient's own work, it arrives before anyone else escalates it, and it is
 * something they would want to know.
 */

function toDateStr(d) {
  return d.toISOString().substring(0, 10);
}

async function run({ orgId, cfg }) {
  const sprint   = await sprintRepo.getActiveSprint(orgId);
  const sprintId = sprint ? sprint.id : null;

  if (sprintId) {
    await performanceService.runDailyDeadlineCheck(orgId, sprintId);
    return { mode: 'sprint', sprintId };
  }

  // No sprint recorded yet — ask Jira directly.
  const overdue = await jiraService.getOverdueIssues(cfg.projectKey);
  const today   = toDateStr(new Date());
  let sent = 0;

  for (const issue of overdue) {
    try {
      if (!issue.assigneeEmail) continue;
      const member = cfg.teamMembers.find(
        (m) => m.email === issue.assigneeEmail || (issue.assigneeName && m.name === issue.assigneeName)
      );
      if (!member) continue;

      const issueUrl = `${(process.env.JIRA_SITE_URL || '').replace(/\/$/, '')}/browse/${issue.key}`;
      const dmText = await claudeService.draftDeadlineDM(
        member.name, issue.key, issue.summary, issue.daysOverdue, issueUrl
      );

      const outcome = await notifier.sendDM({
        orgId, slackUserId: member.id, text: dmText,
        dedupeKey: `deadline-dm:${member.id}:${issue.key}:${today}`,
        type: 'deadline_dm', userName: member.name,
        action: `Deadline DM sent (${issue.daysOverdue} days overdue)`,
      });
      if (outcome.sent) sent++;
    } catch (err) {
      console.error(`[deadline-check] error for ${issue.key}:`, err.message);
    }
  }

  return { mode: 'jira-direct', overdue: overdue.length, sent };
}

module.exports = {
  key:         'deadline-check',
  name:        'Overdue task alerts',
  description: "DMs the assignee when a task passes its due date, before it becomes someone else's escalation.",
  category:    'delivery',
  audience:    'member',
  defaultEnabled: true,
  schedule: (cfg) => onDays(cfg.deadlineTime, '09:00', cfg.workdays || '1-5'),
  run,
};
