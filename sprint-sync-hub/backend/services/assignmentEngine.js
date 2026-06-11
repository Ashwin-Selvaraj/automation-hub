'use strict';

/**
 * assignmentEngine.js
 * Scores every team member for every task using historical performance data,
 * skill profiles, workload, and leave status.
 */

const skillExtraction      = require('./skillExtractionService');
const statsRepo            = require('../repositories/statsRepository');
const taskRepo             = require('../repositories/taskRepository');
const memberRepo           = require('../repositories/memberRepository');
const sprintRepo           = require('../repositories/sprintRepository');
const memberRoleRepository = require('../repositories/memberRoleRepository');

// Lazy-load zohoService to avoid crashes when Zoho is not configured
function tryZoho() {
  try { return require('./zohoService'); } catch { return null; }
}

/**
 * Score a single team member for a specific task.
 *
 * Scoring breakdown:
 *   BASE:               50
 *   SKILL MATCH:      + 0..30
 *   WORKLOAD:         -20..+5
 *   DELIVERY RATE:    -5..+15
 *   DEADLINE:        -10..+10
 *   LEAVE:             set to 0
 *   FINAL:            clamped 0–100
 *
 * @param {Object} member          - DB member record + currentTaskCount
 * @param {Object} task            - { title, description, skillTags, priority, ... }
 * @param {Map}    skillProfiles   - memberId → { topSkills, recentSkills }
 * @param {Array}  sprintSummaries - Last ≤3 sprint summaries from DB
 * @param {boolean} isOnLeave
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreMemberForTask(member, task, skillProfiles, sprintSummaries, isOnLeave) {
  if (isOnLeave) {
    return { score: 0, reasons: ['On leave during sprint'] };
  }

  const reasons = [];
  let score     = 50;

  // ── SKILL MATCH (+40 max — historical + role-based keywords) ────────────────
  const profile     = skillProfiles.get(member.id) || { topSkills: [], recentSkills: [] };
  const skillTags   = (task.skillTags || []).map((t) => t.toLowerCase());
  const recentLower = profile.recentSkills.map((s) => s.toLowerCase());
  const topLower    = profile.topSkills.map((s) => s.skill.toLowerCase());

  // Role keywords from all technical roles combined
  const roleKeywords = (member.allSkillKeywords || []).map((k) => k.toLowerCase());

  let skillScore  = 0;
  const matchedR  = [];
  const matchedT  = [];
  const matchedP  = [];
  const matchedRK = [];

  for (const tag of skillTags) {
    if (recentLower.includes(tag)) {
      skillScore += 10;
      matchedR.push(tag);
    } else if (topLower.includes(tag)) {
      skillScore += 7;
      matchedT.push(tag);
    } else if (topLower.some((s) => s.includes(tag) || tag.includes(s))) {
      skillScore += 4;
      matchedP.push(tag);
    } else if (roleKeywords.some((k) => k === tag || k.includes(tag) || tag.includes(k))) {
      skillScore += 12;
      matchedRK.push(tag);
    }
  }

  skillScore = Math.min(40, skillScore);
  score     += skillScore;

  if (matchedR.length > 0) {
    const sprintWord = matchedR.length === 1 ? 'sprint' : 'sprints';
    reasons.push(`✓ ${matchedR.join(', ')} used in last 2 ${sprintWord}`);
  }
  if (matchedT.length > 0) {
    reasons.push(`✓ ${matchedT.join(', ')} in historical work`);
  }
  if (matchedP.length > 0) {
    reasons.push(`✓ Related skills: ${matchedP.join(', ')}`);
  }
  if (matchedRK.length > 0) {
    reasons.push(`✓ Role skill match: ${matchedRK.join(', ')}`);
  }
  if (skillTags.length > 0 && skillScore === 0) {
    reasons.push('No historical skill match');
  }

  // ── ROLE TYPE ALIGNMENT (+15 bonus / hard exclude) ────────────────────────
  const FRONTEND_TAGS   = ['react','vue','angular','css','html','ui','frontend','component','next.js','tailwind','typescript','javascript','webpack'];
  const BACKEND_TAGS    = ['node.js','python','api','rest','database','backend','server','postgresql','mongodb','express','django','graphql','sql'];
  const AI_TAGS         = ['ai','ml','model','llm','training','machine learning','neural network','nlp','tensorflow','pytorch','rag','embedding'];
  const BLOCKCHAIN_TAGS = ['blockchain','smart contract','web3','solidity','ethereum','crypto','nft','defi','erc20','decentralised'];
  const DESIGN_TAGS     = ['figma','wireframe','ux','design','mockup','prototype','user research','design system','typography','accessibility'];

  const tagsLower = skillTags;
  const memberSlugs = (member.roleSlugs || []);

  let taskDomain = null;
  if (tagsLower.some((t) => FRONTEND_TAGS.includes(t)))   taskDomain = 'frontend';
  else if (tagsLower.some((t) => BACKEND_TAGS.includes(t)))    taskDomain = 'backend';
  else if (tagsLower.some((t) => AI_TAGS.includes(t)))         taskDomain = 'ai';
  else if (tagsLower.some((t) => BLOCKCHAIN_TAGS.includes(t))) taskDomain = 'blockchain';
  else if (tagsLower.some((t) => DESIGN_TAGS.includes(t)))     taskDomain = 'design';

  if (taskDomain) {
    const isFullStack = memberSlugs.includes('full_stack_developer');

    const domainAligned =
      (taskDomain === 'frontend'   && (memberSlugs.includes('frontend_developer')    || isFullStack)) ||
      (taskDomain === 'backend'    && (memberSlugs.includes('backend_developer')     || isFullStack)) ||
      (taskDomain === 'ai'         && memberSlugs.includes('ai_engineer'))    ||
      (taskDomain === 'blockchain' && memberSlugs.includes('blockchain_developer')) ||
      (taskDomain === 'design'     && memberSlugs.includes('ui_ux_designer'));

    if (domainAligned) {
      score += 15;
      reasons.push(`✓ Role aligned: ${taskDomain} task → ${member.name}'s primary role`);
    } else if (!isFullStack && roleKeywords.length > 0) {
      // Hard exclude: member has roles but none match the domain
      const hasAnyDomainKeyword = tagsLower.some((t) => roleKeywords.includes(t));
      if (!hasAnyDomainKeyword) {
        return { score: 0, reasons: [`✗ Role mismatch: ${taskDomain} task not in member's skill set`] };
      }
    }
  }

  // ── WORKLOAD (-20..+5) ────────────────────────────────────────────────────
  const ct = member.currentTaskCount || 0;
  let workloadDelta;
  if (ct === 0)        { workloadDelta = +5;  reasons.push('✓ No current tasks — full capacity'); }
  else if (ct <= 2)    { workloadDelta =  0;  reasons.push(`✓ Currently has ${ct} task${ct > 1 ? 's' : ''}`); }
  else if (ct <= 4)    { workloadDelta = -10; reasons.push(`⚠ Currently has ${ct} tasks — near capacity`); }
  else                 { workloadDelta = -20; reasons.push(`⚠ Currently has ${ct} tasks — overloaded`); }
  score += workloadDelta;

  // ── PAST DELIVERY RATE (+15 max / -5) ─────────────────────────────────────
  if (sprintSummaries.length === 0) {
    reasons.push('No historical sprint data yet');
  } else {
    const avgCompletion = average(sprintSummaries.map((s) => parseFloat(s.completion_rate || 0)));
    let deliveryDelta;
    if      (avgCompletion >= 90) { deliveryDelta = +15; reasons.push(`✓ ${avgCompletion.toFixed(0)}% task completion rate over last ${sprintSummaries.length} sprint${sprintSummaries.length > 1 ? 's' : ''}`); }
    else if (avgCompletion >= 75) { deliveryDelta = +10; reasons.push(`✓ ${avgCompletion.toFixed(0)}% completion rate`); }
    else if (avgCompletion >= 60) { deliveryDelta =  +5; reasons.push(`${avgCompletion.toFixed(0)}% completion rate`); }
    else                          { deliveryDelta =  -5; reasons.push(`⚠ ${avgCompletion.toFixed(0)}% completion rate — below average`); }
    score += deliveryDelta;
  }

  // ── DEADLINE RELIABILITY (+10 max / -10) ──────────────────────────────────
  if (sprintSummaries.length > 0) {
    const avgDeadline = average(sprintSummaries.map((s) => parseFloat(s.deadline_hit_rate || 0)));
    let deadlineDelta;
    if      (avgDeadline >= 90) { deadlineDelta = +10; reasons.push(`✓ ${avgDeadline.toFixed(0)}% deadline hit rate`); }
    else if (avgDeadline >= 75) { deadlineDelta =  +7; reasons.push(`✓ ${avgDeadline.toFixed(0)}% deadline hit rate`); }
    else if (avgDeadline >= 60) { deadlineDelta =  +3; reasons.push(`${avgDeadline.toFixed(0)}% deadline hit rate`); }
    else {
      // Count missed deadlines in last sprint
      const last = sprintSummaries[0];
      const total     = parseInt(last.total_tasks || 0, 10);
      const completed = parseInt(last.tasks_completed || 0, 10);
      const missed    = Math.max(0, total - completed);
      deadlineDelta   = -10;
      reasons.push(`⚠ ${missed} missed deadline${missed !== 1 ? 's' : ''} last sprint`);
    }
    score += deadlineDelta;
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Rank all team members for a single task.
 * @param {Object} task
 * @param {Array}  members          - [{ id, name, currentTaskCount, ... }]
 * @param {Map}    skillProfiles
 * @param {Map}    allSprintSummaries - memberId → last 3 summaries
 * @param {Set}    onLeaveIds        - Set of member IDs on leave
 * @returns {Array}  Sorted by score descending, top member flagged recommended:true
 */
