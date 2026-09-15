'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const db   = require('../db');
const configService = require('../services/configService');
const { getOrgId }  = require('../core/orgContext');

/**
 * The automation catalogue.
 *
 * Automations used to be five anonymous callbacks inlined in a 349-line
 * startCronJobs(), with their schedules read once at boot despite a comment
 * claiming otherwise, and two of the five cron expressions hardcoded past the
 * reach of config. Adding a sixth meant editing that function; a nineteenth
 * was not viable.
 *
 * Each automation is now a module that describes itself. This file discovers
 * them, resolves their schedule and enabled state, schedules the enabled ones,
 * and exposes the catalogue so the dashboard can render and control it.
 *
 * An automation module exports:
 *   key              stable id, used for settings and dedupe keys
 *   name             human label
 *   description      one line, shown in the dashboard
 *   category         delivery | people | code | reporting
 *   audience         lead | member | channel | reviewer | system
 *   defaultEnabled   boolean
 *   schedule(cfg)    returns a cron expression, given the resolved config
 *   run(ctx)         does the work; ctx = { orgId, cfg, trigger }
 */

const CATEGORIES = ['delivery', 'people', 'code', 'reporting', 'system'];
const AUDIENCES   = ['lead', 'member', 'channel', 'reviewer', 'system'];

const automations = new Map();   // key -> module
const tasks       = new Map();   // key -> scheduled cron task

// ─── Discovery ────────────────────────────────────────────────────────────────

function validate(mod, file) {
  const required = ['key', 'name', 'description', 'category', 'audience', 'schedule', 'run'];
  for (const field of required) {
    if (mod[field] == null) throw new Error(`${file}: automation is missing "${field}"`);
  }
  if (typeof mod.run !== 'function')      throw new Error(`${file}: run must be a function`);
  if (typeof mod.schedule !== 'function') throw new Error(`${file}: schedule must be a function`);
  if (!CATEGORIES.includes(mod.category)) throw new Error(`${file}: unknown category "${mod.category}"`);
  if (!AUDIENCES.includes(mod.audience))  throw new Error(`${file}: unknown audience "${mod.audience}"`);
}

