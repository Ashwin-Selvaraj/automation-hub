'use strict';

require('dotenv').config();
const cron             = require('node-cron');
const db               = require('./db');
const slackService     = require('./services/slackService');
const jiraService      = require('./services/jiraService');
const claudeService    = require('./services/claudeService');
const performanceService = require('./services/performanceService');
const statsRepo        = require('./repositories/statsRepository');
const notifRepo        = require('./repositories/notificationRepository');
const sprintRepo       = require('./repositories/sprintRepository');
const memberRepo       = require('./repositories/memberRepository');
const { getSprintWindow } = require('./utils/dateUtils');
const configService = require('./services/configService');
const attendanceService = require('./services/attendanceService');
const featureFlags    = require('./services/featureFlags');
const standupRepo     = require('./repositories/standupRepository');
const mismatchService = require('./services/mismatchService');
const taskRepo        = require('./repositories/taskRepository');
const memberRoleRepository = require('./repositories/memberRoleRepository');
const auditLog     = require('./core/auditLog');
const idempotency  = require('./core/idempotency');
const cursorStore  = require('./core/cursor');
const { getOrgId } = require('./core/orgContext');

// Postgres advisory lock id for the huddle sync. Keeps the scheduled run and a
// manual "sync now" from processing the same messages concurrently — they used
// to share a module-level cursor with no lock at all.
const HUDDLE_SYNC_LOCK = 4711001;

const SYNC_CURSOR_KEY = 'huddle_sync:last_ts';

