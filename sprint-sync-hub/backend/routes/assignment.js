'use strict';

const express           = require('express');
const router            = express.Router();
const skillExtraction   = require('../services/skillExtractionService');
const assignmentEngine  = require('../services/assignmentEngine');
const memberRepo        = require('../repositories/memberRepository');
const taskRepo          = require('../repositories/taskRepository');
const sprintRepo        = require('../repositories/sprintRepository');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

// ─── GET /api/assignment/profiles ───────────────────────────────────────────
// Returns skill profile for every active team member.
router.get('/profiles', async (req, res) => {
  try {
    const orgId   = ORG_ID();
    const members = await memberRepo.findAll(orgId);

    const profiles = await Promise.all(
      members.map(async (m) => {
        const profile = await skillExtraction.getMemberProfile(orgId, m.id);
        return {
          id:                     m.id,
          name:                   m.name,
          topSkills:              profile.topSkills || [],
          recentSkills:           profile.recentSkills || [],
          totalMessagesAnalysed:  profile.totalMessagesAnalysed || 0,
        };
      })
    );

    return res.json({ members: profiles });
  } catch (err) {
    console.error('[GET /assignment/profiles]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/assignment/rebuild-profiles ──────────────────────────────────
// Triggers a full skill profile rebuild from standup history.
// Returns immediately — rebuild runs in background.
router.post('/rebuild-profiles', (req, res) => {
  const orgId = ORG_ID();
  res.json({ started: true, message: 'Skill profile rebuild started. Check server logs for progress.' });

  // Run in background — do not await
  setImmediate(async () => {
    try {
      console.log('[assignment/rebuild-profiles] Starting full skill profile rebuild…');
      skillExtraction.invalidateCache();
      const profiles = await skillExtraction.buildAllMemberSkillProfiles(orgId);
      console.log(`[assignment/rebuild-profiles] Done. Built ${profiles.size} profiles.`);
    } catch (err) {
      console.error('[assignment/rebuild-profiles] Rebuild failed:', err.message);
    }
  });
});

// ─── POST /api/assignment/rank ───────────────────────────────────────────────
// Given a single task, return ranked member scores.
router.post('/rank', async (req, res) => {
  try {
    const { taskTitle, taskDescription, skillTags, sprintStartDate, sprintEndDate } = req.body;

    if (!taskTitle) {
      return res.status(400).json({ error: 'taskTitle is required' });
    }

    const orgId   = ORG_ID();
    const members = await memberRepo.findAll(orgId);

    // Enrich members with current task counts
    const activeSprint = await sprintRepo.getActiveSprint(orgId);
    const enriched     = await Promise.all(
      members.map(async (m) => {
        let currentTaskCount = 0;
        if (activeSprint) {
          const tasks = await taskRepo.findBySprintAndAssignee(activeSprint.id, m.id);
          currentTaskCount = tasks.length;
        }
        return { ...m, currentTaskCount };
      })
    );

    const task = {
      title:       taskTitle,
      description: taskDescription || '',
      skillTags:   skillTags || [],
    };

    const [plan] = await assignmentEngine.generateAssignmentPlan(
      [task],
      enriched,
      orgId,
      { startDate: sprintStartDate, endDate: sprintEndDate },
    );

    return res.json({
      task:     { title: taskTitle, skillTags: skillTags || [] },
      rankings: plan?.allRankings || [],
      recommended: {
        memberId: plan?.recommendedMemberId,
        name:     plan?.recommendedMemberName,
        score:    plan?.score,
        reasons:  plan?.reasons,
      },
      alternative: {
        memberId: plan?.alternativeMemberId,
        name:     plan?.alternativeMemberName,
      },
    });
  } catch (err) {
    console.error('[POST /assignment/rank]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
