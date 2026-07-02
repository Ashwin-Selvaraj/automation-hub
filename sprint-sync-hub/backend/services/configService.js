'use strict';

const db           = require('../db');
const { encrypt, decrypt, mask } = require('./cryptoService');

// ─── Config key definitions ───────────────────────────────────────────────────
// Maps logical key → { category, label, isSecret, envVar, default }
const CONFIG_DEFS = {
  // Slack
  'slack.bot_token':      { category: 'slack',    label: 'Slack Bot Token',         isSecret: true,  envVar: 'SLACK_BOT_TOKEN' },
  'slack.channel_id':     { category: 'slack',    label: 'Slack Channel ID',        isSecret: false, envVar: 'SLACK_CHANNEL_ID' },
  'slack.signing_secret': { category: 'slack',    label: 'Slack Signing Secret',    isSecret: true,  envVar: 'SLACK_SIGNING_SECRET' },

  // Jira
  'jira.email':           { category: 'jira',     label: 'Jira Email',              isSecret: false, envVar: 'JIRA_EMAIL' },
  'jira.api_token':       { category: 'jira',     label: 'Jira API Token',          isSecret: true,  envVar: 'JIRA_API_TOKEN' },
  'jira.site_url':        { category: 'jira',     label: 'Jira Site URL',           isSecret: false, envVar: 'JIRA_SITE_URL' },
  'jira.cloud_id':        { category: 'jira',     label: 'Jira Cloud ID',           isSecret: false, envVar: 'JIRA_CLOUD_ID' },
  'jira.project_key':     { category: 'jira',     label: 'Jira Project Key',        isSecret: false, envVar: 'JIRA_PROJECT_KEY' },

  // Claude / Anthropic
  'claude.api_key':       { category: 'claude',   label: 'Anthropic API Key',       isSecret: true,  envVar: 'ANTHROPIC_API_KEY' },

  // Sprint
  'sprint.name':          { category: 'sprint',   label: 'Sprint Name',             isSecret: false, envVar: 'SPRINT_NAME',            default: 'Sprint 1' },
  'sprint.start_date':    { category: 'sprint',   label: 'Sprint Start Date',       isSecret: false, envVar: 'SPRINT_START_DATE',      default: new Date().toISOString().split('T')[0] },
  'sprint.duration_weeks':{ category: 'sprint',   label: 'Sprint Duration (weeks)', isSecret: false, envVar: 'SPRINT_DURATION_WEEKS',  default: '2' },

  // Schedule
  'schedule.timezone':         { category: 'schedule', label: 'Timezone',                isSecret: false, envVar: 'TIMEZONE',          default: 'Asia/Kolkata' },
  'schedule.sync_time':        { category: 'schedule', label: 'Daily Sync Time (HH:MM)', isSecret: false, envVar: 'SYNC_TIME',         default: '10:00' },
  'schedule.eod_time':         { category: 'schedule', label: 'EOD Reminder Time (HH:MM)', isSecret: false, envVar: 'EOD_CHECK_TIME',  default: '18:30' },
  'schedule.report_day':       { category: 'schedule', label: 'Weekly Report Day',       isSecret: false, envVar: 'REPORT_DAY',        default: 'Friday' },
  'schedule.report_time':      { category: 'schedule', label: 'Weekly Report Time',      isSecret: false, envVar: 'REPORT_TIME',       default: '17:00' },
  'schedule.manager_slack_id': { category: 'schedule', label: 'Manager Slack ID',        isSecret: false, envVar: 'MANAGER_SLACK_ID',  default: '' },

  // Organisation
  'org.id':   { category: 'org', label: 'Organisation ID',   isSecret: false, envVar: 'ORGANISATION_ID',   default: '1' },
  'org.name': { category: 'org', label: 'Organisation Name', isSecret: false, envVar: 'ORGANISATION_NAME', default: 'My Organisation' },

  // Zoho People
  'zoho.client_id':     { category: 'zoho', label: 'Zoho Client ID',     isSecret: false, envVar: 'ZOHO_CLIENT_ID' },
  'zoho.client_secret': { category: 'zoho', label: 'Zoho Client Secret', isSecret: true,  envVar: 'ZOHO_CLIENT_SECRET' },
  'zoho.refresh_token': { category: 'zoho', label: 'Zoho Refresh Token', isSecret: true,  envVar: 'ZOHO_REFRESH_TOKEN' },
  'zoho.org_id':        { category: 'zoho', label: 'Zoho Org ID',        isSecret: false, envVar: 'ZOHO_ORG_ID' },
  'zoho.domain':        { category: 'zoho', label: 'Zoho Domain',        isSecret: false, envVar: 'ZOHO_DOMAIN',    default: 'zoho.in' },
  'zoho.work_start':    { category: 'zoho', label: 'Work Start Time',    isSecret: false, envVar: 'WORK_START_TIME', default: '09:00' },
  'zoho.work_end':      { category: 'zoho', label: 'Work End Time',      isSecret: false, envVar: 'WORK_END_TIME',   default: '18:00' },
};

// In-memory cache — loaded once from DB, invalidated on write
let cache = null;

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function loadFromDB() {
  const { rows } = await db.query('SELECT key, value, is_encrypted FROM app_config');
  const result = {};
  for (const row of rows) {
    result[row.key] = row.is_encrypted ? decrypt(row.value) : row.value;
  }
  return result;
}

async function ensureLoaded() {
  if (!cache) cache = await loadFromDB();
}