function rankMembersForTask(task, members, skillProfiles, allSprintSummaries, onLeaveIds) {
  const ranked = members.map((member) => {
    const summaries = allSprintSummaries.get(member.id) || [];
    const onLeave   = onLeaveIds.has(member.id);
    const { score, reasons } = scoreMemberForTask(member, task, skillProfiles, summaries, onLeave);
    return { memberId: member.id, name: member.name, score, reasons, recommended: false };
  });

  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length > 0) ranked[0].recommended = true;
  return ranked;
}

/**
 * Generate a complete assignment plan for all tasks, applying workload balancing.
 * @param {Array}  tasks
 * @param {Array}  members
 * @param {number} organisationId
 * @param {Object} sprintData       - { startDate, endDate } for leave lookup
 * @returns {Promise<Array>}
 */
async function generateAssignmentPlan(tasks, members, organisationId, sprintData) {
  const orgId = organisationId || parseInt(process.env.ORGANISATION_ID || '1', 10);

  // ── 1. Load skill profiles (from cache or DB) ─────────────────────────────
  let skillProfiles;
  try {
    skillProfiles = await skillExtraction.loadProfilesFromDB(orgId);
  } catch {
    skillProfiles = new Map();
  }

  // ── 2. Fetch last 3 sprint summaries per member ───────────────────────────
  const activeSprint       = await sprintRepo.getActiveSprint(orgId);
  const allSprintSummaries = new Map();

  await Promise.all(
    members.map(async (member) => {
      try {
        const summaries = await statsRepo.getCrossSprintTrend(member.id, orgId, 3);
        allSprintSummaries.set(member.id, summaries || []);
      } catch {
        allSprintSummaries.set(member.id, []);
      }
    })
  );

  // ── 3. Fetch leave data for the sprint window ─────────────────────────────
  const onLeaveIds = new Set();
  const zoho       = tryZoho();

  if (zoho && zoho.isConfigured() && sprintData?.startDate) {
    await Promise.all(
      members.map(async (member) => {
        if (!member.email) return;
        try {
          const leave = await zoho.isOnLeave(member.email, sprintData.startDate);
          if (leave?.onLeave) onLeaveIds.add(member.id);
        } catch { /* non-fatal */ }
      })
    );
  }

  // ── 3b. Enrich members with role data and filter eligible ones ──────────────
  let membersWithRoles = [];
  try {
    membersWithRoles = await memberRoleRepository.getAllMembersWithRoles(orgId);
  } catch (err) {
    console.warn('[assignmentEngine] Could not load role data:', err.message);
  }

  const roleDataByMemberId = new Map(membersWithRoles.map((m) => [m.memberId, m]));

  // Filter: only members who have at least one role that allows task assignment,
  // or who have no roles assigned at all (default: assignable)
  const eligibleMembers = members.filter((m) => {
    const roleData = roleDataByMemberId.get(m.id);
    if (!roleData || !roleData.roles || roleData.roles.length === 0) return true; // no roles = eligible
    return roleData.roles.some((r) => r.can_be_assigned_tasks);
  });

  // Attach role metadata to each member for scoring
  const enrichedMemberBase = eligibleMembers.map((m) => {
    const roleData = roleDataByMemberId.get(m.id) || {};
    return {
      ...m,
      allSkillKeywords: roleData.allSkillKeywords || [],
      roleSlugs:        (roleData.roles || []).map((r) => r.slug),
    };
  });

  // ── 4. Build plan for each task ──────────────────────────────────────────
  // Track how many tasks we've assigned to each member within this plan
  const planTaskCounts = new Map(enrichedMemberBase.map((m) => [m.id, 0]));

  const plan = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    // Build enriched members with plan task counts
    const enrichedMembers = enrichedMemberBase.map((m) => ({
      ...m,
      currentTaskCount: (m.currentTaskCount || 0) + (planTaskCounts.get(m.id) || 0),
    }));

    const rankings = rankMembersForTask(task, enrichedMembers, skillProfiles, allSprintSummaries, onLeaveIds);

    if (rankings.length === 0) {
      plan.push({
        taskIndex:               i,
        taskTitle:               task.title,
        recommendedMemberId:     null,
        recommendedMemberName:   null,
        score:                   0,
        reasons:                 ['No team members available'],
        alternativeMemberId:     null,
        alternativeMemberName:   null,
        allRankings:             [],
      });
      continue;
    }

    let topIdx = 0; // index into rankings for chosen recommendation

    // ── 5. Workload balancing override ───────────────────────────────────────
    const top     = rankings[0];
    const second  = rankings[1];

    if (second) {
      const topPlanCount = planTaskCounts.get(top.memberId) || 0;
      const scoreLead    = top.score - second.score;
      if (topPlanCount >= 3 && scoreLead < 15) {
        console.log(
          `[assignmentEngine] Workload balance: reassigning "${task.title}" from ${top.name} (${topPlanCount} plan tasks) to ${second.name}`
        );
        topIdx = 1;
        rankings[1].recommended = true;
        rankings[0].recommended = false;
      }
    }

    const chosen    = rankings[topIdx];
    const alternate = rankings[topIdx === 0 ? 1 : 0];

    planTaskCounts.set(chosen.memberId, (planTaskCounts.get(chosen.memberId) || 0) + 1);

    plan.push({
      taskIndex:               i,
      taskTitle:               task.title,
      recommendedMemberId:     chosen.memberId,
      recommendedMemberName:   chosen.name,
      score:                   chosen.score,
      reasons:                 chosen.reasons,
      alternativeMemberId:     alternate?.memberId     || null,
      alternativeMemberName:   alternate?.name         || null,
      allRankings:             rankings.map((r) => ({
        memberId: r.memberId,
        name:     r.name,
        score:    r.score,
        reasons:  r.reasons,
      })),
    });
  }

  return plan;
}

module.exports = {
  scoreMemberForTask,
  rankMembersForTask,
  generateAssignmentPlan,
};


