'use strict';

require('dotenv').config();
const cron = require('node-cron');
const slackService = require('./services/slackService');
const jiraService = require('./services/jiraService');
const claudeService = require('./services/claudeService');
const activityLog = require('./services/activityLog');
const { getSprintWindow, toUnixTimestamp } = require('./utils/dateUtils');
const { getSprintConfig } = require('./utils/sprintConfig');

// Tracks the last time huddle sync ran (unix seconds)
let lastSyncTs = null;

/**
 * Parses "HH:MM" into { hour, minute } integers.
 * @param {string} timeStr
 * @returns {{ hour: number, minute: number }}
 */
function parseTime(timeStr) {
  const [h, m] = (timeStr || '17:00').split(':').map(Number);
  return { hour: isNaN(h) ? 17 : h, minute: isNaN(m) ? 0 : m };
}

/**
 * Maps a weekday name to a cron day number (0=Sun, 1=Mon, ..., 5=Fri, 6=Sat).
 * @param {string} dayName - e.g. "Friday"
 * @returns {number}
 */
function dayNameToNumber(dayName) {
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  return days[(dayName || 'friday').toLowerCase()] ?? 5;
}

/**
 * Core huddle→jira sync logic. Exported so /api/sync/run can call it manually.
 * @returns {Promise<{ processed: number, matched: number, noMatch: number, errors: number }>}
 */
async function runHuddleSync() {
  const cfg = getSprintConfig();
  const { start, end } = getSprintWindow();

  const now = Date.now() / 1000;
  const oldest = lastSyncTs ? lastSyncTs : start.getTime() / 1000;
  const latest = Math.min(end.getTime() / 1000, now);
  lastSyncTs = now;

  let processed = 0, matched = 0, noMatch = 0, errors = 0;

  let messages = [];
  try {
    messages = await slackService.getChannelMessages(cfg.channelId, oldest, latest);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Huddle sync: failed to fetch Slack messages:`, err.message);
    activityLog.addEntry({ type: 'sync_error', action: 'Failed to fetch Slack messages', success: false, details: err.message });
    return { processed, matched, noMatch, errors: 1 };
  }

  let jiraTasks = [];
  try {
    jiraTasks = await jiraService.getSprintIssues(cfg.projectKey, start.toISOString().split('T')[0], end.toISOString().split('T')[0]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Huddle sync: failed to fetch Jira tasks:`, err.message);
    activityLog.addEntry({ type: 'sync_error', action: 'Failed to fetch Jira tasks', success: false, details: err.message });
    return { processed, matched, noMatch, errors: 1 };
  }

  for (const msg of messages) {
    if (!msg.text || !msg.user) continue;
    processed++;

    const member = cfg.teamMembers.find((m) => m.id === msg.user);
    const memberName = member?.name || msg.user;

    try {
      const analysis = await claudeService.matchHuddleToJira(msg.text, memberName, jiraTasks, cfg.sprintName);

      if (analysis.matched && analysis.confidence >= 70 && analysis.issueKey) {
        matched++;
        try {
          await jiraService.addComment(analysis.issueKey, analysis.commentText);
        } catch (e) {
          console.error(`Huddle sync: addComment failed for ${analysis.issueKey}:`, e.message);
        }
        try {
          await jiraService.transitionIssue(analysis.issueKey, analysis.suggestedStatus);
        } catch (e) {
          // Transition may fail if status is already set — log and continue
          console.warn(`Huddle sync: transitionIssue skipped for ${analysis.issueKey}:`, e.message);
        }
        activityLog.addEntry({
          type: 'match',
          userId: msg.user,
          userName: memberName,
          slackMessageTs: msg.ts,
          jiraKey: analysis.issueKey,
          action: `Matched to ${analysis.issueKey} (confidence: ${analysis.confidence}%)`,
          success: true,
          details: analysis.reason,
        });
      } else {
        noMatch++;
        const alreadyDMed = activityLog.recentDMExists(msg.user, 'no_match_dm');
        if (!alreadyDMed) {
          try {
            const dmText = await claudeService.draftNoMatchDM(
              memberName,
              msg.text,
              process.env.JIRA_SITE_URL || '',
              cfg.projectKey,
              cfg.sprintName
            );
            await slackService.sendDM(msg.user, dmText);
            activityLog.addEntry({
              type: 'no_match_dm',
              userId: msg.user,
              userName: memberName,
              slackMessageTs: msg.ts,
              action: 'No-match DM sent',
              success: true,
              details: `Confidence: ${analysis.confidence}%. ${analysis.reason}`,
            });
          } catch (dmErr) {
            console.error(`Huddle sync: sendDM failed for ${msg.user}:`, dmErr.message);
            activityLog.addEntry({ type: 'no_match_dm', userId: msg.user, userName: memberName, action: 'No-match DM failed', success: false, details: dmErr.message });
          }
        }
      }
    } catch (err) {
      errors++;
      console.error(`[${new Date().toISOString()}] Huddle sync: error processing message ${msg.ts}:`, err.message);
      activityLog.addEntry({ type: 'sync_error', userId: msg.user, userName: memberName, slackMessageTs: msg.ts, action: 'Message processing failed', success: false, details: err.message });
    }
  }

  console.log(`[${new Date().toISOString()}] Huddle sync complete: processed=${processed} matched=${matched} noMatch=${noMatch} errors=${errors}`);
  return { processed, matched, noMatch, errors };
}

