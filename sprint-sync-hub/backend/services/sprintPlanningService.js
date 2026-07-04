'use strict';

const Anthropic             = require('@anthropic-ai/sdk');
const jiraService           = require('./jiraService');
const slackService          = require('./slackService');
const activityLog           = require('./activityLog');
const configService         = require('./configService');
const skillExtraction       = require('./skillExtractionService');
const sprintRepo            = require('../repositories/sprintRepository');
const memberRepo            = require('../repositories/memberRepository');
const taskRepo              = require('../repositories/taskRepository');
const statsRepo             = require('../repositories/statsRepository');
const memberRoleRepository  = require('../repositories/memberRoleRepository');

const MODEL = 'claude-opus-4-8';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

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

// ─── Domain detection ─────────────────────────────────────────────────────────

const DOMAIN_KEYWORDS = {
  backend: [
    'api','endpoint','rest','graphql','server','database','migration',
    'authentication','authorisation','authorization','middleware','node.js','python',
    'backend','service','queue','cron','webhook','microservice',
    'postgresql','mongodb','redis','cache','schema','sql',
  ],
  frontend: [
    'ui','component','screen','page','form','button','layout','css',
    'react','vue','angular','next.js','typescript','responsive',
    'animation','frontend','interface','view','dashboard','widget',
    'navigation','modal','table','chart','design implementation',
  ],
  ai: [
    'ai','ml','model','training','llm','claude','openai','embedding',
    'vector','rag','fine-tuning','inference','prompt','nlp',
    'machine learning','neural','tensorflow','pytorch',
  ],
  blockchain: [
    'blockchain','smart contract','web3','solidity','ethereum',
    'nft','defi','wallet','token','erc20','hardhat','truffle',
    'decentralised','crypto',
  ],
  design: [
    'figma','wireframe','mockup','prototype','user research',
    'design system','typography','spacing','accessibility',
    'visual design','ux flow','user journey','icon',
  ],
};

// Keywords that need whole-word matching (too short to use substring safely)
const WHOLE_WORD_KW = new Set(['ui','ai','ml','css','vue','api','sql','rag','nlp','nft','ux']);

function kwMatch(text, keyword) {
  if (WHOLE_WORD_KW.has(keyword)) {
    // Match as whole word: surrounded by non-alphanumeric or start/end
    return new RegExp(`(?:^|[^a-z0-9])${keyword}(?:[^a-z0-9]|$)`).test(text);
  }
  return text.includes(keyword);
}

function detectDomain(task) {
  const text = [
    task.title || '',
    task.description || '',
    ...(task.skillTags || []),
  ].join(' ').toLowerCase();

  const hits = {};
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    hits[domain] = keywords.filter((k) => kwMatch(text, k)).length;
  }

  if (hits.backend > 0 && hits.frontend > 0) return 'fullstack';
  if (hits.ai > 0)         return 'ai';
  if (hits.blockchain > 0) return 'blockchain';
  if (hits.design > 0)     return 'design';
  if (hits.backend > 0)    return 'backend';
  if (hits.frontend > 0)   return 'frontend';
  return 'general';
}

const VALID_DOMAINS = new Set(['backend','frontend','ai','blockchain','design','fullstack','general']);

function sanitiseDomain(raw) {
  const d = (raw || '').toLowerCase().trim();
  return VALID_DOMAINS.has(d) ? d : null;
}

// ─── Eligible pool ────────────────────────────────────────────────────────────

const DOMAIN_SLUGS = {
  backend:    ['backend_developer', 'full_stack_developer'],
  frontend:   ['frontend_developer', 'full_stack_developer'],
  ai:         ['ai_engineer'],
  blockchain: ['blockchain_developer'],
  design:     ['ui_ux_designer'],
  fullstack:  ['full_stack_developer', 'backend_developer', 'frontend_developer'],
  general:    null,
};

