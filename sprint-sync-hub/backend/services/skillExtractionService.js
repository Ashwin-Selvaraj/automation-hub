'use strict';

/**
 * skillExtractionService.js
 * Reads historical standup posts and builds per-member technical skill profiles.
 * Skill signals are extracted from message text using Claude.
 */

const Anthropic    = require('@anthropic-ai/sdk');
const db           = require('../db');
const memberRepo   = require('../repositories/memberRepository');
const standupRepo  = require('../repositories/standupRepository');
const sprintRepo   = require('../repositories/sprintRepository');

const MODEL = 'claude-haiku-4-5'; // lighter model for bulk extraction

let _anthropic = null;
function getClient() {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

// ─── In-memory profile cache ────────────────────────────────────────────────
// Map<memberId, { profile, builtAt }>
const _profileCache = new Map();
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

function isCacheFresh(entry) {
  return entry && (Date.now() - entry.builtAt) < CACHE_TTL_MS;
}

// ─── Concurrency limiter ─────────────────────────────────────────────────────
async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx  = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Use Claude to extract technical skill keywords from a standup message.
 * @param {string} messageText
 * @returns {Promise<string[]>}
 */
async function extractSkillsFromMessage(messageText) {
  if (!messageText || messageText.trim().length < 10) return [];

  try {
    const client = getClient();
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 100,
      system: `Extract technical skill keywords from this developer standup message.
Return ONLY a JSON array of strings. Maximum 5 tags. No explanation.
Tags must be: programming languages, frameworks, tools, or technical concepts.
Not: project names, task IDs, or generic words like "worked", "fixed", "done".
Examples of valid tags: ["Node.js", "PostgreSQL", "REST API", "React", "Redis"]`,
      messages: [{ role: 'user', content: `Message: ${messageText}` }],
    });

    const raw = resp.content[0]?.text || '[]';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => typeof t === 'string' && t.length > 0).slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Build a complete skill profile for a member from all their standup history.
 * @param {number} organisationId
 * @param {number} memberId
 * @returns {Promise<Object>}
 */
async function buildMemberSkillProfile(organisationId, memberId) {
  // Fetch all standup posts for this member across all sprints
  const { rows: posts } = await db.query(
    `SELECT sp.message_text, sp.post_date, sp.sprint_id
     FROM standup_posts sp
     WHERE sp.organisation_id = $1 AND sp.member_id = $2
       AND sp.message_text IS NOT NULL
     ORDER BY sp.post_date DESC`,
    [organisationId, memberId]
  );

  if (posts.length === 0) {
    return {
      memberId,
      topSkills:              [],
      recentSkills:           [],
      totalMessagesAnalysed:  0,
    };
  }

  // Determine last-2-sprints boundary
  const allSprintIds = [...new Set(posts.map((p) => p.sprint_id))];
  const recentSprintIds = new Set(allSprintIds.slice(0, 2));

  // Extract skills with concurrency=5
  const skillResults = await runWithConcurrency(posts, 5, async (post) => ({
    skills:   await extractSkillsFromMessage(post.message_text),
    date:     post.post_date,
    sprintId: post.sprint_id,
  }));

  // Aggregate: skill → { frequency, lastSeen, inRecentSprint }
  const skillMap = new Map();

  for (const result of skillResults) {
    for (const skill of result.skills) {
      const key = skill.toLowerCase();
      if (!skillMap.has(key)) {
        skillMap.set(key, { skill, frequency: 0, lastSeen: result.date, inRecentSprint: false });
      }
      const entry = skillMap.get(key);
      entry.frequency++;
      if (result.date > entry.lastSeen) entry.lastSeen = result.date;
      if (recentSprintIds.has(result.sprintId)) entry.inRecentSprint = true;
    }
  }

  // Sort by frequency descending, take top 10
  const sorted = [...skillMap.values()].sort((a, b) => b.frequency - a.frequency).slice(0, 10);

  const topSkills = sorted.map((e) => ({
    skill:     e.skill,
    frequency: e.frequency,
    lastSeen:  typeof e.lastSeen === 'object' ? e.lastSeen.toISOString().split('T')[0] : String(e.lastSeen).split('T')[0],
  }));

  const recentSkills = sorted.filter((e) => e.inRecentSprint).map((e) => e.skill);

  return {
    memberId,
    topSkills,
    recentSkills,
    totalMessagesAnalysed: posts.length,
  };
}

/**
 * Build skill profiles for all active members. Uses in-memory cache (24h TTL).
 * @param {number} organisationId
 * @returns {Promise<Map<number, Object>>}  memberId → profile
 */