/**
 * Starts all four cron jobs. Called once on server startup.
 */
function startCronJobs() {
  const cfg = getSprintConfig();
  const tz = cfg.timezone || 'UTC';
  const { hour: eodHour, minute: eodMinute } = parseTime(cfg.eodCheckTime);
  const { hour: reportHour, minute: reportMinute } = parseTime(cfg.reportTime);
  const reportDayNum = dayNameToNumber(cfg.reportDay);

  // Job 1: Huddle sync — every 30 min during business hours Mon-Fri
  cron.schedule('*/30 8-20 * * 1-5', async () => {
    console.log(`[${new Date().toISOString()}] Cron: running huddle sync`);
    try {
      await runHuddleSync();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron huddle sync crashed:`, err.message);
    }
  }, { timezone: tz });

  // Job 2: Deadline check — 09:00 Mon-Fri
  cron.schedule('0 9 * * 1-5', async () => {
    console.log(`[${new Date().toISOString()}] Cron: running deadline check`);
    const cfg2 = getSprintConfig();
    try {
      const overdueIssues = await jiraService.getOverdueIssues(cfg2.projectKey);
      for (const issue of overdueIssues) {
        try {
          if (!issue.assigneeEmail) continue;
          const member = cfg2.teamMembers.find(
            (m) => m.email === issue.assigneeEmail || (issue.assigneeName && m.name === issue.assigneeName)
          );
          if (!member) continue;

          const issueUrl = `${(process.env.JIRA_SITE_URL || '').replace(/\/$/, '')}/browse/${issue.key}`;
          const dmText = await claudeService.draftDeadlineDM(
            member.name, issue.key, issue.summary, issue.daysOverdue, issueUrl
          );
          await slackService.sendDM(member.id, dmText);

          // For severely overdue tasks send an escalated DM instead of posting to channel.
          // We never @mention users in a public channel — all alerts are private DMs.
          if (issue.daysOverdue > 3) {
            const issueUrl2 = issueUrl || issue.key;
            const escalatedDM =
              `🚨 *Escalation — ${issue.daysOverdue} days overdue*\n` +
              `*${issue.key}*: "${issue.summary}"\n` +
              `This task is now critically overdue. Please update its status or reach out to your lead immediately.\n` +
              `→ ${issueUrl2}`;

            // DM the assignee with the escalated notice
            await slackService.sendDM(member.id, escalatedDM);

            // Also DM the manager if one is configured
            if (cfg2.managerSlackId) {
              const managerDM =
                `📋 *Overdue escalation* — ${issue.daysOverdue} days\n` +
                `<@${member.id}>'s task *${issue.key}* ("${issue.summary}") has not been updated.\n` +
                `→ ${issueUrl2}`;
              await slackService.sendDM(cfg2.managerSlackId, managerDM);
            }
          }

          activityLog.addEntry({ type: 'deadline_dm', userId: member.id, userName: member.name, jiraKey: issue.key, action: `Deadline DM sent (${issue.daysOverdue} days overdue)`, success: true });
        } catch (err) {
          console.error(`Deadline check: error for ${issue.key}:`, err.message);
          activityLog.addEntry({ type: 'deadline_dm', jiraKey: issue.key, action: 'Deadline DM failed', success: false, details: err.message });
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron deadline check crashed:`, err.message);
    }
  }, { timezone: tz });

  // Job 3: Missing update check — at EOD_CHECK_TIME Mon-Fri
  cron.schedule(`${eodMinute} ${eodHour} * * 1-5`, async () => {
    console.log(`[${new Date().toISOString()}] Cron: running missing update check`);
    const cfg3 = getSprintConfig();
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const messages = await slackService.getChannelMessages(
        cfg3.channelId,
        todayStart.getTime() / 1000,
        Date.now() / 1000
      );

      const postedUserIds = new Set(messages.map((m) => m.user));
      const channelName = cfg3.channelId;

      for (const member of cfg3.teamMembers) {
        if (postedUserIds.has(member.id)) continue;
        try {
          const dmText = await claudeService.draftMissingUpdateDM(member.name, channelName, cfg3.sprintName);
          await slackService.sendDM(member.id, dmText);
          activityLog.addEntry({ type: 'missing_update_dm', userId: member.id, userName: member.name, action: 'Missing update DM sent', success: true });
        } catch (err) {
          console.error(`Missing update check: error for ${member.name}:`, err.message);
          activityLog.addEntry({ type: 'missing_update_dm', userId: member.id, userName: member.name, action: 'Missing update DM failed', success: false, details: err.message });
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron missing update check crashed:`, err.message);
    }
  }, { timezone: tz });

  // Job 4: Weekly report — on REPORT_DAY at REPORT_TIME
  cron.schedule(`${reportMinute} ${reportHour} * * ${reportDayNum}`, async () => {
    console.log(`[${new Date().toISOString()}] Cron: running weekly report`);
    const cfg4 = getSprintConfig();
    const { start, end, startStr, endStr } = getSprintWindow();

    try {
      const [messages, jiraTasks] = await Promise.all([
        slackService.getChannelMessages(cfg4.channelId, start.getTime() / 1000, Date.now() / 1000),
        jiraService.getSprintIssues(cfg4.projectKey, startStr, endStr),
      ]);

      const memberActivity = cfg4.teamMembers.map((m) => {
        const userMsgs = messages.filter((msg) => msg.user === m.id);
        return {
          name: m.name,
          updateCount: userMsgs.length,
          workingDays: 5,
          updates: userMsgs.map((msg) => (msg.text || '').substring(0, 120)),
        };
      });

      const report = await claudeService.generateWeeklyReport('Full Sprint', memberActivity, jiraTasks, cfg4.sprintName);
      await slackService.postToChannel(cfg4.channelId, report);

      if (cfg4.managerSlackId) {
        await slackService.sendDM(cfg4.managerSlackId, report);
      }

      activityLog.addEntry({ type: 'report_posted', action: 'Weekly report posted by cron', success: true });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron weekly report crashed:`, err.message);
      activityLog.addEntry({ type: 'report_posted', action: 'Weekly report cron failed', success: false, details: err.message });
    }
  }, { timezone: tz });

  console.log(`[${new Date().toISOString()}] All 4 cron jobs started (tz: ${tz})`);
}

module.exports = { startCronJobs, runHuddleSync };