function envValue(key) {
  const def = CONFIG_DEFS[key];
  if (!def) return undefined;
  const v = process.env[def.envVar];
  return (v !== undefined && v !== '') ? v : def.default;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a single config value (decrypted).
 * Falls back to env/default if not in DB cache.
 */
async function get(key) {
  await ensureLoaded();
  if (cache[key] !== undefined) return cache[key];
  return envValue(key) ?? null;
}

/**
 * Get a single config value synchronously from cache only.
 * Use this after init() has been called during boot.
 */
function getSync(key) {
  if (cache && cache[key] !== undefined) return cache[key];
  return envValue(key) ?? null;
}

/**
 * Set a config value. Encrypts secrets automatically.
 * @param {string} key
 * @param {string|null} value
 * @param {{ source?: string }} opts
 */
async function set(key, value, { source = 'api' } = {}) {
  await ensureLoaded();
  const def = CONFIG_DEFS[key] || { category: 'general', label: key, isSecret: false };
  const isSecret = def.isSecret;
  const storedValue = (isSecret && value) ? encrypt(value) : value;
  const oldRaw = cache[key];

  await db.query(
    `INSERT INTO app_config (key, value, is_encrypted, category, label, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value        = EXCLUDED.value,
       is_encrypted = EXCLUDED.is_encrypted,
       category     = EXCLUDED.category,
       label        = EXCLUDED.label,
       updated_at   = NOW()`,
    [key, storedValue, isSecret, def.category, def.label || key]
  );

  // Audit log (never store secret values in plain text)
  try {
    await db.query(
      `INSERT INTO config_audit (key, old_value, new_value, source)
       VALUES ($1, $2, $3, $4)`,
      [key, isSecret ? null : oldRaw, isSecret ? null : value, source]
    );
  } catch (_) { /* audit is non-fatal */ }

  cache[key] = value;

  // Also propagate to process.env so existing services (slackService, etc.) pick it up
  if (def.envVar && value != null) process.env[def.envVar] = value;
}

/**
 * Set multiple keys at once.
 */
async function setMany(updates, opts = {}) {
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) await set(key, value, opts);
  }
}

/**
 * Returns the full structured config object (equivalent of old getSprintConfig).
 * This is what the rest of the app uses.
 */
function getSprintConfig() {
  // Synchronous — safe to call after init()
  const teamMembers = (() => {
    const raw = process.env.TEAM_MEMBERS || '';
    if (!raw.trim()) return [];
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  })();

  return {
    sprintName:     getSync('sprint.name')          || 'Sprint 1',
    startDate:      getSync('sprint.start_date')     || new Date().toISOString().split('T')[0],
    durationWeeks:  parseInt(getSync('sprint.duration_weeks') || '2', 10),
    projectKey:     getSync('jira.project_key')      || '',
    channelId:      getSync('slack.channel_id')      || '',
    timezone:       getSync('schedule.timezone')     || 'Asia/Kolkata',
    syncTime:       getSync('schedule.sync_time')    || '10:00',
    eodCheckTime:   getSync('schedule.eod_time')     || '18:30',
    reportDay:      getSync('schedule.report_day')   || 'Friday',
    reportTime:     getSync('schedule.report_time')  || '17:00',
    managerSlackId: getSync('schedule.manager_slack_id') || '',
    teamMembers,
    // credentials (for services that read directly from process.env — they're already propagated)
    botToken:       getSync('slack.bot_token')       || process.env.SLACK_BOT_TOKEN || '',
    jiraEmail:      getSync('jira.email')            || process.env.JIRA_EMAIL || '',
    jiraApiToken:   getSync('jira.api_token')        || process.env.JIRA_API_TOKEN || '',
    jiraSiteUrl:    getSync('jira.site_url')         || process.env.JIRA_SITE_URL || '',
    anthropicKey:   getSync('claude.api_key')        || process.env.ANTHROPIC_API_KEY || '',
  };
}

/**
 * Seeds all CONFIG_DEFS from env/defaults into DB if the table is empty.
 * Called once during boot.
 */
async function seedFromEnv() {
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM app_config');
  if (parseInt(rows[0].cnt, 10) > 0) {
    // DB already seeded — just load into cache and propagate to process.env
    cache = await loadFromDB();
    _propagateToEnv();
    console.log('[configService] Loaded config from DB');
    return false; // was not seeded
  }

  console.log('[configService] First boot — seeding config from env/defaults into DB...');
  for (const key of Object.keys(CONFIG_DEFS)) {
    const value = envValue(key);
    if (value != null) {
      await set(key, String(value), { source: 'seed' });
    }
  }
  _propagateToEnv();
  console.log('[configService] Config seeded into DB');
  return true; // was seeded
}

/** Forces all cached values back into process.env for downstream services. */
function _propagateToEnv() {
  for (const [key, def] of Object.entries(CONFIG_DEFS)) {
    if (!def.envVar) continue;
    const v = cache?.[key];
    if (v != null && v !== '') process.env[def.envVar] = v;
  }
}

/** Invalidate cache (useful after external DB changes). */
function invalidate() { cache = null; }

/** For boot sequence — ensures cache is loaded before first request. */
async function init() {
  cache = await loadFromDB();
  _propagateToEnv();
}

module.exports = {
  CONFIG_DEFS,
  get,
  getSync,
  set,
  setMany,
  getSprintConfig,
  seedFromEnv,
  init,
  invalidate,
};