function load() {
  automations.clear();
  const root = path.join(__dirname);

  for (const category of fs.readdirSync(root, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const dir = path.join(root, category.name);

    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.js')) continue;
      const file = path.join(dir, entry);
      const mod  = require(file);
      validate(mod, `${category.name}/${entry}`);
      if (automations.has(mod.key)) {
        throw new Error(`Duplicate automation key "${mod.key}" in ${category.name}/${entry}`);
      }
      automations.set(mod.key, mod);
    }
  }
  return automations.size;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings(orgId) {
  const { rows } = await db.query(
    'SELECT automation_key, enabled, schedule_override FROM automation_settings WHERE organisation_id = $1',
    [orgId]
  );
  return new Map(rows.map((r) => [r.automation_key, r]));
}

/**
 * Resolves what an automation will actually do: its stored enabled flag falling
 * back to the module default, and its stored schedule override falling back to
 * whatever schedule(cfg) computes.
 */
function resolve(mod, setting, cfg) {
  const enabled = setting?.enabled != null ? setting.enabled : mod.defaultEnabled !== false;
  let expression = setting?.schedule_override || null;
  let scheduleError = null;

  if (!expression) {
    try {
      expression = mod.schedule(cfg);
    } catch (err) {
      scheduleError = err.message;
    }
  }
  if (expression && !cron.validate(expression)) {
    scheduleError = `invalid cron expression: ${expression}`;
  }
  return { enabled, expression, scheduleError };
}

// ─── Run tracking ─────────────────────────────────────────────────────────────

async function recordStart(orgId, key, trigger) {
  const { rows } = await db.query(
    `INSERT INTO automation_runs (organisation_id, automation_key, trigger)
     VALUES ($1, $2, $3) RETURNING id`,
    [orgId, key, trigger]
  );
  return rows[0].id;
}

async function recordFinish(runId, status, startedAt, summary, error) {
  await db.query(
    `UPDATE automation_runs
     SET finished_at = NOW(), status = $1, duration_ms = $2, summary = $3, error = $4
     WHERE id = $5`,
    [status, Date.now() - startedAt, summary || null, error || null, runId]
  );
}

/**
 * Runs one automation, recording the attempt either way.
 * Never throws — a failing automation must not take the scheduler down.
 */
async function runOne(key, trigger = 'manual') {
  const mod = automations.get(key);
  if (!mod) throw new Error(`Unknown automation: ${key}`);

  const orgId = getOrgId();
  const cfg   = configService.getSprintConfig();
  const startedAt = Date.now();

  let runId = null;
  try {
    runId = await recordStart(orgId, key, trigger);
  } catch (err) {
    console.error(`[registry] could not record run start for ${key}:`, err.message);
  }

  console.log(`[registry] ▶ ${key} (${trigger})`);
  try {
    const result = await mod.run({ orgId, cfg, trigger });
    const summary = result && typeof result === 'object'
      ? JSON.stringify(result).slice(0, 500)
      : (result == null ? null : String(result).slice(0, 500));
    if (runId) await recordFinish(runId, 'success', startedAt, summary, null);
    console.log(`[registry] ✓ ${key} (${Date.now() - startedAt}ms)`);
    return { ok: true, result };
  } catch (err) {
    if (runId) await recordFinish(runId, 'failed', startedAt, null, err.message).catch(() => {});
    console.error(`[registry] ✗ ${key} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

function unschedule(key) {
  const task = tasks.get(key);
  if (task) {
    task.stop();
    tasks.delete(key);
  }
}

function unscheduleAll() {
  for (const key of [...tasks.keys()]) unschedule(key);
}

/**
 * (Re)builds the schedule for every automation from current config and stored
 * settings. Safe to call at any time — this is what makes a toggle or a changed
 * sync time take effect without a restart, which the old scheduler could not do.
 */
async function reschedule() {
  const orgId    = getOrgId();
  const cfg      = configService.getSprintConfig();
  const timezone = cfg.timezone || 'Asia/Kolkata';
  const settings = await loadSettings(orgId);

  unscheduleAll();

  const scheduled = [];
  const skipped   = [];

  for (const mod of automations.values()) {
    const { enabled, expression, scheduleError } = resolve(mod, settings.get(mod.key), cfg);

    if (!enabled) { skipped.push(`${mod.key} (disabled)`); continue; }
    if (scheduleError) {
      console.error(`[registry] ${mod.key}: ${scheduleError} — not scheduled`);
      skipped.push(`${mod.key} (${scheduleError})`);
      continue;
    }

    const task = cron.schedule(expression, () => { runOne(mod.key, 'schedule'); }, { timezone });
    tasks.set(mod.key, task);
    scheduled.push({ key: mod.key, expression });
  }

  console.log(`[registry] ${scheduled.length} automations scheduled (tz: ${timezone})`);
  for (const s of scheduled) console.log(`[registry]   ${s.key.padEnd(24)} ${s.expression}`);
  if (skipped.length) console.log(`[registry]   skipped: ${skipped.join(', ')}`);

  return { scheduled, skipped };
}

async function setEnabled(key, enabled, updatedBy = 'dashboard') {
  if (!automations.has(key)) throw new Error(`Unknown automation: ${key}`);
  await db.query(
    `INSERT INTO automation_settings (organisation_id, automation_key, enabled, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (organisation_id, automation_key) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [getOrgId(), key, enabled, updatedBy]
  );
  await reschedule();
  return { key, enabled };
}

async function setSchedule(key, expression, updatedBy = 'dashboard') {
  if (!automations.has(key)) throw new Error(`Unknown automation: ${key}`);
  if (expression && !cron.validate(expression)) {
    throw new Error(`Not a valid cron expression: ${expression}`);
  }
  await db.query(
    `INSERT INTO automation_settings (organisation_id, automation_key, schedule_override, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (organisation_id, automation_key) DO UPDATE
       SET schedule_override = EXCLUDED.schedule_override, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [getOrgId(), key, expression || null, updatedBy]
  );
  await reschedule();
  return { key, schedule: expression || null };
}

// ─── Catalogue ────────────────────────────────────────────────────────────────

/** Everything the dashboard needs to render the automation list. */
async function list() {
  const orgId    = getOrgId();
  const cfg      = configService.getSprintConfig();
  const settings = await loadSettings(orgId);

  let lastRuns = new Map();
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (automation_key)
              automation_key, started_at, status, duration_ms, summary, error
       FROM automation_runs
       WHERE organisation_id = $1
       ORDER BY automation_key, started_at DESC`,
      [orgId]
    );
    lastRuns = new Map(rows.map((r) => [r.automation_key, r]));
  } catch (err) {
    console.warn('[registry] could not load run history:', err.message);
  }

  return [...automations.values()].map((mod) => {
    const { enabled, expression, scheduleError } = resolve(mod, settings.get(mod.key), cfg);
    const last = lastRuns.get(mod.key);
    return {
      key:         mod.key,
      name:        mod.name,
      description: mod.description,
      category:    mod.category,
      audience:    mod.audience,
      enabled,
      schedule:        expression || null,
      scheduleError,
      isCustomSchedule: Boolean(settings.get(mod.key)?.schedule_override),
      running:     tasks.has(mod.key),
      lastRun: last ? {
        at:         last.started_at,
        status:     last.status,
        durationMs: last.duration_ms,
        summary:    last.summary,
        error:      last.error,
      } : null,
    };
  });
}

function keys() {
  return [...automations.keys()];
}

async function start() {
  const count = load();
  console.log(`[registry] loaded ${count} automations`);
  return reschedule();
}

module.exports = {
  start, load, reschedule, unscheduleAll,
  list, keys, runOne, setEnabled, setSchedule,
  CATEGORIES, AUDIENCES,
};
