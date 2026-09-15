'use strict';

const db               = require('../../db');
const slackService     = require('../../services/slackService');
const jiraService      = require('../../services/jiraService');
const claudeService    = require('../../services/claudeService');
const performanceService = require('../../services/performanceService');
const mismatchService  = require('../../services/mismatchService');
const statsRepo        = require('../../repositories/statsRepository');
const sprintRepo       = require('../../repositories/sprintRepository');
const memberRepo       = require('../../repositories/memberRepository');
const taskRepo         = require('../../repositories/taskRepository');
const { getSprintWindow } = require('../../utils/dateUtils');
const auditLog    = require('../../core/auditLog');
const notifier    = require('../../core/notifier');
const idempotency = require('../../core/idempotency');
const cursorStore = require('../../core/cursor');
const { daily }   = require('../schedule');

/**
 * Reads the standup channel, matches each update to a Jira task with Claude,
 * and writes the result back to Jira.
 *
 * This is the core of the product and the one automation that should never be
 * turned off — everything else reads the data it produces.
 */

// Advisory lock id: keeps the scheduled run and a manual "sync now" from
// processing the same messages at once. They previously shared a module-level
// cursor with no lock at all.
const SYNC_LOCK = 4711001;
const CURSOR_KEY = 'huddle_sync:last_ts';

function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().substring(0, 10);
}

async function run({ orgId, cfg }) {
  const lock = await db.query('SELECT pg_try_advisory_lock($1) AS acquired', [SYNC_LOCK]);
  if (!lock.rows[0].acquired) {
    console.log('[standup-sync] already running elsewhere — skipping');
    return { skipped: 'locked' };
  }
  try {
    return await sync(orgId, cfg);
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK]).catch(() => {});
  }
}

