'use strict';

const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const sprintRepo = require('../repositories/sprintRepository');
const memberRepo = require('../repositories/memberRepository');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

async function resolveSprintId(querySprintId) {
  if (querySprintId) return parseInt(querySprintId, 10);
  const sprint = await sprintRepo.getActiveSprint(ORG_ID());
  return sprint?.id || null;
}

// ─── GET /api/mismatch/current?sprintId=X ───────────────────────────────────
router.get('/current', async (req, res) => {
  try {
    const orgId    = ORG_ID();
    const sprintId = await resolveSprintId(req.query.sprintId);

    const { rows } = await db.query(
      `SELECT me.*, m.name AS member_name, m.slack_user_id AS member_slack_id
       FROM mismatch_events me
       JOIN members m ON me.member_id = m.id
       WHERE me.organisation_id = $1
         AND ($2::int IS NULL OR me.sprint_id = $2)
       ORDER BY me.created_at DESC`,
      [orgId, sprintId]
    );

    const total      = rows.length;
    const unresolved = rows.filter((r) => !r.resolved).length;

    const events = rows.map((r) => ({
      id:              r.id,
      memberName:      r.member_name,
      memberSlackId:   r.member_slack_id,
      matchType:       r.match_type,
      mismatchDetails: r.mismatch_details,
      messageText:     r.message_text,
      matchedIssueKey: r.matched_issue_key,
      memberDmSent:    r.member_dm_sent,
      leadAlertSent:   r.lead_alert_sent,
      resolved:        r.resolved,
      resolutionNote:  r.resolution_note,
      createdAt:       r.created_at,
    }));

    return res.json({ total, unresolved, events });
  } catch (err) {
    console.error('[GET /mismatch/current]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/mismatch/:eventId/resolve ───────────────────────────────────
router.patch('/:eventId/resolve', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { note }    = req.body || {};

    const { rows } = await db.query(
      `UPDATE mismatch_events
       SET resolved      = true,
           resolved_at   = NOW(),
           resolution_note = $1
       WHERE id = $2 AND organisation_id = $3
       RETURNING *`,
      [note || null, parseInt(eventId, 10), ORG_ID()]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Mismatch event not found' });
    }

    return res.json({ success: true, event: rows[0] });
  } catch (err) {
    console.error('[PATCH /mismatch/:id/resolve]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/mismatch/member/:memberId?sprintId=X ──────────────────────────
router.get('/member/:memberId', async (req, res) => {
  try {
    const orgId    = ORG_ID();
    const memberId = parseInt(req.params.memberId, 10);
    const sprintId = req.query.sprintId ? parseInt(req.query.sprintId, 10) : null;

    const { rows } = await db.query(
      `SELECT * FROM mismatch_events
       WHERE organisation_id = $1
         AND member_id = $2
         AND ($3::int IS NULL OR sprint_id = $3)
       ORDER BY created_at DESC`,
      [orgId, memberId, sprintId]
    );

    return res.json({ memberId, events: rows });
  } catch (err) {
    console.error('[GET /mismatch/member/:id]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/mismatch/stats?sprintId=X ─────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const orgId    = ORG_ID();
    const sprintId = await resolveSprintId(req.query.sprintId);

    const { rows } = await db.query(
      `SELECT me.match_type, me.resolved, me.member_id, m.name AS member_name
       FROM mismatch_events me
       JOIN members m ON me.member_id = m.id
       WHERE me.organisation_id = $1
         AND ($2::int IS NULL OR me.sprint_id = $2)`,
      [orgId, sprintId]
    );

    const totalMismatches = rows.length;
    const resolved        = rows.filter((r) => r.resolved).length;
    const unresolved      = totalMismatches - resolved;

    const byType = { unassigned_task: 0, different_project: 0, no_match: 0 };
    for (const r of rows) {
      if (byType[r.match_type] !== undefined) byType[r.match_type]++;
    }

    // Per-member counts
    const memberMap = {};
    for (const r of rows) {
      if (!memberMap[r.member_id]) {
        memberMap[r.member_id] = { memberId: r.member_id, name: r.member_name, count: 0 };
      }
      memberMap[r.member_id].count++;
    }
    const byMember = Object.values(memberMap).sort((a, b) => b.count - a.count);

    return res.json({ totalMismatches, byType, byMember, resolved, unresolved });
  } catch (err) {
    console.error('[GET /mismatch/stats]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
