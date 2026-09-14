'use strict';

/**
 * mismatchService.js
 * Handles all task mismatch detection, member DMs, and team lead alerts.
 * Called by cron Job 1 whenever matchHuddleToJira returns a non-assigned-task matchType.
 */

const claudeService        = require('./claudeService');
const slackService         = require('./slackService');
const notifRepo            = require('../repositories/notificationRepository');
const taskRepo             = require('../repositories/taskRepository');
const memberRoleRepository = require('../repositories/memberRoleRepository');
const db                   = require('../db');
const auditLog = require('../core/auditLog');
const { getOrgId } = require('../core/orgContext');

/**
 * Central handler for task mismatches.
 * @param {number} organisationId
 * @param {number} sprintId
 * @param {Object} member       - { id, name, slack_user_id|slackUserId, email }
 * @param {string} messageText
 * @param {Object} matchResult  - Full result from matchHuddleToJira() including matchType
 * @returns {Promise<{ memberDmSent: boolean, leadAlertSent: boolean, recorded: boolean }>}
 */
async function handleMismatch(organisationId, sprintId, member, messageText, matchResult) {
  const slackUserId = member.slack_user_id || member.slackUserId || member.id;
  const memberId    = member.id;

  // ── STEP 1: Idempotency check — 4-hour window ─────────────────────────────
  try {
    const recent = await notifRepo.wasNotifiedRecently(memberId, 'task_mismatch', null, 4);
    if (recent) {
      console.log(`[mismatchService] Skipping — ${member.name} already received a mismatch notification in the last 4 hours`);
      return { memberDmSent: false, leadAlertSent: false, recorded: false };
    }
  } catch (err) {
    console.warn('[mismatchService] idempotency check failed:', err.message);
    // Non-fatal — continue
  }

  // ── STEP 2: Get member's assigned tasks this sprint ───────────────────────
  let assignedTasks = [];
  if (sprintId && memberId) {
    try {
      assignedTasks = await taskRepo.findBySprintAndAssignee(sprintId, memberId);
    } catch (err) {
      console.warn('[mismatchService] Could not load assigned tasks:', err.message);
    }
  }

  // Normalise to { key, title } shape for Claude prompts
  const taskSummary = assignedTasks.map((t) => ({
    key:   t.jira_key   || '',
    title: t.title      || '',
  }));

  // ── STEP 3: Get team lead info ────────────────────────────────────────────
  const leadSlackId = process.env.TEAM_LEAD_SLACK_ID || null;
  if (!leadSlackId) {
    console.warn('[mismatchService] TEAM_LEAD_SLACK_ID not configured — lead alerts disabled');
  }

  const details   = matchResult.mismatchDetails || 'The update does not match any assigned sprint task.';
  const matchType = matchResult.matchType;

  let memberDmSent  = false;
  let leadAlertSent = false;
  let recorded      = false;

  // ── STEP 4: The member is not messaged ────────────────────────────────────
  // A bot telling someone they worked on the wrong ticket is the single most
  // resented message this system used to send, and it is usually wrong about
  // the reason — people pick up other work because they were asked to, because
  // they were unblocked and their own task wasn't, or because the board is out
  // of date. The event is recorded below and reaches the lead in the daily
  // brief, where a person can ask why instead of asserting a fault.
  if (memberId) {
    try {
      await notifRepo.recordNotification(organisationId, memberId, 'task_mismatch', 'dm', null);
    } catch (err) {
      console.warn('[mismatchService] could not record mismatch notification:', err.message);
    }
  }

  // ── STEP 5: Draft and send team lead alert ────────────────────────────────
  if (leadSlackId) {
    try {
      const alertText = await claudeService.draftTeamLeadAlert(
        member.name,
        messageText,
        matchType,
        details,
        taskSummary,
      );
      await slackService.sendDM(leadSlackId, alertText);
      leadAlertSent = true;
      console.log(`[mismatchService] Team lead alerted about mismatch: ${member.name}`);
    } catch (err) {
      console.error('[mismatchService] Lead alert DM failed:', err.message);
    }
  }

  // ── STEP 6: Record in mismatch_events table ───────────────────────────────
  try {
    await db.query(
      `INSERT INTO mismatch_events
         (organisation_id, sprint_id, member_id, message_text,
          match_type, mismatch_details, matched_issue_key,
          member_dm_sent, lead_alert_sent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        organisationId,
        sprintId   || null,
        memberId   || null,
        messageText,
        matchType,
        details,
        matchResult.issueKey || null,
        memberDmSent,
        leadAlertSent,
      ]
    );
    recorded = true;
  } catch (err) {
    console.error('[mismatchService] DB record failed:', err.message);
  }

  // ── STEP 7: Activity log ──────────────────────────────────────────────────
  auditLog.record(getOrgId(), {
    type:     'task_mismatch',
    userId:   String(slackUserId),
    userName: member.name,
    action:   `${matchType}: ${details}`,
    success:  true,
    details:  `member_dm=${memberDmSent} lead_alert=${leadAlertSent}`,
  });

  return { memberDmSent, leadAlertSent, recorded };
}

module.exports = { handleMismatch };