async function buildAllMemberSkillProfiles(organisationId) {
  const members = await memberRepo.findAll(organisationId);
  const result  = new Map();

  // Sequential — respect Claude API rate limits
  for (const member of members) {
    const cached = _profileCache.get(member.id);
    if (isCacheFresh(cached)) {
      result.set(member.id, cached.profile);
      continue;
    }

    console.log(`[skillExtraction] Building profile for ${member.name}…`);
    const profile = await buildMemberSkillProfile(organisationId, member.id);

    // Save to DB
    await saveSkillProfile(organisationId, member.id, profile);

    // Cache
    _profileCache.set(member.id, { profile, builtAt: Date.now() });
    result.set(member.id, profile);
  }

  return result;
}

/**
 * Save a computed skill profile to the DB.
 * Uses upsert to increment frequency on subsequent rebuilds.
 * @param {number} organisationId
 * @param {number} memberId
 * @param {Object} profile
 */
async function saveSkillProfile(organisationId, memberId, profile) {
  if (!profile.topSkills || profile.topSkills.length === 0) return;

  for (const entry of profile.topSkills) {
    try {
      await db.query(
        `INSERT INTO member_skill_profiles
           (organisation_id, member_id, skill, frequency, last_seen_date, sprint_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, 1, NOW())
         ON CONFLICT (organisation_id, member_id, skill) DO UPDATE
           SET frequency      = member_skill_profiles.frequency + 1,
               last_seen_date = GREATEST(member_skill_profiles.last_seen_date, EXCLUDED.last_seen_date),
               updated_at     = NOW()`,
        [organisationId, memberId, entry.skill, entry.frequency, entry.lastSeen || null]
      );
    } catch (err) {
      console.warn(`[skillExtraction] saveSkillProfile failed for ${entry.skill}:`, err.message);
    }
  }
}

/**
 * Load skill profiles from DB for all members (fast path — no Claude calls).
 * @param {number} organisationId
 * @returns {Promise<Map<number, Object>>}
 */
async function loadProfilesFromDB(organisationId) {
  const { rows } = await db.query(
    `SELECT member_id, skill, frequency, last_seen_date
     FROM member_skill_profiles
     WHERE organisation_id = $1
     ORDER BY member_id, frequency DESC`,
    [organisationId]
  );

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.member_id)) {
      map.set(row.member_id, { memberId: row.member_id, topSkills: [], recentSkills: [], totalMessagesAnalysed: 0 });
    }
    const profile = map.get(row.member_id);
    profile.topSkills.push({
      skill:     row.skill,
      frequency: row.frequency,
      lastSeen:  row.last_seen_date,
    });
  }

  // Compute recentSkills: skills seen in last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  for (const profile of map.values()) {
    profile.recentSkills = profile.topSkills
      .filter((s) => s.lastSeen && new Date(s.lastSeen) >= thirtyDaysAgo)
      .map((s) => s.skill);
  }

  return map;
}

/**
 * Get cached profile for a single member (loads from DB if cache miss).
 * @param {number} organisationId
 * @param {number} memberId
 * @returns {Promise<Object>}
 */
async function getMemberProfile(organisationId, memberId) {
  const cached = _profileCache.get(memberId);
  if (isCacheFresh(cached)) return cached.profile;

  // Try DB first
  const { rows } = await db.query(
    `SELECT skill, frequency, last_seen_date
     FROM member_skill_profiles
     WHERE organisation_id = $1 AND member_id = $2
     ORDER BY frequency DESC LIMIT 10`,
    [organisationId, memberId]
  );

  if (rows.length > 0) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const topSkills    = rows.map((r) => ({ skill: r.skill, frequency: r.frequency, lastSeen: r.last_seen_date }));
    const recentSkills = topSkills.filter((s) => s.lastSeen && new Date(s.lastSeen) >= thirtyDaysAgo).map((s) => s.skill);
    const profile      = { memberId, topSkills, recentSkills, totalMessagesAnalysed: 0 };
    _profileCache.set(memberId, { profile, builtAt: Date.now() });
    return profile;
  }

  // No DB data — return empty profile
  return { memberId, topSkills: [], recentSkills: [], totalMessagesAnalysed: 0 };
}

/** Invalidate cache for one member (or all if no memberId). */
function invalidateCache(memberId) {
  if (memberId) {
    _profileCache.delete(memberId);
  } else {
    _profileCache.clear();
  }
}

module.exports = {
  extractSkillsFromMessage,
  buildMemberSkillProfile,
  buildAllMemberSkillProfiles,
  saveSkillProfile,
  loadProfilesFromDB,
  getMemberProfile,
  invalidateCache,
};
