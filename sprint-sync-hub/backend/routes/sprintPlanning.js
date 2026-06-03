'use strict';

const express               = require('express');
const router                = express.Router();
const sprintPlanningService = require('../services/sprintPlanningService');
const memberRepo            = require('../repositories/memberRepository');
const taskRepo              = require('../repositories/taskRepository');
const statsRepo             = require('../repositories/statsRepository');
const sprintRepo            = require('../repositories/sprintRepository');
const zohoService           = require('../services/zohoService');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

// ─── POST /api/sprint-planning/breakdown ────────────────────────────────────
// Call with { goalText, sprintName, startDate, endDate }
// Returns suggested tasks with assignments.
router.post('/breakdown', async (req, res) => {
  try {
    const { goalText, sprintName, startDate, endDate } = req.body;

    if (!goalText || !sprintName || !startDate || !endDate) {
      return res.status(400).json({
        error: 'Missing required fields: goalText, sprintName, startDate, endDate',
      });
    }

    const orgId = ORG_ID();

    // Fetch all active team members
    const members = await memberRepo.findAll(orgId);

    // Get active sprint for task count lookup
    const activeSprint = await sprintRepo.getActiveSprint(orgId);

    // Build member list with current task counts
    const teamMembers = await Promise.all(
      members.map(async (m) => {
        let currentTaskCount = 0;
        if (activeSprint) {
          const tasks = await taskRepo.findBySprintAndAssignee(activeSprint.id, m.id);
          currentTaskCount = tasks.length;
        }
        return {
          id:               m.id,
          name:             m.name,
          role:             m.role || 'Engineer',
          currentTaskCount,
        };
      })
    );

    const totalWorkingDays = sprintPlanningService.countWorkingDays(startDate, endDate);

    const suggestedTasks = await sprintPlanningService.breakdownSprintGoal(
      goalText,
      sprintName,
      startDate,
      endDate,
      teamMembers,
    );

    // Build capacity scores
    const teamCapacity = teamMembers.map((m) => {
      const capacityScore = Math.max(0, Math.min(100,
        100
        - (m.currentTaskCount * 15)
      ));
      return {
        memberId:      m.id,
        name:          m.name,
        currentTasks:  m.currentTaskCount,
        capacityScore,
      };
    });

    return res.json({
      sprintName,
      startDate,
      endDate,
      totalWorkingDays,
      suggestedTasks,
      teamCapacity,
    });
  } catch (err) {
    console.error('[POST /sprint-planning/breakdown]', err.message);
    const status = err.message.includes('AI breakdown failed') ? 500 : 500;
    return res.status(status).json({ error: err.message });
  }
});

// ─── POST /api/sprint-planning/create ───────────────────────────────────────
// Called after team lead reviews and approves the plan.
// Body: { sprintName, startDate, endDate, goalText, tasks, assignments }
router.post('/create', async (req, res) => {
  try {
    const { sprintName, startDate, endDate, goalText, tasks, assignments } = req.body;

    if (!sprintName || !startDate || !endDate || !goalText || !Array.isArray(tasks)) {
      return res.status(400).json({
        error: 'Missing required fields: sprintName, startDate, endDate, goalText, tasks',
      });
    }

    const result = await sprintPlanningService.createSprintFromPlan(
      { name: sprintName, startDate, endDate, goalText },
      tasks,
      assignments || {},
    );

    return res.json(result);
  } catch (err) {
    console.error('[POST /sprint-planning/create]', err.message);

    if (err.message.includes('Manage Sprints permission')) {
      return res.status(403).json({ error: err.message });
    }

    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sprint-planning/capacity ──────────────────────────────────────
// Returns current team capacity for assignment decisions.
router.get('/capacity', async (req, res) => {
  try {
    const orgId        = ORG_ID();
    const members      = await memberRepo.findAll(orgId);
    const activeSprint = await sprintRepo.getActiveSprint(orgId);

    const result = await Promise.all(
      members.map(async (m) => {
        let currentSprintTasks   = 0;
        let completionRateLast   = 0;
        let avgTasksPerSprint    = 0;
        let isOnLeave            = false;

        // Current sprint task count
        if (activeSprint) {
          const tasks = await taskRepo.findBySprintAndAssignee(activeSprint.id, m.id);
          currentSprintTasks = tasks.length;
        }

        // Last sprint completion rate from sprint summary
        try {
          const summary = await statsRepo.getSprintSummary(m.id, activeSprint?.id);
          if (summary) {
            completionRateLast = parseFloat(summary.completion_rate || 0);
            avgTasksPerSprint  = summary.total_tasks || 0;
          }
        } catch { /* non-fatal */ }

        // Zoho leave check
        if (zohoService.isConfigured()) {
          try {
            const today = new Date().toISOString().split('T')[0];
            const leave = await zohoService.isOnLeave(m.email, today);
            isOnLeave   = leave?.onLeave || false;
          } catch { /* non-fatal */ }
        }

        const capacityScore = Math.max(0, Math.min(100,
          100
          - (currentSprintTasks * 15)
          + (completionRateLast / 10)
          - (isOnLeave ? 100 : 0)
        ));

        return {
          id:                      m.id,
          name:                    m.name,
          currentSprintTasks,
          completionRateLastSprint: completionRateLast,
          avgTasksPerSprint,
          isOnLeave,
          capacityScore:           Math.round(capacityScore),
        };
      })
    );

    return res.json({ members: result });
  } catch (err) {
    console.error('[GET /sprint-planning/capacity]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
