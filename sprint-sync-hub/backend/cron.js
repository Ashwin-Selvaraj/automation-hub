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
const configService = require('./services/configService');
const zohoService     = require('./services/zohoService');
const featureFlags    = require('./services/featureFlags');
const standupRepo     = require('./repositories/standupRepository');
const mismatchService = require('./services/mismatchService');
const taskRepo        = require('./repositories/taskRepository');

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
  const cfg = configService.getSprintConfig();
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

    const member     = cfg.teamMembers.find((m) => m.id === msg.user);
    const memberName = member?.name || msg.user;

    try {
      // ── 1. Detect multi-date bulk posts ────────────────────────────────────
      let isBulkPost  = false;
      let bulkEntries = null;
      try {
        const multiDate = await claudeService.parseMultiDateStandup(msg.text, memberName);
        if (multiDate) {
          isBulkPost  = true;
          bulkEntries = multiDate.entries;
          // Record each past date as a standup post (late / bulk)
          if (sprintId) {
            for (const entry of bulkEntries) {
              try {
                const dbMember = await memberRepo.findOrCreate(orgId, member?.id || msg.user, memberName, member?.email || null, member?.role || null);
                await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, entry.date, {
                  posted_standup: true,
                  bulk_post: true,
                  bulk_post_actual_date: toDateStr(new Date(msg.ts * 1000 || Date.now())),
                });
              } catch (_) {}
            }
          }
          activityLog.addEntry({
            type: 'bulk_standup', userId: msg.user, userName: memberName,
            slackMessageTs: msg.ts,
            action: `Bulk standup: posted ${bulkEntries.length} days of updates in one message`,
            success: true,
            details: multiDate.note || `Dates: ${bulkEntries.map((e) => e.date).join(', ')}`,
          });
        }
      } catch (_) { /* non-fatal */ }

      // ── 2. Record standup in performance DB ────────────────────────────────
      let dbMember = null;
      if (sprintId) {
        try {
          const result = await performanceService.syncMemberStandup(orgId, sprintId, msg);
          dbMember = result?.member || null;
        } catch (perfErr) {
          console.error('[cron] syncMemberStandup error:', perfErr.message);
        }
      }

      // ── 3. Match to Jira ────────────────────────────────────────────────────
      // For bulk posts, use the combined text for matching (best-effort)
      const textToMatch = isBulkPost && bulkEntries
        ? bulkEntries.map((e) => e.updates.join('\n')).join('\n')
        : msg.text;

      // Resolve assigned tasks for this member so Claude can classify the match type
      let memberAssignedTasks = [];
      if (sprintId && dbMember) {
        try {
          memberAssignedTasks = await taskRepo.findBySprintAndAssignee(sprintId, dbMember.id);
        } catch (_) {}
      }
      // Shape tasks as expected by matchHuddleToJira (key + summary + status)
      const assignedForMatch = memberAssignedTasks.map((t) => ({
        key:     t.jira_key,
        summary: t.title,
        status:  t.status || 'To Do',
      }));

      const analysis = await claudeService.matchHuddleToJira(
        textToMatch, memberName, jiraTasks, cfg.sprintName, assignedForMatch
      );

      // ── 3a. Happy path: matched to THIS member's assigned task ─────────────
      if (analysis.matchType === 'assigned_task' && analysis.matched && analysis.confidence >= 70 && analysis.issueKey) {
        matched++;
        try { await jiraService.addComment(analysis.issueKey, analysis.commentText); }
        catch (e) { console.error(`Huddle sync: addComment failed for ${analysis.issueKey}:`, e.message); }
        try { await jiraService.transitionIssue(analysis.issueKey, analysis.suggestedStatus); }
        catch (e) { console.warn(`Huddle sync: transitionIssue skipped for ${analysis.issueKey}:`, e.message); }

        if (sprintId && dbMember) {
          try {
            const { query } = require('./db');
            const taskRes = await query('SELECT id FROM tasks WHERE organisation_id = $1 AND jira_key = $2', [orgId, analysis.issueKey]);
            if (taskRes.rows.length > 0) {
              await performanceService.recordJiraSync(orgId, sprintId, dbMember.id, taskRes.rows[0].id, null, analysis.suggestedStatus || 'In Progress', 'slack_sync');
            }
          } catch (perfErr) { console.error('[cron] recordJiraSync error:', perfErr.message); }
        }

        activityLog.addEntry({
          type: 'match', userId: msg.user, userName: memberName,
          slackMessageTs: msg.ts, jiraKey: analysis.issueKey,
          action: `Matched to ${analysis.issueKey} (confidence: ${analysis.confidence}%)${isBulkPost ? ' [bulk post]' : ''}`,
          success: true, details: analysis.reason,
        });

      // ── 3b. Mismatch: working on someone else's task or different project ───
      } else if (analysis.matchType === 'unassigned_task' || analysis.matchType === 'different_project') {
        noMatch++;
        try {
          const mismatchMember = dbMember
            ? { id: dbMember.id, name: member?.name || memberName, slack_user_id: msg.user, email: member?.email || null }
            : { id: null,        name: memberName,                  slack_user_id: msg.user, email: null };
          await mismatchService.handleMismatch(orgId, sprintId, mismatchMember, msg.text, analysis);
        } catch (mismatchErr) {
          console.error('[cron] mismatchService.handleMismatch error:', mismatchErr.message);
        }

      // ── 3c. No match: no Jira task found at all ──────────────────────────
      } else {
        noMatch++;
        const alreadyDMed = activityLog.recentDMExists(msg.user, 'no_match_dm');
        if (!alreadyDMed) {
          try {
            const context = isBulkPost
              ? `${msg.text}\n\n(Note: this update covered multiple days posted in bulk)`
              : msg.text;
            const dmText = await claudeService.draftNoMatchDM(memberName, context, process.env.JIRA_SITE_URL || '', cfg.projectKey, cfg.sprintName);
            await slackService.sendDM(msg.user, dmText);

            if (sprintId && dbMember) {
              try { await performanceService.recordNoMatchDM(orgId, sprintId, dbMember.id, msg.ts); }
              catch (perfErr) { console.error('[cron] recordNoMatchDM error:', perfErr.message); }
            }

            activityLog.addEntry({
              type: 'no_match_dm', userId: msg.user, userName: memberName,
              slackMessageTs: msg.ts, action: 'No-match DM sent — please update Jira', success: true,
              details: `Confidence: ${analysis.confidence}%. ${analysis.reason}${isBulkPost ? ' [bulk post detected]' : ''}`,
            });
          } catch (dmErr) {
            console.error(`Huddle sync: sendDM failed for ${msg.user}:`, dmErr.message);
            activityLog.addEntry({ type: 'no_match_dm', userId: msg.user, userName: memberName, action: 'No-match DM failed', success: false, details: dmErr.message });
          }
        }

        // Also silently alert team lead for no_match events
        try {
          const mismatchMember = dbMember
            ? { id: dbMember.id, name: member?.name || memberName, slack_user_id: msg.user, email: member?.email || null }
            : { id: null,        name: memberName,                  slack_user_id: msg.user, email: null };
          // Pass no_match — mismatchService will skip member DM (already sent above) but will alert lead + record
          await mismatchService.handleMismatch(orgId, sprintId, mismatchMember, msg.text, { ...analysis, matchType: 'no_match' });
        } catch (_) { /* non-fatal */ }
      }

      // ── 5. If bulk post, flag in performance that updates weren't daily ────
      if (isBulkPost && sprintId && dbMember) {
        try {
          // Record today's standup as "bulk" so scoring knows it wasn't posted daily
          const today = toDateStr(new Date());
          await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, today, {
            posted_standup: true,
            bulk_post: true,
          });
        } catch (_) {}
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
  const cfg = configService.getSprintConfig();
  const tz  = cfg.timezone || 'Asia/Kolkata';

  // Read schedule from DB-backed config (with live reload each time the job fires)
  function getCfg()  { return configService.getSprintConfig(); }
  function getTime(key, fallback) { return parseTime(getCfg()[key] || fallback); }

  const { hour: syncHour,   minute: syncMinute }   = getTime('syncTime',   '10:00');
  const { hour: eodHour,    minute: eodMinute }     = getTime('eodCheckTime','18:30');
  const { hour: reportHour, minute: reportMinute }  = getTime('reportTime', '17:00');
  const reportDayNum = dayNameToNumber(cfg.reportDay || 'Friday');

  // Job 1: Huddle sync — daily at 10:00 AM (configurable via schedule.sync_time)
  cron.schedule(`${syncMinute} ${syncHour} * * *`, async () => {
    console.log(`[${new Date().toISOString()}] Cron: running daily huddle sync`);
    try { await runHuddleSync(); } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron huddle sync crashed:`, err.message);
    }
  }, { timezone: tz });

  console.log(`[cron] Job 1 (huddle sync) scheduled at ${syncHour}:${String(syncMinute).padStart(2,'0')} ${tz}`);

  // Job 2: Deadline check — 09:00 Mon-Fri
  cron.schedule('0 9 * * 1-5', async () => {
    console.log(`[${new Date().toISOString()}] Cron: running deadline check`);
    const cfg2 = configService.getSprintConfig();
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

  console.log(`[cron] Job 3 (EOD reminder) scheduled at ${eodHour}:${String(eodMinute).padStart(2,'0')} ${tz} Mon-Fri`);

  // Job 3: EOD reminder — 6:30 PM IST daily Mon-Fri (configurable via schedule.eod_time)
  // Sends DMs to any team member who has NOT posted a standup today AND
  // has no Jira-matched message — reminding them to update both Slack and Jira.
  cron.schedule(`${eodMinute} ${eodHour} * * 1-5`, async () => {
    console.log(`[${new Date().toISOString()}] Cron: running missing update check`);
    const cfg3  = configService.getSprintConfig();
    const orgId = getOrgId();
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const messages = await slackService.getChannelMessages(
        cfg3.channelId, todayStart.getTime() / 1000, Date.now() / 1000
      );
      const postedUserIds  = new Set(messages.map((m) => m.user));
      const matchedUserIds = new Set(
        activityLog.getEntries(500)
          .filter((e) => e.type === 'match' && e.timestamp > todayStart.toISOString())
          .map((e) => e.userId)
          .filter(Boolean)
      );
      const today    = toDateStr(new Date());
      const sprintId = await getActiveSprintId();

      for (const member of cfg3.teamMembers) {
        const didPost    = postedUserIds.has(member.id);
        const didMatch   = matchedUserIds.has(member.id);
        const alreadyDMed = activityLog.recentDMExists(member.id, 'missing_update_dm');
        if (alreadyDMed) continue;

        try {
          // ── Zoho attendance check ─────────────────────────────────────────────
          let attendanceData = null;
          let leaveData      = { onLeave: false };
          if (zohoService.isConfigured() && member.email) {
            [attendanceData, leaveData] = await Promise.all([
              zohoService.getAttendance(member.email, today).catch(() => null),
              zohoService.isOnLeave(member.email, today).catch(() => ({ onLeave: false })),
            ]);
          }

          // Skip if on approved leave
          if (leaveData?.onLeave) {
            console.log(`[cron] EOD: skipping ${member.name} — on ${leaveData.leaveType || 'leave'} today`);
            activityLog.addEntry({ type: 'leave_skip', userId: member.id, userName: member.name, action: `Skipped EOD DM — on ${leaveData.leaveType || 'leave'}`, success: true });
            if (sprintId) {
              try {
                const dbM = await memberRepo.findOrCreate(orgId, member.id, member.name, member.email || null, member.role || null);
                await statsRepo.upsertDailyStats(orgId, sprintId, dbM.id, today, {
                  on_leave: true, leave_type: leaveData.leaveType || 'Leave',
                });
              } catch (_) {}
            }
            continue;
          }

          // Skip if Zoho shows member did not check in (absent, no record)
          if (zohoService.isConfigured() && member.email && attendanceData && !attendanceData.checkedIn) {
            console.log(`[cron] EOD: skipping ${member.name} — no check-in today (absent)`);
            activityLog.addEntry({ type: 'absent_skip', userId: member.id, userName: member.name, action: 'Skipped EOD DM — not checked in (absent)', success: true });
            if (sprintId) {
              try {
                const dbM = await memberRepo.findOrCreate(orgId, member.id, member.name, member.email || null, member.role || null);
                await statsRepo.upsertDailyStats(orgId, sprintId, dbM.id, today, {
                  checked_in: false, posted_standup: false,
                });
              } catch (_) {}
            }
            continue;
          }

          // Skip if member checked out more than 1 hour before EOD check time
          if (attendanceData?.checkOutTime) {
            const eodMinutes  = parseTime(cfg3.eodCheckTime || '18:30');
            const coStr       = attendanceData.checkOutTime;
            const [coh, com]  = coStr.split(':').map(Number);
            const coMinutes   = coh * 60 + com;
            const eodTotalMin = eodMinutes.hour * 60 + eodMinutes.minute;
            if (eodTotalMin - coMinutes > 60) {
              console.log(`[cron] EOD: skipping ${member.name} — checked out at ${coStr}, more than 1h before EOD`);
              activityLog.addEntry({ type: 'early_checkout_skip', userId: member.id, userName: member.name, action: `Skipped EOD DM — checked out at ${coStr}`, success: true });
              continue;
            }
          }

          // ── Determine DM type ────────────────────────────────────────────────
          let dmText;
          if (!didPost) {
            // Member hasn't posted standup at all today
            dmText = await claudeService.draftMissingUpdateDM(member.name, cfg3.channelId, cfg3.sprintName);
            activityLog.addEntry({ type: 'missing_update_dm', userId: member.id, userName: member.name, action: 'Missing standup DM sent', success: true });
          } else if (!didMatch) {
            // Member posted but no Jira task was matched — remind to update Jira
            const boardUrl = `${(process.env.JIRA_SITE_URL || '').replace(/\/$/, '')}/jira/software/projects/${cfg3.projectKey}/boards`;
            dmText = `Hey ${member.name} 👋 Thanks for your standup today! I noticed I couldn't automatically match it to a Jira task in ${cfg3.sprintName}.\n\nCould you update your tasks on the board so the team has full visibility? → ${boardUrl}`;
            activityLog.addEntry({ type: 'no_match_dm', userId: member.id, userName: member.name, action: 'EOD: no Jira match — asked to update tasks', success: true });
          } else {
            continue; // posted + matched — nothing to do
          }

          await slackService.sendDM(member.id, dmText);

          if (sprintId) {
            try {
              const dbMember = await memberRepo.findOrCreate(orgId, member.id, member.name, member.email || null, member.role || null);
              const attFields = attendanceData ? {
                checked_in:    attendanceData.checkedIn,
                check_in_time: attendanceData.checkInTime || null,
                check_out_time:attendanceData.checkOutTime || null,
                hours_worked:  attendanceData.hoursWorked || null,
              } : {};
              if (!didPost) {
                await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, today, { posted_standup: false, ...attFields });
              }
              await notifRepo.recordNotification(orgId, dbMember.id, didPost ? 'no_match_dm' : 'missing_standup', 'dm', null);
            } catch (perfErr) {
              console.error('[cron] EOD DB update error:', perfErr.message);
            }
          }
        } catch (err) {
          console.error(`EOD check: error for ${member.name}:`, err.message);
          activityLog.addEntry({ type: 'missing_update_dm', userId: member.id, userName: member.name, action: 'EOD DM failed', success: false, details: err.message });
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron EOD check crashed:`, err.message);
    }
  }, { timezone: tz });

  // Job 4: Weekly report — on REPORT_DAY at REPORT_TIME
  cron.schedule(`${reportMinute} ${reportHour} * * ${reportDayNum}`, async () => {
    console.log(`[${new Date().toISOString()}] Cron: running weekly report`);
    const cfg4  = configService.getSprintConfig();
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

  // ── Job 5: Checkout Detection ─────────────────────────────────────────────────
  // Polls Zoho every 15 minutes from 4:30 PM to 7:30 PM, Mon–Fri.
  // For each member who has just checked out, checks if they posted a standup today.
  // If not, triggers a DM and records the missed standup.
  //
  // In-memory Set of member DB IDs already processed today.
  // Reset at midnight so the Set doesn't grow forever across days.
  const processedToday = new Set();

  cron.schedule('0 0 * * *', () => {
    processedToday.clear();
    console.log(`[${new Date().toISOString()}] Cron: processedToday Set cleared for new day`);
  }, { timezone: tz });

  // '15,30,45,0 16,17,18,19 * * 1-5'
  // Fires at :00, :15, :30, :45 of hours 16–19 on weekdays
  cron.schedule('*/15 16,17,18,19 * * 1-5', async () => {
    const zohoEnabled = await featureFlags.isZohoAttendanceEnabled();
    if (!zohoEnabled) return;

    console.log(`[${new Date().toISOString()}] Cron: running checkout detection`);
    const orgId = getOrgId();

    try {
      // Guard — need an active sprint to record stats against
      const sprintId = await getActiveSprintId();
      if (!sprintId) {
        console.warn('[cron] Checkout detection: no active sprint, skipping run');
        return;
      }

      // Fetch today's attendance for all team members from Zoho
      let attendanceRecords;
      try {
        attendanceRecords = await zohoService.getAllTodayAttendance();
      } catch (zohoErr) {
        console.error(`[cron] Checkout detection: Zoho unavailable — ${zohoErr.message}`);
        activityLog.addEntry({ type: 'checkout_check', action: `Zoho unavailable: ${zohoErr.message}`, success: false });
        return;
      }

      const today = toDateStr(new Date());
      let checkedOutCount = 0;
      let missingStandupCount = 0;
      let dmsSentCount = 0;

      for (const att of attendanceRecords) {
        try {
          // Skip members who haven't checked out yet
          if (!att.checkedOut) continue;
          checkedOutCount++;

          // Find the DB member record (try Slack ID first, then email)
          let dbMember = null;
          if (att.slackUserId) {
            dbMember = await memberRepo.findBySlackId(orgId, att.slackUserId).catch(() => null);
          }
          if (!dbMember && att.email) {
            dbMember = await memberRepo.findByEmail(orgId, att.email).catch(() => null);
          }
          if (!dbMember) {
            console.warn(`[cron] Checkout detection: no DB record for ${att.name} (${att.email}) — skipping`);
            continue;
          }

          // Skip if already processed today (prevents duplicate DMs on subsequent polls)
          if (processedToday.has(dbMember.id)) continue;

          // Check standup status
          const standupPost = await standupRepo.findByMemberAndDate(dbMember.id, today);
          if (standupPost) {
            // Posted standup — mark as processed, log, move on
            processedToday.add(dbMember.id);
            console.log(`[cron] Checkout detection: ${att.name} checked out at ${att.checkOutTime} ✓ (standup posted)`);
            activityLog.addEntry({
              type: 'checkout_with_standup', userId: att.slackUserId, userName: att.name,
              action: `Checked out at ${att.checkOutTime} — standup already posted ✓`, success: true,
            });
            continue;
          }

          // No standup — trigger DM + record
          missingStandupCount++;
          const result = await performanceService.recordCheckoutWithoutStandup(orgId, sprintId, dbMember.id, att.checkOutTime || '—');
          processedToday.add(dbMember.id);

          if (result.dmSent) {
            dmsSentCount++;
            console.log(`[cron] Checkout without standup: ${att.name} at ${att.checkOutTime} — DM sent`);
          } else if (result.alreadyRecorded) {
            console.log(`[cron] Checkout without standup: ${att.name} — already notified today, skipped`);
          } else {
            console.log(`[cron] Checkout without standup: ${att.name} — ${result.reason}`);
          }

        } catch (memberErr) {
          // Per-member errors must not stop the rest of the loop
          console.error(`[cron] Checkout detection: error for ${att.name}:`, memberErr.message);
          activityLog.addEntry({
            type: 'checkout_check', userName: att.name,
            action: `Processing error: ${memberErr.message}`, success: false,
          });
        }
      }

      console.log(
        `[${new Date().toISOString()}] Checkout check complete: ` +
        `${checkedOutCount} checked out, ${missingStandupCount} missing standup, ${dmsSentCount} DMs sent`
      );

    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron checkout detection crashed:`, err.message);
      activityLog.addEntry({ type: 'checkout_check', action: `Checkout detection crashed: ${err.message}`, success: false });
    }
  }, { timezone: tz });

  console.log(`[cron] Job 5 (checkout detection) scheduled */15 16,17,18,19 Mon-Fri (tz: ${tz})`);
  console.log(`[${new Date().toISOString()}] All 5 cron jobs started (tz: ${tz})`);
}

module.exports = { startCronJobs, runHuddleSync };
