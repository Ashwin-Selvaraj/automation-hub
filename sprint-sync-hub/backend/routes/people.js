'use strict';

const express       = require('express');
const router        = express.Router();
const peopleRepo    = require('../repositories/peopleRepository');
const peopleService = require('../services/peopleService');
const auditLog      = require('../core/auditLog');
const { getOrgId }  = require('../core/orgContext');

/**
 * The People tab: 1:1 schedules, prep, notes and follow-ups, recognition
 * suggestions and review evidence. Everything here is for the lead.
 *
 * Audit entries record that something happened ("1:1 recorded for Alice"),
 * never what was said: the activity log is visible on the dashboard, and 1:1
 * notes are not.
 */

const CADENCES = ['weekly', 'fortnightly', 'monthly'];
const MAX_NOTES = 10_000;
const MAX_ACTIONS = 20;
const MAX_ACTION_TEXT = 500;

function memberIdParam(req, res) {
  const id = parseInt(req.params.memberId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid member id' });
    return null;
  }
  return id;
}

function fail(res, where, err) {
  if (err.code === 'BAD_WINDOW') return res.status(400).json({ error: err.message });
  console.error(`[people ${where}]`, err.message);
  return res.status(500).json({ error: 'Something went wrong' });
}

/** GET /api/people — everyone, with their 1:1 day, last 1:1 and open follow-ups. */
router.get('/', async (req, res) => {
  try {
    res.json({ members: await peopleRepo.overview(getOrgId()) });
  } catch (err) { fail(res, 'GET /', err); }
});

/** GET /api/people/recognition?from=&to= — defaults to the last seven days. */
router.get('/recognition', async (req, res) => {
  try {
    const rec = await peopleService.recognition(getOrgId(), {
      from: req.query.from || undefined,
      to:   req.query.to || undefined,
    });
    res.json({ ...rec, text: peopleService.renderRecognition(rec) });
  } catch (err) { fail(res, 'GET /recognition', err); }
});

/** PATCH /api/people/actions/:actionId  { done: boolean } */
router.patch('/actions/:actionId', async (req, res) => {
  try {
    const id = parseInt(req.params.actionId, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid follow-up id' });
    if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'done must be true or false' });

    const action = await peopleRepo.setActionDone(getOrgId(), id, req.body.done);
    if (!action) return res.status(404).json({ error: 'Follow-up not found' });
    res.json({ action });
  } catch (err) { fail(res, 'PATCH /actions', err); }
});

/** PATCH /api/people/:memberId/schedule  { weekday: 0-6 | null, cadence } */
router.patch('/:memberId/schedule', async (req, res) => {
  try {
    const memberId = memberIdParam(req, res);
    if (memberId == null) return;

    const { weekday = null, cadence } = req.body || {};
    if (weekday !== null && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) {
      return res.status(400).json({ error: 'weekday must be 0 (Sunday) to 6 (Saturday), or null for no 1:1' });
    }
    if (cadence !== undefined && !CADENCES.includes(cadence)) {
      return res.status(400).json({ error: `cadence must be one of ${CADENCES.join(', ')}` });
    }

    const member = await peopleRepo.setSchedule(getOrgId(), memberId, { weekday, cadence });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json({ member });
  } catch (err) { fail(res, 'PATCH /schedule', err); }
});

/** GET /api/people/:memberId/prep — the same pack the 1:1 prep DM carries. */
router.get('/:memberId/prep', async (req, res) => {
  try {
    const memberId = memberIdParam(req, res);
    if (memberId == null) return;
    const prep = await peopleService.oneOnOnePrep(getOrgId(), memberId);
    if (!prep) return res.status(404).json({ error: 'Member not found' });
    res.json({ prep, text: peopleService.renderPrep(prep) });
  } catch (err) { fail(res, 'GET /prep', err); }
});

/** GET /api/people/:memberId/one-on-ones — recent 1:1s and follow-ups. */
router.get('/:memberId/one-on-ones', async (req, res) => {
  try {
    const memberId = memberIdParam(req, res);
    if (memberId == null) return;
    const orgId = getOrgId();
    const [oneOnOnes, actions] = await Promise.all([
      peopleRepo.recentOneOnOnes(orgId, memberId, 10),
      peopleRepo.actionsFor(orgId, memberId, { closedSince: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
    ]);
    res.json({ oneOnOnes, actions });
  } catch (err) { fail(res, 'GET /one-on-ones', err); }
});

/**
 * POST /api/people/:memberId/one-on-ones
 * { heldOn: 'YYYY-MM-DD', notes?: string, actions?: [{ owner: 'lead'|'member', text }] }
 */
router.post('/:memberId/one-on-ones', async (req, res) => {
  try {
    const memberId = memberIdParam(req, res);
    if (memberId == null) return;

    const { heldOn, notes = '', actions = [] } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(heldOn || '')) || Number.isNaN(Date.parse(heldOn))) {
      return res.status(400).json({ error: 'heldOn must be a YYYY-MM-DD date' });
    }
    // A day of slack for a lead ahead of the server's timezone.
    if (heldOn > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'A 1:1 cannot be recorded for a future date' });
    }
    if (typeof notes !== 'string' || notes.length > MAX_NOTES) {
      return res.status(400).json({ error: `notes must be text of at most ${MAX_NOTES} characters` });
    }
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) {
      return res.status(400).json({ error: `actions must be a list of at most ${MAX_ACTIONS}` });
    }
    const cleaned = [];
    for (const a of actions) {
      const text = typeof a?.text === 'string' ? a.text.trim() : '';
      if (!text) continue;
      if (!['lead', 'member'].includes(a.owner)) {
        return res.status(400).json({ error: "each follow-up's owner must be 'lead' or 'member'" });
      }
      if (text.length > MAX_ACTION_TEXT) {
        return res.status(400).json({ error: `a follow-up can be at most ${MAX_ACTION_TEXT} characters` });
      }
      cleaned.push({ owner: a.owner, text });
    }

    const orgId = getOrgId();
    const members = await peopleRepo.overview(orgId);
    const member = members.find((m) => m.id === memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const record = await peopleRepo.recordOneOnOne(orgId, memberId, {
      heldOn, notes: notes.trim(), actions: cleaned,
    });

    auditLog.record(orgId, {
      type: 'one_on_one',
      userName: member.name,
      action: `1:1 recorded for ${member.name}${cleaned.length ? ` with ${cleaned.length} follow-up${cleaned.length === 1 ? '' : 's'}` : ''}`,
      success: true,
    });
    res.status(201).json({ oneOnOne: record });
  } catch (err) { fail(res, 'POST /one-on-ones', err); }
});

/**
 * GET /api/people/:memberId/evidence?from=&to=[&format=md]
 * Facts for a performance review. ?format=md returns a Markdown document.
 */
router.get('/:memberId/evidence', async (req, res) => {
  try {
    const memberId = memberIdParam(req, res);
    if (memberId == null) return;
    const pack = await peopleService.evidencePack(getOrgId(), memberId, {
      from: req.query.from, to: req.query.to,
    });
    if (!pack) return res.status(404).json({ error: 'Member not found' });

    if (req.query.format === 'md') {
      const slug = pack.member.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'member';
      res.type('text/markdown');
      res.set('Content-Disposition', `attachment; filename="review-evidence-${slug}-${pack.from}-to-${pack.to}.md"`);
      return res.send(peopleService.renderEvidenceMarkdown(pack));
    }
    res.json({ pack });
  } catch (err) { fail(res, 'GET /evidence', err); }
});

module.exports = router;
