'use strict';

require('dotenv').config();
const cron             = require('node-cron');
const slackService     = require('./services/slackService');
const jiraService      = require('./services/jiraService');
const claudeService    = require('./services/claudeService');
const activityLog      = require('./services/activityLog');
const performanceService = require('./services/performanceService');
const statsRepo        = require('./repositories/statsRepository');
const notifRepo        = require('./repositories/notificationRepository');
const sprintRepo       = require('./repositories/sprintRepository');
const memberRepo       = require('./repositories/memberRepository');
const { getSprintWindow, toUnixTimestamp } = require('./utils/dateUtils');
const { getSprintConfig } = require('./utils/sprintConfig');

let lastSyncTs = null;

function parseTime(timeStr) {
  const [h, m] = (timeStr || '17:00').split(':').map(Number);
  return { hour: isNaN(h) ? 17 : h, minute: isNaN(m) ? 0 : m };
}

function dayNameToNumber(dayName) {
  const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  return days[(dayName || 'friday').toLowerCase()] ?? 5;
}

function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().substring(0, 10);
}

function getOrgId() {
  return parseInt(process.env.ORGANISATION_ID || '1', 10);
}

async function getActiveSprintId() {
  const sprint = await sprintRepo.getActiveSprint(getOrgId());
  return sprint ? sprint.id : null;
}