function getEligiblePool(domain, members) {
  const allowedSlugs = DOMAIN_SLUGS[domain] ?? null;

  if (allowedSlugs === null) {
    return members.filter((m) => m.roles.some((r) => r.can_be_assigned_tasks));
  }

  const pool = members.filter((m) =>
    (m.roleSlugs || []).some((s) => allowedSlugs.includes(s))
  );

  if (pool.length === 0) {
    const fsPool = members.filter((m) => (m.roleSlugs || []).includes('full_stack_developer'));
    if (fsPool.length > 0) {
      console.warn(`[sprintPlanning] No ${domain} engineers — falling back to full_stack pool`);
      return fsPool;
    }
    console.warn(`[sprintPlanning] No full_stack engineers either — falling back to all assignable`);
    return members.filter((m) => m.roles.some((r) => r.can_be_assigned_tasks));
  }

  return pool;
}

// ─── Member scoring ───────────────────────────────────────────────────────────

function scoreMemberForTask(member, task, currentTasks, plannedTasks, sprintHistory, skillProfile) {
  let score = 100;
  const reasons = [];

  // CURRENT TASK DEDUCTIONS (current Jira tasks + already-planned tasks this session)
  const totalTasks = currentTasks + plannedTasks;
  const deductions = [0, -10, -20, -35, -50, -65, -80];
  const deduction  = deductions[Math.min(totalTasks, 6)];
  score += deduction;

  if (totalTasks === 0) {
    reasons.push('No current tasks — full capacity');
  } else {
    const load = deduction >= -20 ? 'light' : deduction >= -35 ? 'moderate' : 'heavy';
    reasons.push(`${totalTasks} existing task${totalTasks !== 1 ? 's' : ''} (${load} load)`);
  }

  // PAST DELIVERY RATE BONUS
  if (sprintHistory.length > 0) {
    const avg = sprintHistory.reduce((s, h) => s + parseFloat(h.completion_rate || 0), 0) / sprintHistory.length;
    if (avg >= 90)      { score += 15; reasons.push(`${Math.round(avg)}% avg completion rate`); }
    else if (avg >= 75) { score += 10; reasons.push(`${Math.round(avg)}% avg completion rate`); }
    else if (avg >= 60) { score += 5;  reasons.push(`${Math.round(avg)}% completion rate`); }
    else                { score -= 10; reasons.push(`Low completion rate: ${Math.round(avg)}%`); }
  }

  // SKILL MATCH BONUS
  if (skillProfile && task.skillTags && task.skillTags.length > 0) {
    const memberKeywords = (skillProfile.recentSkills || []).map((s) => s.toLowerCase());
    const taskTags = task.skillTags.map((t) => t.toLowerCase());
    const matches = taskTags.filter((tag) =>
      memberKeywords.some((kw) => kw.includes(tag) || tag.includes(kw))
    );
    if (matches.length > 0) {
      const bonus = Math.min(matches.length * 5, 15);
      score += bonus;
      reasons.push(`Skill match: ${matches.slice(0, 3).join(', ')}`);
    }
  }

  return { total: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

// ─── Team description for Claude ─────────────────────────────────────────────

function buildTeamDescription(members, currentTaskCounts, performanceData) {
  return members.map((m) => {
    const techRoles = m.roles
      .filter((r) => r.role_type === 'technical')
      .map((r) => r.name)
      .join(', ') || 'Engineer';

    const ct = currentTaskCounts[m.memberId] || 0;
    const capacityNote =
      ct === 0     ? 'free' :
      ct <= 2      ? `light load (${ct} tasks)` :
      ct <= 4      ? `moderate load (${ct} tasks)` :
                     `heavy load (${ct} tasks)`;

    const history = performanceData[m.memberId] || [];
    const perfNote = history.length > 0
      ? `${Math.round(history[0].completion_rate || 0)}% completion last sprint`
      : 'no sprint history yet';

    return `- ${m.name} [${techRoles}]: ${capacityNote}, ${perfNote}`;
  }).join('\n');
}

// ─── Post-assignment enrichment ───────────────────────────────────────────────

async function enrichTasksWithAssignments(tasks, members, currentTaskCounts, performanceData, skillProfiles) {
  const plannedTaskCounts = {};
  for (const m of members) plannedTaskCounts[m.memberId] = 0;

  const enriched = [];

  for (const task of tasks) {
    const eligiblePool = getEligiblePool(task.domain, members);

    if (eligiblePool.length === 0) {
      enriched.push({
        ...task,
        suggestedAssigneeId:     null,
        suggestedAssigneeName:   null,
        assignmentScore:         0,
        assignmentReasons:       [`No ${task.domain} engineers in team — manual assignment required`],
        alternativeAssigneeId:   null,
        alternativeAssigneeName: null,
        allRankings:             [],
        requiresManualAssignment: true,
      });
      continue;
    }

    const rankings = eligiblePool.map((member) => {
      const { total, reasons } = scoreMemberForTask(
        member,
        task,
        currentTaskCounts[member.memberId] || 0,
        plannedTaskCounts[member.memberId] || 0,
        performanceData[member.memberId]   || [],
        skillProfiles.get(member.memberId),
      );
      return { ...member, score: total, reasons };
    }).sort((a, b) => b.score - a.score);

    // Workload balancing: if top member has ≥2 more planned tasks than second
    // and score gap is ≤20, assign to second instead
    let chosen = rankings[0];
    const second = rankings[1];

    if (
      second &&
      plannedTaskCounts[chosen.memberId] >= plannedTaskCounts[second.memberId] + 2 &&
      chosen.score - second.score <= 20
    ) {
      console.log(
        `[sprintPlanning] Workload balance: assigning "${task.title}" to ${second.name} instead of ${chosen.name}` +
        ` (${plannedTaskCounts[chosen.memberId]} vs ${plannedTaskCounts[second.memberId]} planned tasks)`
      );
      chosen = second;
    }

    plannedTaskCounts[chosen.memberId] += 1;

    const alt = rankings.find((r) => r.memberId !== chosen.memberId);

    enriched.push({
      ...task,
      suggestedAssigneeId:     chosen.memberId,
      suggestedAssigneeName:   chosen.name,
      assignmentScore:         chosen.score,
      assignmentReasons:       chosen.reasons,
      alternativeAssigneeId:   alt?.memberId   || null,
      alternativeAssigneeName: alt?.name       || null,
      allRankings:             rankings.slice(0, 5).map((r) => ({
        memberId: r.memberId,
        name:     r.name,
        score:    r.score,
        reasons:  r.reasons,
      })),
      requiresManualAssignment: false,
    });
  }

  return enriched;
}

// ─── Carryover from previous sprint ───────────────────────────────────────────

/**
 * Incomplete tasks from the most recent sprint, offered as opt-in suggestions
 * when planning the next one. Read-only — nothing is selected/merged until the
 * caller passes matching IDs back into breakdownSprintGoal via carryoverTaskIds.
 */
async function getCarryoverCandidates(organisationId) {
  const orgId = organisationId || parseInt(process.env.ORGANISATION_ID || '1', 10);
  const previousSprint = await sprintRepo.getMostRecent(orgId);
  if (!previousSprint) return { previousSprint: null, tasks: [] };

  const incomplete = await taskRepo.getIncompleteTasksBySprint(previousSprint.id);
  const today = new Date().toISOString().split('T')[0];

  const tasks = incomplete.map((t) => ({
    taskId:       t.id,
    jiraKey:      t.jira_key,
    title:        t.title,
    status:       t.status,
    priority:     t.priority || 'Medium',
    domain:       detectDomain({ title: t.title }),
    dueDate:      t.due_date,
    assigneeId:   t.assignee_id,
    assigneeName: t.assignee_name || null,
    overdue:      t.due_date ? String(t.due_date).split('T')[0] < today : false,
  }));

  return {
    previousSprint: { id: previousSprint.id, name: previousSprint.name, endDate: previousSprint.end_date },
    tasks,
  };
}

/** Converts an approved carryover candidate into the same shape enrichTasksWithAssignments produces. */
function buildCarryoverTask(row, membersById, newSprintStartDate) {
  const assignee = row.assignee_id ? membersById.get(row.assignee_id) : null;
  return {
    title:            row.title,
    description:      `Carried over from last sprint (${row.jira_key}) — was not completed.`,
    domain:           detectDomain({ title: row.title }),
    priority:         row.priority || 'Medium',
    estimatedDays:    2,
    suggestedDueDate: newSprintStartDate,
    skillTags:        [],
    assignmentReason: assignee ? 'Carried over — same assignee as last sprint' : 'Carried over — previous assignee unavailable, needs manual assignment',
    suggestedAssigneeId:      assignee ? assignee.memberId : null,
    suggestedAssigneeName:    assignee ? assignee.name : null,
    assignmentScore:          assignee ? 100 : 0,
    assignmentReasons:        assignee ? ['Carried over from last sprint — same assignee'] : ['Previous assignee no longer assignable — pick manually'],
    alternativeAssigneeId:    null,
    alternativeAssigneeName:  null,
    allRankings:              [],
    requiresManualAssignment: !assignee,
    carriedOver:              true,
    originalJiraKey:          row.jira_key,
    originalTaskId:           row.id,
  };
}

// ─── Main breakdown function ──────────────────────────────────────────────────

async function breakdownSprintGoal(goalText, sprintName, startDate, endDate, organisationId, projectId, carryoverTaskIds) {
  const orgId      = organisationId || parseInt(process.env.ORGANISATION_ID || '1', 10);
  const workingDays = countWorkingDays(startDate, endDate);
  const client     = getAnthropicClient();

  // ── 1. Load team members with roles ────────────────────────────────────────
  const membersWithRoles = await memberRoleRepository.getAllMembersWithRoles(orgId);

  // Enrich with roleSlugs (not in repo output by default)
  const enrichedMembers = membersWithRoles.map((m) => ({
    ...m,
    roleSlugs: (m.roles || []).map((r) => r.slug),
  }));

  const assignableMembers = enrichedMembers.filter((m) =>
    m.roles.some((r) => r.can_be_assigned_tasks) || m.roles.length === 0
  );

  if (assignableMembers.length === 0) {
    throw new Error(
      'No team members with technical roles found. Please assign roles to team members in the Team section before planning a sprint.'
    );
  }

  // ── 2. Load current task counts per member ─────────────────────────────────
  let currentTaskCounts = {};
  try {
    currentTaskCounts = await taskRepo.getActiveTaskCountsPerMember(orgId);
  } catch (_) {}

  // ── 3. Load last 2 sprint performance per member ────────────────────────────
  const performanceData = {};
  await Promise.all(
    assignableMembers.map(async (m) => {
      try {
        performanceData[m.memberId] = await statsRepo.getCrossSprintTrend(m.memberId, orgId, 2);
      } catch (_) {
        performanceData[m.memberId] = [];
      }
    })
  );

  // ── 4. Load skill profiles ──────────────────────────────────────────────────
  let skillProfiles = new Map();
  try {
    skillProfiles = await skillExtraction.loadProfilesFromDB(orgId);
  } catch (_) {}

  // ── 5. Build role groups for prompt ────────────────────────────────────────
  const roleGroups = {
    backend:    assignableMembers.filter((m) => m.roleSlugs.includes('backend_developer')    || m.roleSlugs.includes('full_stack_developer')),
    frontend:   assignableMembers.filter((m) => m.roleSlugs.includes('frontend_developer')   || m.roleSlugs.includes('full_stack_developer')),
    ai:         assignableMembers.filter((m) => m.roleSlugs.includes('ai_engineer')),
    blockchain: assignableMembers.filter((m) => m.roleSlugs.includes('blockchain_developer')),
    design:     assignableMembers.filter((m) => m.roleSlugs.includes('ui_ux_designer')),
    fullstack:  assignableMembers.filter((m) => m.roleSlugs.includes('full_stack_developer')),
  };

  // Warn if no technical members at all
  const hasTechnical = assignableMembers.some((m) => m.roles.some((r) => r.role_type === 'technical'));
  if (!hasTechnical) {
    throw new Error(
      'No team members with technical roles found. Please assign roles to team members in the Team section before planning a sprint.'
    );
  }

  // Warn if all heavy-loaded
  const allHeavy = assignableMembers.every((m) => (currentTaskCounts[m.memberId] || 0) >= 4);
  const heavyWarning = allHeavy
    ? 'All team members have 4+ active tasks. Consider reducing sprint scope.'
    : null;

  const teamDescription = buildTeamDescription(assignableMembers, currentTaskCounts, performanceData);

  const systemPrompt = `You are an expert sprint planner for a software engineering team.
Break the sprint goal into specific, actionable Jira tasks.

CRITICAL RULES FOR TASK CREATION:
1. Every task must have a domain: backend, frontend, ai, blockchain, design, fullstack, or general
2. Detect the domain from the task title and description — be specific
3. The suggestedAssigneeName must come from the team list provided
4. ONLY suggest a backend engineer for backend tasks
5. ONLY suggest a frontend engineer for frontend tasks
6. When suggesting an assignee, consider their current workload — prefer members with fewer tasks
7. Full Stack Developers can take any backend or frontend task
8. Never suggest a managerial role (Team Lead, Process Manager) as an assignee
9. Task titles must start with a verb: Implement, Create, Build, Fix, Add, Write, Test, Design, Deploy
10. Descriptions must be 2-3 sentences describing what "done" looks like
11. Due dates must be spread across the sprint — do not pile everything at the end
12. Highest priority tasks get earlier due dates
13. Never create more than 15 tasks. Never fewer than 3.

Respond ONLY with valid JSON array. No preamble, no explanation, no markdown fences.

Schema for each task:
{
  "title": string,
  "description": string,
  "domain": "backend"|"frontend"|"ai"|"blockchain"|"design"|"fullstack"|"general",
  "priority": "Highest"|"High"|"Medium"|"Low",
  "estimatedDays": number (1-5),
  "suggestedDueDate": "YYYY-MM-DD",
  "skillTags": string[],
  "suggestedAssigneeName": string | null,
  "assignmentReason": string
}`;

  const userPrompt = `Sprint: ${sprintName}
Duration: ${startDate} to ${endDate} (${workingDays} working days)
Sprint goal: ${goalText}

Team available for this sprint (name [roles]: workload, performance):
${teamDescription}

Role availability summary:
  Backend engineers: ${roleGroups.backend.map((m) => m.name).join(', ') || 'None'}
  Frontend engineers: ${roleGroups.frontend.map((m) => m.name).join(', ') || 'None'}
  Full Stack: ${roleGroups.fullstack.map((m) => m.name).join(', ') || 'None'}
  AI Engineers: ${roleGroups.ai.map((m) => m.name).join(', ') || 'None'}
  Blockchain Devs: ${roleGroups.blockchain.map((m) => m.name).join(', ') || 'None'}
  UI/UX Designers: ${roleGroups.design.map((m) => m.name).join(', ') || 'None'}

Break this sprint goal into tasks now.
Remember: backend tasks → backend/fullstack only. Frontend tasks → frontend/fullstack only.`;

  // ── 6. Call Claude ──────────────────────────────────────────────────────────
  let rawText;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await client.messages.create({
        model:      MODEL,
        max_tokens: 4096,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });
      rawText = resp.content[0]?.text || '';
      break;
    } catch (err) {
      if (attempt === 2) throw new Error(`AI breakdown failed — please try again. (${err.message})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ── 7. Parse Claude response ────────────────────────────────────────────────
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let claudeTasks;
  try {
    claudeTasks = JSON.parse(cleaned);
  } catch {
    throw new Error('AI breakdown failed — please try again. (Invalid JSON response)');
  }
  if (!Array.isArray(claudeTasks)) throw new Error('AI returned unexpected format — please try again.');

  // ── 8. Validate fields and detect/override domain ───────────────────────────
  const parsedTasks = claudeTasks.map((task) => {
    const required = ['title', 'description', 'priority', 'estimatedDays', 'suggestedDueDate', 'skillTags'];
    for (const f of required) {
      if (task[f] === undefined) throw new Error(`AI task missing field "${f}" — please try again.`);
    }

    // Validate domain — Claude's domain takes priority, but override if invalid
    const claudeDomain  = sanitiseDomain(task.domain);
    const detectedDomain = detectDomain(task);
    const finalDomain   = claudeDomain || detectedDomain;

    if (!claudeDomain) {
      console.warn(`[sprintPlanning] Task "${task.title}" had invalid domain "${task.domain}" — overriding with detected: ${detectedDomain}`);
    }

    return {
      title:            task.title,
      description:      task.description,
      domain:           finalDomain,
      priority:         task.priority,
      estimatedDays:    task.estimatedDays,
      suggestedDueDate: task.suggestedDueDate,
      skillTags:        task.skillTags || [],
      assignmentReason: task.assignmentReason || '',
    };
  });

  // ── 9. Enrich with role-aware, workload-balanced assignment ─────────────────
  const enrichedTasks = await enrichTasksWithAssignments(
    parsedTasks,
    assignableMembers,
    currentTaskCounts,
    performanceData,
    skillProfiles,
  );

  // ── 10. Prepend approved carryover tasks from the previous sprint ───────────
  // These bypass Claude and the ranking logic — the previous assignee is kept
  // as-is (or flagged for manual assignment if they're no longer assignable).
  let carriedOverTasks = [];
  if (carryoverTaskIds && carryoverTaskIds.length > 0) {
    const membersById = new Map(assignableMembers.map((m) => [m.memberId, m]));
    const rows = await taskRepo.getByIds(orgId, carryoverTaskIds);
    carriedOverTasks = rows
      .filter((r) => r.completed_at === null)
      .map((r) => buildCarryoverTask(r, membersById, startDate));
  }

  const allTasks = [...carriedOverTasks, ...enrichedTasks];

  if (heavyWarning) {
    allTasks._warning = heavyWarning;
  }

  return allTasks;
}

// ─── Validate assignment plan before Jira creation ────────────────────────────

function validateAssignmentPlan(tasks, assignmentMap, members) {
  const errors   = [];
  const warnings = [];

  for (let i = 0; i < tasks.length; i++) {
    const task             = tasks[i];
    const assignedMemberId = assignmentMap[i] || assignmentMap[String(i)];

    if (!assignedMemberId) {
      errors.push(`Task "${task.title}" has no assignee`);
      continue;
    }

    const member = members.find((m) => m.memberId === assignedMemberId || m.id === assignedMemberId);
    if (!member) {
      errors.push(`Task "${task.title}": assigned member ID ${assignedMemberId} not found`);
      continue;
    }

    if (task.domain && task.domain !== 'general' && task.domain !== 'fullstack') {
      const pool = getEligiblePool(task.domain, members.map((m) => ({
        ...m,
        roleSlugs: (m.roles || []).map((r) => r.slug),
      })));
      const eligible = pool.some((m) => m.memberId === assignedMemberId || m.id === assignedMemberId);
      if (!eligible) {
        warnings.push(`Task "${task.title}" (${task.domain}): assigned to ${member.name} whose role doesn't match — proceeding as manual override.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── Sprint creation ──────────────────────────────────────────────────────────

async function createSprintFromPlan(sprintData, tasks, assignmentMap) {
  const cfg        = configService.getSprintConfig();
  const orgId      = parseInt(process.env.ORGANISATION_ID || '1', 10);
  const projectKey = cfg.projectKey;
  const channelId  = cfg.channelId;
  const { name, startDate, endDate, goalText } = sprintData;

  // Validate assignment plan before touching Jira
  let membersForValidation = [];
  try {
    membersForValidation = await memberRoleRepository.getAllMembersWithRoles(orgId);
  } catch (_) {}

  const { valid, errors, warnings } = validateAssignmentPlan(tasks, assignmentMap, membersForValidation);
  if (!valid) {
    throw Object.assign(
      new Error(`Sprint plan validation failed:\n${errors.join('\n')}`),
      { validationErrors: errors, validationWarnings: warnings }
    );
  }

  // ── Create sprint in Jira ──────────────────────────────────────────────────
  let boardId;
  try {
    boardId = await jiraService.getJiraBoardId(projectKey);
  } catch (err) {
    throw new Error(`Could not get Jira board ID: ${err.message}`);
  }

  const jiraSprint = await jiraService.createSprint(projectKey, name, startDate, endDate, boardId);

  try {
    await jiraService.startSprint(jiraSprint.id);
  } catch (err) {
    console.warn('[sprintPlanningService] startSprint warning:', err.message);
  }

  // ── Save sprint to local DB ────────────────────────────────────────────────
  const durationWeeks = Math.ceil(countWorkingDays(startDate, endDate) / 5);
  let dbSprint;
  try {
    dbSprint = await sprintRepo.upsertSprint(orgId, name, startDate, endDate, durationWeeks);
    if (dbSprint) await sprintRepo.setActive(dbSprint.id, orgId);
  } catch (err) {
    console.error('[sprintPlanningService] DB sprint save error:', err.message);
    dbSprint = { id: null };
  }

  // Keep app_config's sprint window (env-var backed, drives cron.js's Slack
  // sync scoping) in step with the sprint just created here — otherwise
  // huddle sync/EOD checks keep watching the previous sprint's dates while
  // performance scoring measures this new one.
  try {
    await configService.setMany({
      'sprint.name':           name,
      'sprint.start_date':     startDate,
      'sprint.duration_weeks': String(durationWeeks),
    });
  } catch (err) {
    console.error('[sprintPlanningService] app_config sprint sync error:', err.message);
  }

  // ── Resolve Jira account IDs ───────────────────────────────────────────────
  const uniqueMemberIds    = [...new Set(Object.values(assignmentMap).filter(Boolean))];
  const memberIdToJiraId   = {};
  const jiraIdWarnings     = [];

  await Promise.all(
    uniqueMemberIds.map(async (memberId) => {
      try {
        const member = await memberRepo.findById(memberId);
        if (member?.jira_account_id) {
          memberIdToJiraId[memberId] = member.jira_account_id;
        } else if (member?.email) {
          const jiraAccountId = await jiraService.getMemberJiraAccountId(member.email);
          memberIdToJiraId[memberId] = jiraAccountId;
        } else {
          const m = membersForValidation.find((x) => x.memberId === memberId || x.id === memberId);
          jiraIdWarnings.push(`${m?.name || memberId} has no Jira account ID — task created unassigned in Jira. Set Jira ID in Team section.`);
        }
      } catch (err) {
        console.warn(`[sprintPlanningService] Could not resolve Jira ID for member ${memberId}:`, err.message);
      }
    })
  );

  // ── Build issues payload ───────────────────────────────────────────────────
  const issuePayloads = tasks.map((task, idx) => {
    const assignedMemberId = assignmentMap[String(idx)] || assignmentMap[idx] || null;
    const jiraAccountId    = assignedMemberId ? memberIdToJiraId[assignedMemberId] || null : null;
    return {
      projectKey,
      summary:           task.title,
      description:       task.description,
      priority:          task.priority,
      assigneeAccountId: jiraAccountId,
      dueDate:           task.suggestedDueDate || null,
      sprintId:          jiraSprint.id,
      issueType:         'Task',
      _memberId:         assignedMemberId,
    };
  });

  const jiraResults = await jiraService.createIssuesBatch(issuePayloads);

  // ── Save tasks to local DB ─────────────────────────────────────────────────
  if (dbSprint?.id) {
    for (let i = 0; i < jiraResults.length; i++) {
      if (!jiraResults[i].success) continue;
      try {
        await taskRepo.upsertTask(
          orgId, dbSprint.id, jiraResults[i].key,
          tasks[i].title, 'To Do', tasks[i].priority,
          issuePayloads[i]._memberId || null,
          tasks[i].suggestedDueDate || null,
          new Date().toISOString(),
        );
      } catch (err) {
        console.error('[sprintPlanningService] DB task save error:', err.message);
      }
    }
  }

  // ── Post kickoff message ───────────────────────────────────────────────────
  let kickoffMessageSent = false;
  try {
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

  // ── Activity log ──────────────────────────────────────────────────────────
  const tasksCreated = jiraResults.filter((r) => r.success).length;
  const tasksFailed  = jiraResults.filter((r) => !r.success).length;
  activityLog.addEntry({
    type:    'sprint_created',
    action:  `Sprint ${name} created with ${tasksCreated} tasks`,
    success: true,
    details: `${tasksFailed} tasks failed to create`,
  });

  return {
    sprintId:           dbSprint?.id || null,
    jiraSprintId:       jiraSprint.id,
    tasksCreated,
    tasksFailed,
    createdIssues:      jiraResults,
    kickoffMessageSent,
    jiraSiteUrl:        process.env.JIRA_SITE_URL || '',
    validationWarnings: warnings,
    jiraIdWarnings,
  };
}

module.exports = {
  breakdownSprintGoal,
  createSprintFromPlan,
  getCarryoverCandidates,
  countWorkingDays,
  detectDomain,
  getEligiblePool,
};
