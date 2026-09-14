'use strict';

const slackService       = require('../../services/slackService');
const jiraService        = require('../../services/jiraService');
const claudeService      = require('../../services/claudeService');
const performanceService = require('../../services/performanceService');
const memberRepo         = require('../../repositories/memberRepository');
const notifRepo          = require('../../repositories/notificationRepository');
const sprintRepo         = require('../../repositories/sprintRepository');
const memberRoleRepository = require('../../repositories/memberRoleRepository');
const { getSprintWindow } = require('../../utils/dateUtils');
const notifier   = require('../../core/notifier');
const { weekly } = require('../schedule');

/**
 * Compiles the sprint's activity into a Claude-written summary, posts it to the
 * team channel, and sends the manager a copy.
 */

function toDateStr(d) {
  return d.toISOString().substring(0, 10);
}

async function run({ orgId, cfg }) {
  const { start, startStr, endStr } = getSprintWindow();
  const sprint   = await sprintRepo.getActiveSprint(orgId);
  const sprintId = sprint ? sprint.id : null;

  let leaderboard = [];
  let atRisk      = [];
  if (sprintId) {
    await performanceService.refreshAllMemberSummaries(orgId, sprintId);
    leaderboard = await performanceService.getTeamLeaderboard(orgId, sprintId);
    atRisk      = await performanceService.getAtRiskMembers(orgId, sprintId);
  }

  const [messages, jiraTasks, managerialKeys] = await Promise.all([
    slackService.getChannelMessages(cfg.channelId, start.getTime() / 1000, Date.now() / 1000),
    jiraService.getSprintIssues(cfg.projectKey, startStr, endStr),
    memberRoleRepository.getManagerialMemberKeys(orgId),
  ]);

  // Activity tracking covers individual contributors only.
  const tracked = cfg.teamMembers.filter((m) => !managerialKeys.slackUserIds.has(m.id));
  const memberActivity = tracked.map((m) => {
    const theirs = messages.filter((msg) => msg.user === m.id);
    return {
      name: m.name,
      updateCount: theirs.length,
      updates: theirs.map((msg) => (msg.text || '').substring(0, 120)),
    };
  });

  const report = await claudeService.generateWeeklyReport(
    'Full Sprint', memberActivity, jiraTasks, cfg.sprintName, { leaderboard, atRisk }
  );

  const week = toDateStr(new Date());
  const posted = await notifier.postToChannel({
    orgId, channelId: cfg.channelId, text: report,
    dedupeKey: `weekly-report:channel:${week}`,
    type: 'report_posted', action: 'Weekly report posted',
  });

  let managerNotified = false;
  if (cfg.managerSlackId) {
    const dm = await notifier.sendDM({
      orgId, slackUserId: cfg.managerSlackId, text: report,
      dedupeKey: `weekly-report:manager:${week}`,
      type: 'report_posted', action: 'Weekly report sent to manager',
      urgent: true, // a scheduled report should go out at its scheduled time
    });
    managerNotified = dm.sent;
  }

  if (sprintId && posted.sent) {
    try {
      const members = await memberRepo.findAll(orgId);
      for (const m of members) {
        await notifRepo.recordNotification(orgId, m.id, 'weekly_report', 'channel', sprintId);
      }
    } catch (err) {
      console.warn('[weekly-report] notification record failed:', err.message);
    }
  }

  return { posted: posted.sent, managerNotified, tracked: tracked.length };
}

module.exports = {
  key:         'weekly-report',
  name:        'Weekly sprint report',
  description: 'Posts a Claude-written sprint summary to the team channel and DMs the manager a copy.',
  category:    'reporting',
  audience:    'channel',
  defaultEnabled: true,
  schedule: (cfg) => weekly(cfg.reportDay, cfg.reportTime, '17:00'),
  run,
};