async function runHuddleSync() {
  const cfg = getSprintConfig();
  const { start, end } = getSprintWindow();
  const orgId = getOrgId();

  const now    = Date.now() / 1000;
  const oldest = lastSyncTs ? lastSyncTs : start.getTime() / 1000;
  const latest = Math.min(end.getTime() / 1000, now);
  lastSyncTs   = now;

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

  const sprintId = await getActiveSprintId();

  for (const msg of messages) {
    if (!msg.text || !msg.user) continue;
    processed++;

    const member    = cfg.teamMembers.find((m) => m.id === msg.user);
    const memberName = member?.name || msg.user;

    try {
      // Record standup in performance DB
      let dbMember = null;
      if (sprintId) {
        try {
          const result = await performanceService.syncMemberStandup(orgId, sprintId, msg);
          dbMember = result?.member || null;
        } catch (perfErr) {
          console.error('[cron] syncMemberStandup error:', perfErr.message);
        }
      }

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
          console.warn(`Huddle sync: transitionIssue skipped for ${analysis.issueKey}:`, e.message);
        }

        // Record Jira sync in performance DB
        if (sprintId && dbMember) {
          try {
            const { query } = require('./db');
            const taskRes = await query(
              'SELECT id FROM tasks WHERE organisation_id = $1 AND jira_key = $2',
              [orgId, analysis.issueKey]
            );
            if (taskRes.rows.length > 0) {
              await performanceService.recordJiraSync(
                orgId, sprintId, dbMember.id, taskRes.rows[0].id,
                null, analysis.suggestedStatus || 'In Progress', 'slack_sync'
              );
            }
          } catch (perfErr) {
            console.error('[cron] recordJiraSync error:', perfErr.message);
          }
        }

        activityLog.addEntry({
          type: 'match', userId: msg.user, userName: memberName,
          slackMessageTs: msg.ts, jiraKey: analysis.issueKey,
          action: `Matched to ${analysis.issueKey} (confidence: ${analysis.confidence}%)`,
          success: true, details: analysis.reason,
        });
      } else {
        noMatch++;
        const alreadyDMed = activityLog.recentDMExists(msg.user, 'no_match_dm');
        if (!alreadyDMed) {
          try {
            const dmText = await claudeService.draftNoMatchDM(
              memberName, msg.text,
              process.env.JIRA_SITE_URL || '', cfg.projectKey, cfg.sprintName
            );
            await slackService.sendDM(msg.user, dmText);

            if (sprintId && dbMember) {
              try {
                await performanceService.recordNoMatchDM(orgId, sprintId, dbMember.id, msg.ts);
              } catch (perfErr) {
                console.error('[cron] recordNoMatchDM error:', perfErr.message);
              }
            }

            activityLog.addEntry({
              type: 'no_match_dm', userId: msg.user, userName: memberName,
              slackMessageTs: msg.ts, action: 'No-match DM sent', success: true,
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

function startCronJobs() {
  const cfg = getSprintConfig();
  const tz  = cfg.timezone || 'UTC';
  const { hour: eodHour, minute: eodMinute }       = parseTime(cfg.eodCheckTime);
  const { hour: reportHour, minute: reportMinute } = parseTime(cfg.reportTime);
  const reportDayNum = dayNameToNumber(cfg.reportDay);

  // Job 1: Huddle sync — every 30 min during business hours Mon-Fri
  cron.schedule('*/30 8-20 * * 1-5', async () => {
    console.log(`[${new Date().toISOString()}] Cron: running huddle sync`);
    try { await runHuddleSync(); } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron huddle sync crashed:`, err.message);
    }
  }, { timezone: tz });

  // Job 2: Deadline check — 09:00 Mon-Fri
  cron.schedule('0 9 * * 1-5', async () => {
    console.log(`[${new Date().toISOString()}] Cron: running deadline check`);
    const cfg2 = getSprintConfig();
    const orgId = getOrgId();
    try {
      const sprintId = await getActiveSprintId();
      if (sprintId) {
        await performanceService.runDailyDeadlineCheck(orgId, sprintId);
      } else {
        // Fallback to original deadline logic when no DB sprint
        const overdueIssues = await jiraService.getOverdueIssues(cfg2.projectKey);
        for (const issue of overdueIssues) {
          try {
            if (!issue.assigneeEmail) continue;
            const member = cfg2.teamMembers.find(
              (m) => m.email === issue.assigneeEmail || (issue.assigneeName && m.name === issue.assigneeName)
            );
            if (!member) continue;
            const issueUrl = `${(process.env.JIRA_SITE_URL || '').replace(/\/$/, '')}/browse/${issue.key}`;
            const dmText = await claudeService.draftDeadlineDM(member.name, issue.key, issue.summary, issue.daysOverdue, issueUrl);
            await slackService.sendDM(member.id, dmText);
            activityLog.addEntry({ type: 'deadline_dm', userId: member.id, userName: member.name, jiraKey: issue.key, action: `Deadline DM sent (${issue.daysOverdue} days overdue)`, success: true });
          } catch (err) {
            console.error(`Deadline check: error for ${issue.key}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron deadline check crashed:`, err.message);
    }
  }, { timezone: tz });

  // Job 3: Missing update check — at EOD_CHECK_TIME Mon-Fri
  cron.schedule(`${eodMinute} ${eodHour} * * 1-5`, async () => {
    console.log(`[${new Date().toISOString()}] Cron: running missing update check`);
    const cfg3  = getSprintConfig();
    const orgId = getOrgId();
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const messages = await slackService.getChannelMessages(
        cfg3.channelId, todayStart.getTime() / 1000, Date.now() / 1000
      );
      const postedUserIds = new Set(messages.map((m) => m.user));
      const today = toDateStr(new Date());
      const sprintId = await getActiveSprintId();

      for (const member of cfg3.teamMembers) {
        if (postedUserIds.has(member.id)) continue;
        try {
          const dmText = await claudeService.draftMissingUpdateDM(member.name, cfg3.channelId, cfg3.sprintName);
          await slackService.sendDM(member.id, dmText);
          activityLog.addEntry({ type: 'missing_update_dm', userId: member.id, userName: member.name, action: 'Missing update DM sent', success: true });

          if (sprintId) {
            try {
              const dbMember = await memberRepo.findOrCreate(orgId, member.id, member.name, member.email || null, member.role || null);
              await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, today, { posted_standup: false });
              await notifRepo.recordNotification(orgId, dbMember.id, 'missing_standup', 'dm', null);
            } catch (perfErr) {
              console.error('[cron] missing standup DB update error:', perfErr.message);
            }
          }
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
    const cfg4  = getSprintConfig();
    const orgId = getOrgId();
    const { start, end, startStr, endStr } = getSprintWindow();

    try {
      const sprintId = await getActiveSprintId();

      // Compute all member summaries before generating report
      let leaderboard = [];
      let atRisk      = [];
      if (sprintId) {
        const members = await memberRepo.findAll(orgId);
        for (const m of members) {
          try {
            await performanceService.computeSprintSummary(orgId, sprintId, m.id);
          } catch (perfErr) {
            console.error('[cron] computeSprintSummary error:', perfErr.message);
          }
        }
        leaderboard = await performanceService.getTeamLeaderboard(orgId, sprintId);
        atRisk      = await performanceService.getAtRiskMembers(orgId, sprintId);
      }

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

      const report = await claudeService.generateWeeklyReport(
        'Full Sprint', memberActivity, jiraTasks, cfg4.sprintName,
        { leaderboard, atRisk }
      );
      await slackService.postToChannel(cfg4.channelId, report);

      if (cfg4.managerSlackId) {
        await slackService.sendDM(cfg4.managerSlackId, report);
      }

      if (sprintId) {
        try {
          const members = await memberRepo.findAll(orgId);
          for (const m of members) {
            await notifRepo.recordNotification(orgId, m.id, 'weekly_report', 'channel', sprintId);
          }
        } catch (_) {}
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
