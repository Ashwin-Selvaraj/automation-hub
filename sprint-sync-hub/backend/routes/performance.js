'use strict';

const express = require('express');
const router = express.Router();
const performanceService = require('../services/performanceService');
const statsRepo          = require('../repositories/statsRepository');
const notifRepo          = require('../repositories/notificationRepository');
const sprintRepo         = require('../repositories/sprintRepository');
const scoringService     = require('../services/scoringService');
const memberRoleRepository = require('../repositories/memberRoleRepository');

function orgId() {
  return parseInt(process.env.ORGANISATION_ID || '1', 10);
}

async function resolveSprintId(req) {
  const raw = req.query.sprintId || req.params.sprintId;
  if (raw) return parseInt(raw, 10);
  const active = await sprintRepo.getActiveSprint(orgId());
  return active ? active.id : null;
}

// GET /api/performance/leaderboard?sprintId=X
router.get('/leaderboard', async (req, res) => {
  try {
    const sprintId = await resolveSprintId(req);
    if (!sprintId) return res.json([]);
    await performanceService.refreshAllMemberSummaries(orgId(), sprintId);
    const leaderboard = await performanceService.getTeamLeaderboard(orgId(), sprintId);
    res.json(leaderboard);
  } catch (err) {
    console.error('[GET /api/performance/leaderboard]', err.message);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// GET /api/performance/member/:memberId?sprintId=X
router.get('/member/:memberId', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    const sprintId = await resolveSprintId(req);
    const profile  = await performanceService.getMemberProfile(orgId(), memberId);
    if (!profile) return res.status(404).json({ error: 'Member not found' });

    if (sprintId) {
      profile.currentSummary = await statsRepo.getSprintSummary(memberId, sprintId);
    }
    res.json(profile);
  } catch (err) {
    console.error('[GET /api/performance/member]', err.message);
    res.status(500).json({ error: 'Failed to load member profile' });
  }
});

// GET /api/performance/member/:memberId/history
router.get('/member/:memberId/history', async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    const limit    = parseInt(req.query.limit || '5', 10);
    const history  = await statsRepo.getCrossSprintTrend(memberId, orgId(), limit);
    res.json(history);
  } catch (err) {
    console.error('[GET /api/performance/member/history]', err.message);
    res.status(500).json({ error: 'Failed to load member history' });
  }
});

// GET /api/performance/team/at-risk?sprintId=X
router.get('/team/at-risk', async (req, res) => {
  try {
    const sprintId = await resolveSprintId(req);
    if (!sprintId) return res.json([]);
    await performanceService.refreshAllMemberSummaries(orgId(), sprintId);
    const atRisk = await performanceService.getAtRiskMembers(orgId(), sprintId);
    res.json(atRisk);
  } catch (err) {
    console.error('[GET /api/performance/team/at-risk]', err.message);
    res.status(500).json({ error: 'Failed to load at-risk members' });
  }
});

// GET /api/performance/sprint/:sprintId/summary
router.get('/sprint/:sprintId/summary', async (req, res) => {
  try {
    const sprintId  = parseInt(req.params.sprintId, 10);
    const summaries = await statsRepo.getAllSprintSummaries(sprintId);
    res.json(summaries);
  } catch (err) {
    console.error('[GET /api/performance/sprint/summary]', err.message);
    res.status(500).json({ error: 'Failed to load sprint summary' });
  }
});

// POST /api/performance/sprint/:sprintId/compute
router.post('/sprint/:sprintId/compute', async (req, res) => {
  try {
    const sprintId  = parseInt(req.params.sprintId, 10);
    const memberRepo = require('../repositories/memberRepository');
    const members   = await memberRepo.findAll(orgId());
    const results   = [];
    for (const m of members) {
      const summary = await performanceService.computeSprintSummary(orgId(), sprintId, m.id);
      results.push({ memberId: m.id, name: m.name, summary });
    }
    res.json({ computed: results.length, results });
  } catch (err) {
    console.error('[POST /api/performance/sprint/compute]', err.message);
    res.status(500).json({ error: 'Failed to compute sprint summary' });
  }
});

// GET /api/performance/dashboard?sprintId=X
router.get('/dashboard', async (req, res) => {
  try {
    const sprintId = await resolveSprintId(req);
    if (!sprintId) {
      return res.json({ teamStats: null, leaderboard: [], atRisk: [], recentActivity: [] });
    }

    await performanceService.refreshAllMemberSummaries(orgId(), sprintId);

    const [leaderboard, atRisk, recentActivityRaw, allSummariesRaw, managerialKeys] = await Promise.all([
      performanceService.getTeamLeaderboard(orgId(), sprintId),
      performanceService.getAtRiskMembers(orgId(), sprintId),
      notifRepo.getRecentActivity(orgId(), 20),
      statsRepo.getAllSprintSummaries(sprintId),
      memberRoleRepository.getManagerialMemberKeys(orgId()),
    ]);

    // This app tracks IC activity/performance only — exclude managerial members.
    const recentActivity = recentActivityRaw.filter((a) => !managerialKeys.memberIds.has(a.member_id));
    const allSummaries   = allSummariesRaw.filter((m) => !managerialKeys.memberIds.has(m.member_id));

    const teamStats = allSummaries.length > 0 ? {
      avgScore:       Math.round(allSummaries.reduce((s, m) => s + parseFloat(m.performance_score || 0), 0) / allSummaries.length),
      avgCompletion:  Math.round(allSummaries.reduce((s, m) => s + parseFloat(m.completion_rate || 0), 0) / allSummaries.length),
      avgDeadlineRate: Math.round(allSummaries.reduce((s, m) => s + parseFloat(m.deadline_hit_rate || 0), 0) / allSummaries.length),
      avgStandupRate: Math.round(allSummaries.reduce((s, m) => {
        const rate = m.standup_days_expected > 0
          ? m.standup_days_posted / m.standup_days_expected : 1;
        return s + rate * 100;
      }, 0) / allSummaries.length),
      totalMembers:   allSummaries.length,
    } : null;

    res.json({
      teamStats,
      leaderboard: leaderboard.slice(0, 5),
      atRisk,
      recentActivity,
    });
  } catch (err) {
    console.error('[GET /api/performance/dashboard]', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

module.exports = router;
