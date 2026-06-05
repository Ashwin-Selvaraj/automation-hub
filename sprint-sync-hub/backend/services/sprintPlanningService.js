'use strict';

/**
 * sprintPlanningService.js
 * Handles all AI-powered sprint planning operations.
 * Orchestrates between claudeService, jiraService, slackService, and repositories.
 */

const Anthropic         = require('@anthropic-ai/sdk');
const jiraService       = require('./jiraService');
const slackService      = require('./slackService');
const activityLog       = require('./activityLog');
const configService     = require('./configService');
const assignmentEngine     = require('./assignmentEngine');
const sprintRepo           = require('../repositories/sprintRepository');
const memberRepo           = require('../repositories/memberRepository');
const taskRepo             = require('../repositories/taskRepository');
const statsRepo            = require('../repositories/statsRepository');
const memberRoleRepository = require('../repositories/memberRoleRepository');

const MODEL = 'claude-sonnet-4-20250514';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

/**
 * Count working days between two date strings (Mon–Fri only).
 * @param {string} startDate - "YYYY-MM-DD"
 * @param {string} endDate   - "YYYY-MM-DD"
 * @returns {number}
 */
function countWorkingDays(startDate, endDate) {
  let count = 0;
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Takes a plain-English sprint goal and returns a structured list of tasks
 * with titles, descriptions, priorities, estimates, and suggested assignments.
 *
 * @param {string} goalText
 * @param {string} sprintName
 * @param {string} startDate   - "YYYY-MM-DD"
 * @param {string} endDate     - "YYYY-MM-DD"
 * @param {Array}  teamMembers - [{ id, name, role, currentTaskCount }]
 * @returns {Promise<Array>}
 */
async function breakdownSprintGoal(goalText, sprintName, startDate, endDate, teamMembers) {
  const totalDays = countWorkingDays(startDate, endDate);
  const client    = getAnthropicClient();

  const systemPrompt = `You are an expert engineering project manager and sprint planner.
Your job is to take a team lead's sprint goal description and break it
into concrete, actionable Jira tasks.

Rules:
- Each task must be specific and independently completable
- Task titles must start with a verb: "Implement", "Create", "Fix", "Add", "Build", "Write", "Test"
- Descriptions must be 2-3 sentences explaining what done looks like
- Priority: Highest for blocking/security tasks, High for core features, Medium for supporting work, Low for nice-to-haves
- Estimated days: be realistic, 1-5 days per task
- Due dates: spread evenly across the sprint, critical tasks due in first half
- Skill tags: 1-3 technical keywords e.g. ["Node.js", "API"], ["React", "UI"], ["PostgreSQL"]
- Suggested assignee: match skill tags to team member roles and past work
- Never create more than 15 tasks from one goal
- Never create fewer than 3 tasks

Respond ONLY with a valid JSON array. No preamble, no explanation, no markdown.
Schema for each task:
{
  "title": string,
  "description": string,
  "priority": "Highest"|"High"|"Medium"|"Low",
  "estimatedDays": number,
  "suggestedDueDate": "YYYY-MM-DD",
  "skillTags": string[],
  "suggestedAssigneeName": string|null,
  "assignmentReason": string
}`;

  // Build role-aware team description
  const orgId = parseInt(process.env.ORGANISATION_ID || '1', 10);
  let membersWithRoles = [];
  try {
    membersWithRoles = await memberRoleRepository.getAllMembersWithRoles(orgId);
  } catch (_) {}

  const roleDataByName = new Map(membersWithRoles.map((m) => [m.name, m]));

  const memberLines = teamMembers
    .map((m) => {
      const roleData = roleDataByName.get(m.name);
      const techRoles = roleData
        ? roleData.roles.filter((r) => r.role_type === 'technical').map((r) => r.name)
        : [];
      const roleLabel = techRoles.length > 0 ? techRoles.join(', ') : 'Engineer';
      return `- ${m.name}: ${roleLabel} (currently has ${m.currentTaskCount} tasks)`;
    })
    .join('\n');

  const userPrompt = `Sprint: ${sprintName}
Duration: ${startDate} to ${endDate} (${totalDays} working days)
Sprint goal: ${goalText}

Team members available for task assignment (technical roles only):
${memberLines}

Important: Only suggest assignees whose roles match the task type.
Backend tasks → Backend Developer or Full Stack Developer only.
Frontend tasks → Frontend Developer or Full Stack Developer only.
AI tasks → AI Engineer only.
Blockchain tasks → Blockchain Developer only.
Design tasks → UI/UX Designer only.

Break this into tasks now.`;

  let rawText;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      rawText = resp.content[0]?.text || '';
      break;
    } catch (err) {
      if (attempt === 2) throw new Error(`AI breakdown failed — please try again. (${err.message})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Strip possible markdown code fence
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let tasks;
  try {
    tasks = JSON.parse(cleaned);
  } catch {
    throw new Error('AI breakdown failed — please try again. (Invalid JSON response)');
  }

  if (!Array.isArray(tasks)) throw new Error('AI returned unexpected format — please try again.');

  // Validate required fields on each task
  const parsedTasks = tasks.map((task) => {
    const required = ['title', 'description', 'priority', 'estimatedDays', 'suggestedDueDate', 'skillTags'];
    for (const f of required) {
      if (task[f] === undefined) throw new Error(`AI task missing field "${f}"`);
    }
    return {
      title:            task.title,
      description:      task.description,
      priority:         task.priority,
      estimatedDays:    task.estimatedDays,
      suggestedDueDate: task.suggestedDueDate,
      skillTags:        task.skillTags || [],
    };
  });

  // ── Use assignment engine for smart, data-driven suggestions ─────────────
  let assignmentPlan;
  try {
    assignmentPlan = await assignmentEngine.generateAssignmentPlan(
      parsedTasks,
      teamMembers,
      orgId,
      { startDate, endDate },
    );
  } catch (err) {
    console.warn('[sprintPlanningService] Assignment engine failed, falling back to unassigned:', err.message);
    // Graceful degradation — return tasks without assignments rather than failing
    assignmentPlan = parsedTasks.map((_, i) => ({
      taskIndex:               i,
      recommendedMemberId:     null,
      recommendedMemberName:   null,
      score:                   50,
      reasons:                 ['No historical data yet'],
      alternativeMemberId:     null,
      alternativeMemberName:   null,
      allRankings:             [],
    }));
  }

  return parsedTasks.map((task, index) => ({
    ...task,
    suggestedAssigneeId:     assignmentPlan[index]?.recommendedMemberId     || null,
    suggestedAssigneeName:   assignmentPlan[index]?.recommendedMemberName   || null,
    assignmentScore:         assignmentPlan[index]?.score                   || 50,
    assignmentReasons:       assignmentPlan[index]?.reasons                 || [],
    // Keep single-string reason for backward compat with older UI code
    assignmentReason:        (assignmentPlan[index]?.reasons || []).join(' · '),
    alternativeAssigneeId:   assignmentPlan[index]?.alternativeMemberId     || null,
    alternativeAssigneeName: assignmentPlan[index]?.alternativeMemberName   || null,
    allRankings:             assignmentPlan[index]?.allRankings             || [],
  }));
}

/**
 * Executes the sprint creation in Jira after team lead approves the plan.
 *
 * @param {Object} sprintData   - { name, startDate, endDate, goalText }
 * @param {Array}  tasks        - Array from breakdownSprintGoal() with any edits applied
 * @param {Object} assignmentMap - { "taskIndex": memberId }
 * @returns {Promise<Object>}
 */
async function createSprintFromPlan(sprintData, tasks, assignmentMap) {
  const cfg       = configService.getSprintConfig();
  const orgId     = parseInt(process.env.ORGANISATION_ID || '1', 10);
  const projectKey = cfg.projectKey;
  const channelId  = cfg.channelId;
  const channelName = process.env.SLACK_CHANNEL_NAME || cfg.channelId;
  const { name, startDate, endDate, goalText } = sprintData;

  // ── STEP 1: Create sprint in Jira ──────────────────────────────────────────
  let boardId;
  try {
    boardId = await jiraService.getJiraBoardId(projectKey);
  } catch (err) {
    throw new Error(`Could not get Jira board ID: ${err.message}`);
  }

  let jiraSprint;
  try {
    jiraSprint = await jiraService.createSprint(projectKey, name, startDate, endDate, boardId);
  } catch (err) {
    throw err; // propagate permission errors directly
  }

  try {
    await jiraService.startSprint(jiraSprint.id);
  } catch (err) {
    // Non-fatal — sprint may have started or may need manual activation
    console.warn('[sprintPlanningService] startSprint warning:', err.message);
  }

  // ── STEP 2: Save sprint to local DB ────────────────────────────────────────
  const durationWeeks = Math.ceil(countWorkingDays(startDate, endDate) / 5);
  let dbSprint;
  try {
    dbSprint = await sprintRepo.upsertSprint(orgId, name, startDate, endDate, durationWeeks);
    if (dbSprint) await sprintRepo.setActive(dbSprint.id, orgId);
  } catch (err) {
    console.error('[sprintPlanningService] DB sprint save error:', err.message);
    dbSprint = { id: null };
  }

  // ── STEP 3: Resolve Jira account IDs for all assignees ─────────────────────
  const uniqueMemberIds = [...new Set(Object.values(assignmentMap).filter(Boolean))];
  const memberIdToJiraId = {};

  await Promise.all(
    uniqueMemberIds.map(async (memberId) => {
      try {
        const member = await memberRepo.findById(memberId);
        if (member?.email) {
          const jiraAccountId = await jiraService.getMemberJiraAccountId(member.email);
          memberIdToJiraId[memberId] = jiraAccountId;
        }
      } catch (err) {
        console.warn(`[sprintPlanningService] Could not resolve Jira ID for member ${memberId}:`, err.message);
      }
    })
  );

  // ── STEP 4: Build issues array ─────────────────────────────────────────────
  const issuePayloads = tasks.map((task, idx) => {
    const assignedMemberId = assignmentMap[String(idx)] || assignmentMap[idx] || null;
    const jiraAccountId    = assignedMemberId ? memberIdToJiraId[assignedMemberId] || null : null;
    return {
      projectKey,
      summary:            task.title,
      description:        task.description,
      priority:           task.priority,
      assigneeAccountId:  jiraAccountId,
      dueDate:            task.suggestedDueDate || null,
      sprintId:           jiraSprint.id,
      issueType:          'Task',
      _memberId:          assignedMemberId,
    };
  });

  // ── STEP 5: Create all issues in Jira ──────────────────────────────────────
  const jiraResults = await jiraService.createIssuesBatch(issuePayloads);

  // ── STEP 6: Save tasks to local DB ─────────────────────────────────────────
  if (dbSprint?.id) {
    for (let i = 0; i < jiraResults.length; i++) {
      const result = jiraResults[i];
      if (!result.success) continue;
      const payload   = issuePayloads[i];
      const task      = tasks[i];
      try {
        await taskRepo.upsertTask(
          orgId,
          dbSprint.id,
          result.key,
          task.title,
          'To Do',
          task.priority,
          payload._memberId || null,
          task.suggestedDueDate || null,
          new Date().toISOString(),
        );
      } catch (err) {
        console.error('[sprintPlanningService] DB task save error:', err.message);
      }
    }
  }

  // ── STEP 7: Build and post kickoff message ─────────────────────────────────
  let kickoffMessageSent = false;
  try {
    // Group created issues by assigned member
    const memberTasks = {};
    for (let i = 0; i < jiraResults.length; i++) {
      if (!jiraResults[i].success) continue;
      const memberId = issuePayloads[i]._memberId;
      if (!memberId) continue;
      if (!memberTasks[memberId]) memberTasks[memberId] = [];
      memberTasks[memberId].push({
        key:     jiraResults[i].key,
        title:   tasks[i].title,
        dueDate: tasks[i].suggestedDueDate,
      });
    }

    // Fetch member names
    const allMembers = await memberRepo.findAll(orgId);
    const memberById = {};
    for (const m of allMembers) memberById[m.id] = m;

    const lines = [`🚀 *${name} has started!*  (${startDate} → ${endDate})`, ''];
    lines.push(`*Sprint Goal:* ${goalText}`, '');
    lines.push('*Your tasks this sprint:*');

    for (const [memberId, memberTaskList] of Object.entries(memberTasks)) {
      const member = memberById[memberId];
      if (!member) continue;
      lines.push(`\n<@${member.slack_user_id || member.name}>`);
      for (const t of memberTaskList) {
        lines.push(`  • ${t.key}: ${t.title} — due ${t.dueDate || 'TBD'}`);
      }
    }

    lines.push('');
    lines.push('Good luck team — post your daily updates in this channel by 6 PM 🙌');

    await slackService.postToChannel(channelId, lines.join('\n'));
    kickoffMessageSent = true;
  } catch (err) {
    console.error('[sprintPlanningService] Kickoff message failed:', err.message);
  }

  // ── STEP 8: Log to activity log ────────────────────────────────────────────
  const tasksCreated = jiraResults.filter((r) => r.success).length;
  const tasksFailed  = jiraResults.filter((r) => !r.success).length;
  activityLog.addEntry({
    type:    'sprint_created',
    action:  `Sprint ${name} created with ${tasksCreated} tasks`,
    success: true,
    details: `${tasksFailed} tasks failed to create`,
  });

  // ── STEP 9: Return result summary ──────────────────────────────────────────
  return {
    sprintId:           dbSprint?.id || null,
    jiraSprintId:       jiraSprint.id,
    tasksCreated,
    tasksFailed,
    createdIssues:      jiraResults,
    kickoffMessageSent,
    jiraSiteUrl:        process.env.JIRA_SITE_URL || '',
  };
}

module.exports = { breakdownSprintGoal, createSprintFromPlan, countWorkingDays };