async function sync(orgId, cfg) {
  const { start, end } = getSprintWindow();
  const now    = Date.now() / 1000;
  const stored = await cursorStore.getNumber(orgId, CURSOR_KEY, null);
  const oldest = stored != null ? stored : start.getTime() / 1000;
  const latest = Math.min(end.getTime() / 1000, now);

  let processed = 0, matched = 0, noMatch = 0, errors = 0;

  let messages;
  try {
    messages = await slackService.getChannelMessages(cfg.channelId, oldest, latest);
  } catch (err) {
    auditLog.record(orgId, { type: 'sync_error', action: 'Failed to fetch Slack messages', success: false, details: err.message });
    throw err;
  }

  let jiraTasks;
  try {
    jiraTasks = await jiraService.getSprintIssues(
      cfg.projectKey, start.toISOString().split('T')[0], end.toISOString().split('T')[0]
    );
  } catch (err) {
    auditLog.record(orgId, { type: 'sync_error', action: 'Failed to fetch Jira tasks', success: false, details: err.message });
    throw err;
  }

  // Both fetches succeeded, so this window is genuinely covered. Advancing the
  // cursor any earlier drops every message in a window that errored.
  await cursorStore.set(orgId, CURSOR_KEY, latest);

  const sprint   = await sprintRepo.getActiveSprint(orgId);
  const sprintId = sprint ? sprint.id : null;
  const today    = toDateStr(new Date());

  for (const msg of messages) {
    if (!msg.text || !msg.user) continue;
    processed++;

    const member     = cfg.teamMembers.find((m) => m.id === msg.user);
    const memberName = member?.name || msg.user;

    try {
      // ── Multi-day catch-up posts ──────────────────────────────────────────
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
                console.warn('[standup-sync] bulk stat write failed:', statErr.message);
              }
            }
          }
          auditLog.record(orgId, {
            type: 'bulk_standup', userId: msg.user, userName: memberName, slackMessageTs: msg.ts,
            action: `Bulk standup: posted ${bulkEntries.length} days of updates in one message`,
            success: true,
            details: multiDate.note || `Dates: ${bulkEntries.map((e) => e.date).join(', ')}`,
          });
        }
      } catch (bulkErr) {
        console.warn('[standup-sync] multi-date parse failed:', bulkErr.message);
      }

      // ── Record the standup ────────────────────────────────────────────────
      let dbMember = null;
      if (sprintId) {
        try {
          const result = await performanceService.syncMemberStandup(orgId, sprintId, msg);
          dbMember = result?.member || null;
        } catch (perfErr) {
          console.error('[standup-sync] syncMemberStandup error:', perfErr.message);
        }
      }

      // ── Match to Jira ─────────────────────────────────────────────────────
      const textToMatch = isBulkPost && bulkEntries
        ? bulkEntries.map((e) => e.updates.join('\n')).join('\n')
        : msg.text;

      let assigned = [];
      if (sprintId && dbMember) {
        try {
          assigned = (await taskRepo.findBySprintAndAssignee(sprintId, dbMember.id))
            .map((t) => ({ key: t.jira_key, summary: t.title, status: t.status || 'To Do' }));
        } catch (taskErr) {
          console.warn('[standup-sync] assigned task lookup failed:', taskErr.message);
        }
      }

      const analysis = await claudeService.matchHuddleToJira(
        textToMatch, memberName, jiraTasks, cfg.sprintName, assigned
      );

      // ── Matched to their own task ─────────────────────────────────────────
      if (analysis.matchType === 'assigned_task' && analysis.matched && analysis.confidence >= 70 && analysis.issueKey) {
        matched++;
        try { await jiraService.addComment(analysis.issueKey, analysis.commentText); }
        catch (e) { console.error(`[standup-sync] addComment failed for ${analysis.issueKey}:`, e.message); }
        try { await jiraService.transitionIssue(analysis.issueKey, analysis.suggestedStatus); }
        catch (e) { console.warn(`[standup-sync] transitionIssue skipped for ${analysis.issueKey}:`, e.message); }

        if (sprintId && dbMember) {
          try {
            const task = await taskRepo.findByJiraKey(orgId, analysis.issueKey);
            if (task) {
              await performanceService.recordJiraSync(
                orgId, sprintId, dbMember.id, task.id, null,
                analysis.suggestedStatus || 'In Progress', 'slack_sync'
              );
            }
          } catch (perfErr) { console.error('[standup-sync] recordJiraSync error:', perfErr.message); }
        }

        auditLog.record(orgId, {
          type: 'match', userId: msg.user, userName: memberName,
          slackMessageTs: msg.ts, jiraKey: analysis.issueKey,
          action: `Matched to ${analysis.issueKey} (confidence: ${analysis.confidence}%)${isBulkPost ? ' [bulk post]' : ''}`,
          success: true, details: analysis.reason,
        });

      // ── Someone else's task, or another project ───────────────────────────
      } else if (analysis.matchType === 'unassigned_task' || analysis.matchType === 'different_project') {
        noMatch++;
        try {
          await mismatchService.handleMismatch(orgId, sprintId, shapeMember(dbMember, member, memberName, msg.user), msg.text, analysis);
        } catch (mismatchErr) {
          console.error('[standup-sync] handleMismatch error:', mismatchErr.message);
        }

      // ── Nothing on the board matches ──────────────────────────────────────
      } else {
        noMatch++;
        const canReceiveDM = dbMember ? await performanceService.shouldSendTaskDM(dbMember.id) : true;

        if (canReceiveDM) {
          const context = isBulkPost
            ? `${msg.text}\n\n(Note: this update covered multiple days posted in bulk)`
            : msg.text;
          let dmText;
          try {
            dmText = await claudeService.draftNoMatchDM(
              memberName, context, process.env.JIRA_SITE_URL || '', cfg.projectKey, cfg.sprintName
            );
          } catch (draftErr) {
            console.error('[standup-sync] draftNoMatchDM failed:', draftErr.message);
          }

          if (dmText) {
            const outcome = await notifier.sendDM({
              orgId, slackUserId: msg.user, text: dmText,
              dedupeKey: `no-match-dm:${msg.user}:${today}`,
              ttlHours: 24, type: 'no_match_dm', userName: memberName,
              action: 'No-match DM sent — please update Jira',
            });
            if (outcome.sent && sprintId && dbMember) {
              try { await performanceService.recordNoMatchDM(orgId, sprintId, dbMember.id, msg.ts); }
              catch (perfErr) { console.error('[standup-sync] recordNoMatchDM error:', perfErr.message); }
            }
          }
        } else {
          auditLog.record(orgId, {
            type: 'no_match_dm', userId: msg.user, userName: memberName,
            action: 'No-match DM skipped — managerial role exempt', success: true,
          });
        }

        // Alert the lead once per person per day, rather than on every run.
        if (await idempotency.claim(orgId, `no-match-lead:${msg.user}:${today}`, 24)) {
          try {
            await mismatchService.handleMismatch(
              orgId, sprintId, shapeMember(dbMember, member, memberName, msg.user),
              msg.text, { ...analysis, matchType: 'no_match' }
            );
          } catch (leadErr) {
            console.warn('[standup-sync] lead alert failed:', leadErr.message);
          }
        }
      }

      if (isBulkPost && sprintId && dbMember) {
        try {
          await statsRepo.upsertDailyStats(orgId, sprintId, dbMember.id, today, { posted_standup: true, bulk_post: true });
        } catch (statErr) {
          console.warn('[standup-sync] bulk flag write failed:', statErr.message);
        }
      }

    } catch (err) {
      errors++;
      console.error(`[standup-sync] error processing message ${msg.ts}:`, err.message);
      auditLog.record(orgId, {
        type: 'sync_error', userId: msg.user, userName: memberName, slackMessageTs: msg.ts,
        action: 'Message processing failed', success: false, details: err.message,
      });
    }
  }

  return { processed, matched, noMatch, errors };
}

function shapeMember(dbMember, cfgMember, memberName, slackUserId) {
  return dbMember
    ? { id: dbMember.id, name: cfgMember?.name || memberName, slack_user_id: slackUserId, email: cfgMember?.email || null }
    : { id: null, name: memberName, slack_user_id: slackUserId, email: null };
}

module.exports = {
  key:         'standup-sync',
  name:        'Standup → Jira sync',
  description: 'Reads the standup channel, matches each update to a Jira task, and comments and transitions the issue.',
  category:    'delivery',
  audience:    'system',
  defaultEnabled: true,
  schedule: (cfg) => daily(cfg.syncTime, '10:00'),
  run,
};
