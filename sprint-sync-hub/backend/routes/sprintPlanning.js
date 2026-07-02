'use strict';

const express               = require('express');
const router                = express.Router();
const sprintPlanningService = require('../services/sprintPlanningService');
const memberRoleRepository  = require('../repositories/memberRoleRepository');
const memberRepo            = require('../repositories/memberRepository');
const taskRepo              = require('../repositories/taskRepository');
const statsRepo             = require('../repositories/statsRepository');
const sprintRepo            = require('../repositories/sprintRepository');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCapacityLabel(taskCount) {
  if (taskCount === 0) return 'free';
  if (taskCount <= 2)  return 'light';
  if (taskCount <= 4)  return 'moderate';
  return 'heavy';
}

async function buildWorkloadSnapshot(organisationId) {
  const members    = await memberRoleRepository.getAllMembersWithRoles(organisationId);
  const taskCounts = await taskRepo.getActiveTaskCountsPerMember(organisationId);

  return members
    .filter((m) => m.roles.some((r) => r.can_be_assigned_tasks) || m.roles.length === 0)
    .map((m) => ({
      memberId:      m.memberId,
      name:          m.name,
      roles:         m.roles.filter((r) => r.role_type === 'technical').map((r) => r.name),
      roleSlugs:     m.roles.filter((r) => r.role_type === 'technical').map((r) => r.slug),
      currentTasks:  taskCounts[m.memberId] || 0,
      capacityLabel: getCapacityLabel(taskCounts[m.memberId] || 0),
    }));
}

function buildAssignmentSummary(tasks) {
  const byMember = {};
  for (const task of tasks) {
    if (!task.suggestedAssigneeName) continue;
    if (!byMember[task.suggestedAssigneeName]) {
      byMember[task.suggestedAssigneeName] = {
        name:  task.suggestedAssigneeName,
        tasks: [],
      };
    }
    byMember[task.suggestedAssigneeName].tasks.push({
      title:    task.title,
      domain:   task.domain,
      priority: task.priority,
      dueDate:  task.suggestedDueDate,
    });
  }

  const unassigned = tasks.filter((t) => !t.suggestedAssigneeName);

  return {
    byMember:   Object.values(byMember).sort((a, b) => b.tasks.length - a.tasks.length),
    unassigned: unassigned.map((t) => ({
      title:                   t.title,
      domain:                  t.domain,
      requiresManualAssignment: t.requiresManualAssignment,
    })),
  };
}

// ─── POST /api/sprint-planning/breakdown ─────────────────────────────────────

router.post('/breakdown', async (req, res) => {
  const { goalText, sprintName, startDate, endDate, projectId } = req.body;

  if (!goalText || !sprintName || !startDate || !endDate) {
    return res.status(400).json({
      error: 'Missing required fields: goalText, sprintName, startDate, endDate',
    });
  }

  const orgId = ORG_ID();

  try {
    const tasks = await sprintPlanningService.breakdownSprintGoal(
      goalText, sprintName, startDate, endDate, orgId, projectId || null
    );

    // Extract and remove the warning flag if present
    const heavyWarning = tasks._warning || null;
    if (tasks._warning) delete tasks._warning;

    const [workloadSnapshot] = await Promise.all([
      buildWorkloadSnapshot(orgId),
    ]);

    const assignmentSummary = buildAssignmentSummary(tasks);
    const totalWorkingDays  = sprintPlanningService.countWorkingDays(startDate, endDate);

    const response = {
      sprintName,
      startDate,
      endDate,
      totalWorkingDays,
      suggestedTasks:   tasks,
      workloadSnapshot,
      assignmentSummary,
      // Keep teamCapacity for backward compat with existing UI code
      teamCapacity: workloadSnapshot.map((m) => ({
        memberId:      m.memberId,
        name:          m.name,
        currentTasks:  m.currentTasks,
        capacityScore: Math.max(0, 100 - m.currentTasks * 15),
      })),
    };

    if (heavyWarning) response.warning = heavyWarning;

    return res.json(response);
  } catch (err) {
    console.error('[POST /sprint-planning/breakdown]', err.message);

    if (err.message.includes('No team members with technical roles')) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sprint-planning/create ────────────────────────────────────────

router.post('/create', async (req, res) => {
  const { sprintName, startDate, endDate, goalText, tasks, assignments } = req.body;

  if (!sprintName || !startDate || !endDate || !goalText || !Array.isArray(tasks)) {
    return res.status(400).json({
      error: 'Missing required fields: sprintName, startDate, endDate, goalText, tasks',
    });
  }

  try {
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
    if (err.validationErrors) {
      return res.status(400).json({
        error:    err.message,
        errors:   err.validationErrors,
        warnings: err.validationWarnings || [],
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sprint-planning/capacity ───────────────────────────────────────

router.get('/capacity', async (req, res) => {
  try {
    const orgId        = ORG_ID();
    const members      = await memberRepo.findAll(orgId);
    const activeSprint = await sprintRepo.getActiveSprint(orgId);

    const result = await Promise.all(
      members.map(async (m) => {
        let currentSprintTasks    = 0;
        let completionRateLast    = 0;
        let avgTasksPerSprint     = 0;
        // Leave-aware capacity isn't available — the Zoho People Leave API
        // is disabled on this account (see zohoService.js header comment).
        const isOnLeave           = false;

        if (activeSprint) {
          const tasks = await taskRepo.findBySprintAndAssignee(activeSprint.id, m.id);
          currentSprintTasks = tasks.length;
        }

        try {
          const summary = await statsRepo.getSprintSummary(m.id, activeSprint?.id);
          if (summary) {
            completionRateLast = parseFloat(summary.completion_rate || 0);
            avgTasksPerSprint  = summary.total_tasks || 0;
          }
        } catch { /* non-fatal */ }

        const capacityScore = Math.max(0, Math.min(100,
          100 - (currentSprintTasks * 15) + (completionRateLast / 10)
        ));

        return {
          id:                       m.id,
          name:                     m.name,
          currentSprintTasks,
          completionRateLastSprint: completionRateLast,
          avgTasksPerSprint,
          isOnLeave,
          capacityScore:            Math.round(capacityScore),
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