function parseTime(timeStr, fallback = '17:00') {
  const [h, m] = String(timeStr || fallback).split(':').map(Number);
  const fb = String(fallback).split(':').map(Number);
  return {
    hour:   Number.isInteger(h) ? h : fb[0],
    minute: Number.isInteger(m) ? m : fb[1],
  };
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

async function getActiveSprintId() {
  const sprint = await sprintRepo.getActiveSprint(getOrgId());
  return sprint ? sprint.id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 1 — Huddle sync
// ─────────────────────────────────────────────────────────────────────────────

async function runHuddleSync() {
  const orgId = getOrgId();

  // Only one sync at a time, across processes. Returns immediately rather than
  // queueing — the next scheduled run will pick up anything missed.
  const lock = await db.query('SELECT pg_try_advisory_lock($1) AS acquired', [HUDDLE_SYNC_LOCK]);
  if (!lock.rows[0].acquired) {
    console.log('[cron] Huddle sync already running elsewhere — skipping this run');
    return { processed: 0, matched: 0, noMatch: 0, errors: 0, skipped: 'locked' };
  }

  try {
    return await _huddleSyncBody(orgId);
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [HUDDLE_SYNC_LOCK]).catch(() => {});
  }
}

async function _huddleSyncBody(orgId) {
  const cfg = configService.getSprintConfig();
  const { start, end } = getSprintWindow();

  const now = Date.now() / 1000;
  const storedCursor = await cursorStore.getNumber(orgId, SYNC_CURSOR_KEY, null);
  const oldest = storedCursor != null ? storedCursor : start.getTime() / 1000;
  const latest = Math.min(end.getTime() / 1000, now);

  let processed = 0, matched = 0, noMatch = 0, errors = 0;

  let messages = [];
  try {
    messages = await slackService.getChannelMessages(cfg.channelId, oldest, latest);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Huddle sync: failed to fetch Slack messages:`, err.message);
    auditLog.record(orgId, { type: 'sync_error', action: 'Failed to fetch Slack messages', success: false, details: err.message });
    return { processed, matched, noMatch, errors: 1 };
  }

  let jiraTasks = [];
  try {
    jiraTasks = await jiraService.getSprintIssues(cfg.projectKey, start.toISOString().split('T')[0], end.toISOString().split('T')[0]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Huddle sync: failed to fetch Jira tasks:`, err.message);
    auditLog.record(orgId, { type: 'sync_error', action: 'Failed to fetch Jira tasks', success: false, details: err.message });
    return { processed, matched, noMatch, errors: 1 };
  }

  // Both fetches succeeded, so this window is genuinely covered. Advancing the
  // cursor before this point used to drop every message in the window whenever
  // Slack or Jira returned an error.
  await cursorStore.set(orgId, SYNC_CURSOR_KEY, latest);

  const sprintId = await getActiveSprintId();

  for (const msg of messages) {
    if (!msg.text || !msg.user) continue;
    processed++;

    const member     = cfg.teamMembers.find((m) => m.id === msg.user);
    const memberName = member?.name || msg.user;

    try {
      // ── 1. Detect multi-date bulk posts ──────────────────────────────────
      let isBulkPost  = false;
      let bulkEntries = null;
      try {
        const multiDate = await claudeService.parseMultiDateStandup(msg.text, memberName);
        if (multiDate) {
          isBulkPost  = true;
          bulkEntries = multiDate.entries;
          if (sprintId) {
            for (const entry of bulkEntries) {
              try {
                const dbMember = await memberRepo.findOrCreate(orgId, member?.id || msg.user, memberName, member?.email || null);
                await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, entry.date, {
                  posted_standup: true,
                  bulk_post: true,
                  bulk_post_actual_date: toDateStr(new Date(msg.ts * 1000 || Date.now())),
                });
              } catch (statErr) {
                console.warn('[cron] bulk stat write failed:', statErr.message);
              }
            }
          }
          auditLog.record(orgId, {
            type: 'bulk_standup', userId: msg.user, userName: memberName,
            slackMessageTs: msg.ts,
            action: `Bulk standup: posted ${bulkEntries.length} days of updates in one message`,
            success: true,
            details: multiDate.note || `Dates: ${bulkEntries.map((e) => e.date).join(', ')}`,
          });
        }
      } catch (bulkErr) {
        console.warn('[cron] multi-date parse failed:', bulkErr.message);
      }

      // ── 2. Record standup in performance DB ──────────────────────────────
      let dbMember = null;
      if (sprintId) {
        try {
          const result = await performanceService.syncMemberStandup(orgId, sprintId, msg);
          dbMember = result?.member || null;
        } catch (perfErr) {
          console.error('[cron] syncMemberStandup error:', perfErr.message);
        }
      }

      // ── 3. Match to Jira ──────────────────────────────────────────────────
      const textToMatch = isBulkPost && bulkEntries
        ? bulkEntries.map((e) => e.updates.join('\n')).join('\n')
        : msg.text;

      let memberAssignedTasks = [];
      if (sprintId && dbMember) {
        try {
          memberAssignedTasks = await taskRepo.findBySprintAndAssignee(sprintId, dbMember.id);
        } catch (taskErr) {
          console.warn('[cron] assigned task lookup failed:', taskErr.message);
        }
      }
      const assignedForMatch = memberAssignedTasks.map((t) => ({
        key:     t.jira_key,
        summary: t.title,
        status:  t.status || 'To Do',
      }));

      const analysis = await claudeService.matchHuddleToJira(
        textToMatch, memberName, jiraTasks, cfg.sprintName, assignedForMatch
      );

      // ── 3a. Matched to this member's own assigned task ────────────────────
      if (analysis.matchType === 'assigned_task' && analysis.matched && analysis.confidence >= 70 && analysis.issueKey) {
        matched++;
        try { await jiraService.addComment(analysis.issueKey, analysis.commentText); }
        catch (e) { console.error(`Huddle sync: addComment failed for ${analysis.issueKey}:`, e.message); }
        try { await jiraService.transitionIssue(analysis.issueKey, analysis.suggestedStatus); }
        catch (e) { console.warn(`Huddle sync: transitionIssue skipped for ${analysis.issueKey}:`, e.message); }

        if (sprintId && dbMember) {
          try {
            const task = await taskRepo.findByJiraKey(orgId, analysis.issueKey);
            if (task) {
              await performanceService.recordJiraSync(orgId, sprintId, dbMember.id, task.id, null, analysis.suggestedStatus || 'In Progress', 'slack_sync');
            }
          } catch (perfErr) { console.error('[cron] recordJiraSync error:', perfErr.message); }
        }

        auditLog.record(orgId, {
          type: 'match', userId: msg.user, userName: memberName,
          slackMessageTs: msg.ts, jiraKey: analysis.issueKey,
          action: `Matched to ${analysis.issueKey} (confidence: ${analysis.confidence}%)${isBulkPost ? ' [bulk post]' : ''}`,
          success: true, details: analysis.reason,
        });

      // ── 3b. Working on someone else's task, or a different project ────────
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

      // ── 3c. No Jira task found at all ─────────────────────────────────────
      } else {
        noMatch++;
        const canReceiveDM = dbMember ? await performanceService.shouldSendTaskDM(dbMember.id) : true;

        if (canReceiveDM) {
          // Claim before sending, not after. A restart can no longer re-send
          // this DM, and two concurrent runs cannot both win the claim.
          const dmKey = `no-match-dm:${msg.user}:${toDateStr(new Date())}`;
          if (await idempotency.claim(orgId, dmKey, 24)) {
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

              auditLog.record(orgId, {
                type: 'no_match_dm', userId: msg.user, userName: memberName,
                slackMessageTs: msg.ts, action: 'No-match DM sent — please update Jira', success: true,
                details: `Confidence: ${analysis.confidence}%. ${analysis.reason}${isBulkPost ? ' [bulk post detected]' : ''}`,
              });
            } catch (dmErr) {
              // Release so a later run can retry — the DM never actually went.
              await idempotency.release(orgId, dmKey);
              console.error(`Huddle sync: sendDM failed for ${msg.user}:`, dmErr.message);
              auditLog.record(orgId, { type: 'no_match_dm', userId: msg.user, userName: memberName, action: 'No-match DM failed', success: false, details: dmErr.message });
            }
          }
        } else {
          auditLog.record(orgId, { type: 'no_match_dm', userId: msg.user, userName: memberName, action: 'No-match DM skipped — managerial role exempt', success: true });
        }

        // Alert the team lead. Claimed separately so it fires once per person
        // per day rather than on every sync run.
        if (await idempotency.claim(orgId, `no-match-lead:${msg.user}:${toDateStr(new Date())}`, 24)) {
          try {
            const mismatchMember = dbMember
              ? { id: dbMember.id, name: member?.name || memberName, slack_user_id: msg.user, email: member?.email || null }
              : { id: null,        name: memberName,                  slack_user_id: msg.user, email: null };
            await mismatchService.handleMismatch(orgId, sprintId, mismatchMember, msg.text, { ...analysis, matchType: 'no_match' });
          } catch (leadErr) {
            console.warn('[cron] no-match lead alert failed:', leadErr.message);
          }
        }
      }

      // ── 4. Flag bulk posts in today's stats ───────────────────────────────
      if (isBulkPost && sprintId && dbMember) {
        try {
          await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, toDateStr(new Date()), {
            posted_standup: true,
            bulk_post: true,
          });
        } catch (statErr) {
          console.warn('[cron] bulk flag write failed:', statErr.message);
        }
      }

    } catch (err) {
      errors++;
      console.error(`[${new Date().toISOString()}] Huddle sync: error processing message ${msg.ts}:`, err.message);
      auditLog.record(orgId, { type: 'sync_error', userId: msg.user, userName: memberName, slackMessageTs: msg.ts, action: 'Message processing failed', success: false, details: err.message });
    }
  }

  console.log(`[${new Date().toISOString()}] Huddle sync complete: processed=${processed} matched=${matched} noMatch=${noMatch} errors=${errors}`);
  return { processed, matched, noMatch, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 2 — Deadline check
// ─────────────────────────────────────────────────────────────────────────────

async function runDeadlineCheck() {
  const orgId = getOrgId();
  const cfg   = configService.getSprintConfig();
  const sprintId = await getActiveSprintId();

  if (sprintId) {
    await performanceService.runDailyDeadlineCheck(orgId, sprintId);
    return;
  }

  // No DB sprint yet — fall back to querying Jira directly.
  const overdueIssues = await jiraService.getOverdueIssues(cfg.projectKey);
  for (const issue of overdueIssues) {
    try {
      if (!issue.assigneeEmail) continue;
      const member = cfg.teamMembers.find(
        (m) => m.email === issue.assigneeEmail || (issue.assigneeName && m.name === issue.assigneeName)
      );
      if (!member) continue;

      const key = `deadline-dm:${member.id}:${issue.key}:${toDateStr(new Date())}`;
      if (!await idempotency.claim(orgId, key, 20)) continue;

      const issueUrl = `${(process.env.JIRA_SITE_URL || '').replace(/\/$/, '')}/browse/${issue.key}`;
      const dmText = await claudeService.draftDeadlineDM(member.name, issue.key, issue.summary, issue.daysOverdue, issueUrl);
      await slackService.sendDM(member.id, dmText);
      auditLog.record(orgId, { type: 'deadline_dm', userId: member.id, userName: member.name, jiraKey: issue.key, action: `Deadline DM sent (${issue.daysOverdue} days overdue)`, success: true });
    } catch (err) {
      console.error(`Deadline check: error for ${issue.key}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 3 — End-of-day reminder
// ─────────────────────────────────────────────────────────────────────────────

async function runEodReminder() {
  const orgId = getOrgId();
  const cfg   = configService.getSprintConfig();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = toDateStr(new Date());

  const messages = await slackService.getChannelMessages(
    cfg.channelId, todayStart.getTime() / 1000, Date.now() / 1000
  );
  const postedUserIds = new Set(messages.map((m) => m.user));

  // Reads from the durable audit log rather than a 500-entry in-memory array
  // that a restart — or a busy channel — could have already emptied.
  const matchedUserIds = await auditLog.userIdsWithEntrySince(orgId, 'match', todayStart.toISOString());

  const sprintId = await getActiveSprintId();

  let attendanceBySlackId = new Map();
  try {
    const attendanceToday = await attendanceService.getTodayAttendance(orgId);
    attendanceBySlackId = new Map((attendanceToday.members || []).map((m) => [m.slackUserId, m]));
  } catch (attErr) {
    console.warn('[cron] EOD: attendance lookup failed, proceeding without it:', attErr.message);
  }

  for (const member of cfg.teamMembers) {
    const didPost  = postedUserIds.has(member.id);
    const didMatch = matchedUserIds.has(member.id);
    if (didPost && didMatch) continue;

    try {
      const dbMember = await memberRepo.findOrCreate(orgId, member.id, member.name, member.email || null);
      const att      = attendanceBySlackId.get(member.id);

      // Skip only on positive evidence of absence. `attendanceKnown` is false
      // when the only signal was the Slack fallback, which infers presence from
      // having posted — treating that as absence meant the people who hadn't
      // posted were exactly the people this reminder skipped.
      if (att && att.attendanceKnown && !att.checkedIn) {
        auditLog.record(orgId, { type: 'absent_skip', userId: member.id, userName: member.name, action: 'Skipped EOD DM — recorded absent today', success: true });
        if (sprintId) {
          try { await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, today, { checked_in: false, posted_standup: false }); }
          catch (statErr) { console.warn('[cron] EOD absent stat write failed:', statErr.message); }
        }
        continue;
      }

      // Skip if they checked out well before the reminder fires.
      if (att?.checkOutTime) {
        const eod        = parseTime(cfg.eodCheckTime, '18:30');
        const [coh, com] = att.checkOutTime.split(':').map(Number);
        if ((eod.hour * 60 + eod.minute) - (coh * 60 + com) > 60) {
          auditLog.record(orgId, { type: 'early_checkout_skip', userId: member.id, userName: member.name, action: `Skipped EOD DM — checked out at ${att.checkOutTime}`, success: true });
          continue;
        }
      }

      if (!await performanceService.shouldSendTaskDM(dbMember.id)) {
        auditLog.record(orgId, { type: 'missing_update_dm', userId: member.id, userName: member.name, action: 'Skipped EOD DM — managerial role exempt', success: true });
        continue;
      }

      // Shared with the checkout job below, so the two can't both message the
      // same person about the same missing standup on the same evening.
      const claimKey = didPost
        ? `eod-no-match:${dbMember.id}:${today}`
        : `missing-standup:${dbMember.id}:${today}`;
      if (!await idempotency.claim(orgId, claimKey, 20)) continue;

      let dmText;
      let entryType;
      if (!didPost) {
        dmText    = await claudeService.draftMissingUpdateDM(member.name, cfg.channelId, cfg.sprintName);
        entryType = 'missing_update_dm';
      } else {
        const boardUrl = `${(process.env.JIRA_SITE_URL || '').replace(/\/$/, '')}/jira/software/projects/${cfg.projectKey}/boards`;
        dmText    = `Hey ${member.name} 👋 Thanks for your standup today! I noticed I couldn't automatically match it to a Jira task in ${cfg.sprintName}.\n\nCould you update your tasks on the board so the team has full visibility? → ${boardUrl}`;
        entryType = 'no_match_dm';
      }

      try {
        await slackService.sendDM(member.id, dmText);
      } catch (dmErr) {
        await idempotency.release(orgId, claimKey);
        throw dmErr;
      }

      auditLog.record(orgId, {
        type: entryType, userId: member.id, userName: member.name,
        action: didPost ? 'EOD: no Jira match — asked to update tasks' : 'Missing standup DM sent',
        success: true,
      });

      if (sprintId) {
        try {
          const attFields = att ? {
            checked_in:     att.checkedIn,
            check_in_time:  att.checkInTime || null,
            check_out_time: att.checkOutTime || null,
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
      auditLog.record(orgId, { type: 'missing_update_dm', userId: member.id, userName: member.name, action: 'EOD DM failed', success: false, details: err.message });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 4 — Weekly report
// ─────────────────────────────────────────────────────────────────────────────

async function runWeeklyReport() {
  const orgId = getOrgId();
  const cfg   = configService.getSprintConfig();
  const { start, startStr, endStr } = getSprintWindow();

  try {
    const sprintId = await getActiveSprintId();

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
    const trackedTeamMembers = cfg.teamMembers.filter((m) => !managerialKeys.slackUserIds.has(m.id));
    const memberActivity = trackedTeamMembers.map((m) => {
      const userMsgs = messages.filter((msg) => msg.user === m.id);
      return {
        name: m.name,
        updateCount: userMsgs.length,
        updates: userMsgs.map((msg) => (msg.text || '').substring(0, 120)),
      };
    });

    const report = await claudeService.generateWeeklyReport(
      'Full Sprint', memberActivity, jiraTasks, cfg.sprintName,
      { leaderboard, atRisk }
    );
    await slackService.postToChannel(cfg.channelId, report);

    if (cfg.managerSlackId) {
      await slackService.sendDM(cfg.managerSlackId, report);
    }

    if (sprintId) {
      try {
        const members = await memberRepo.findAll(orgId);
        for (const m of members) {
          await notifRepo.recordNotification(orgId, m.id, 'weekly_report', 'channel', sprintId);
        }
      } catch (notifErr) {
        console.warn('[cron] weekly report notification record failed:', notifErr.message);
      }
    }

    auditLog.record(orgId, { type: 'report_posted', action: 'Weekly report posted by cron', success: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron weekly report crashed:`, err.message);
    auditLog.record(orgId, { type: 'report_posted', action: 'Weekly report cron failed', success: false, details: err.message });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 5 — Checkout without standup
// ─────────────────────────────────────────────────────────────────────────────

async function runCheckoutDetection() {
  if (!await featureFlags.isZohoAttendanceEnabled()) return;

  const orgId = getOrgId();
  const sprintId = await getActiveSprintId();
  if (!sprintId) {
    console.warn('[cron] Checkout detection: no active sprint, skipping run');
    return;
  }

  let attendanceToday;
  try {
    attendanceToday = await attendanceService.getTodayAttendance(orgId);
  } catch (attErr) {
    console.error(`[cron] Checkout detection: attendance lookup failed — ${attErr.message}`);
    auditLog.record(orgId, { type: 'checkout_check', action: `Attendance lookup failed: ${attErr.message}`, success: false });
    return;
  }

  const today = toDateStr(new Date());
  let checkedOutCount = 0, missingStandupCount = 0, dmsSentCount = 0;

  for (const att of (attendanceToday.members || [])) {
    try {
      if (!att.checkedOut) continue;
      checkedOutCount++;

      const standupPost = await standupRepo.findByMemberAndDate(att.memberId, today);
      if (standupPost) {
        if (await idempotency.claim(orgId, `checkout-ok:${att.memberId}:${today}`, 20)) {
          auditLog.record(orgId, {
            type: 'checkout_with_standup', userId: att.slackUserId, userName: att.name,
            action: `Checked out at ${att.checkOutTime} — standup already posted ✓`, success: true,
          });
        }
        continue;
      }

      missingStandupCount++;

      // Same claim key the end-of-day job uses, so whichever runs first is the
      // only one that messages this person about today's missing standup.
      if (!await idempotency.claim(orgId, `missing-standup:${att.memberId}:${today}`, 20)) {
        console.log(`[cron] Checkout without standup: ${att.name} — already handled today, skipped`);
        continue;
      }

      const result = await performanceService.recordCheckoutWithoutStandup(orgId, sprintId, att.memberId, att.checkOutTime || '—');
      if (result.dmSent) {
        dmsSentCount++;
        console.log(`[cron] Checkout without standup: ${att.name} at ${att.checkOutTime} — DM sent`);
      } else {
        // Nothing was sent, so don't hold the claim against the EOD job.
        await idempotency.release(orgId, `missing-standup:${att.memberId}:${today}`);
        console.log(`[cron] Checkout without standup: ${att.name} — ${result.reason || 'no DM sent'}`);
      }
    } catch (memberErr) {
      console.error(`[cron] Checkout detection: error for ${att.name}:`, memberErr.message);
      auditLog.record(orgId, {
        type: 'checkout_check', userName: att.name,
        action: `Processing error: ${memberErr.message}`, success: false,
      });
    }
  }

  console.log(
    `[${new Date().toISOString()}] Checkout check complete: ` +
    `${checkedOutCount} checked out, ${missingStandupCount} missing standup, ${dmsSentCount} DMs sent`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────────────

/** Wraps a job so a crash is logged and never takes the scheduler down. */
function guard(name, fn) {
  return async () => {
    console.log(`[${new Date().toISOString()}] Cron: running ${name}`);
    try {
      await fn();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Cron ${name} crashed:`, err.message);
    }
  };
}

function startCronJobs() {
  const cfg = configService.getSprintConfig();
  const tz  = cfg.timezone || 'Asia/Kolkata';
  const workdays = cfg.workdays || '1-5';

  const sync     = parseTime(cfg.syncTime, '10:00');
  const eod      = parseTime(cfg.eodCheckTime, '18:30');
  const report   = parseTime(cfg.reportTime, '17:00');
  const deadline = parseTime(cfg.deadlineTime, '09:00');
  const reportDayNum = dayNameToNumber(cfg.reportDay);

  // Checkout watch window, e.g. "16-19" → hours 16,17,18,19.
  const checkoutHours = /^\d{1,2}-\d{1,2}$/.test(cfg.checkoutHours || '') ? cfg.checkoutHours : '16-19';

  const schedules = [
    ['huddle sync',        `${sync.minute} ${sync.hour} * * *`,                       runHuddleSync],
    ['deadline check',     `${deadline.minute} ${deadline.hour} * * ${workdays}`,     runDeadlineCheck],
    ['EOD reminder',       `${eod.minute} ${eod.hour} * * ${workdays}`,               runEodReminder],
    ['weekly report',      `${report.minute} ${report.hour} * * ${reportDayNum}`,     runWeeklyReport],
    ['checkout detection', `*/15 ${checkoutHours} * * ${workdays}`,                   runCheckoutDetection],
  ];

  for (const [name, expression, fn] of schedules) {
    cron.schedule(expression, guard(name, fn), { timezone: tz });
    console.log(`[cron] ${name.padEnd(19)} → ${expression} (${tz})`);
  }

  // Housekeeping: expired dedupe claims and old audit rows.
  cron.schedule('30 3 * * *', guard('housekeeping', async () => {
    const claims = await idempotency.purgeExpired();
    const logs   = await auditLog.purgeOlderThan(90);
    console.log(`[cron] Housekeeping: ${claims} expired claims, ${logs} old log rows removed`);
  }), { timezone: tz });

  console.log(`[${new Date().toISOString()}] ${schedules.length} cron jobs started (tz: ${tz})`);
}

module.exports = {
  startCronJobs,
  runHuddleSync,
  runDeadlineCheck,
  runEodReminder,
  runWeeklyReport,
  runCheckoutDetection,
};
