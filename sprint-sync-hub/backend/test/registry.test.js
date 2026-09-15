'use strict';

/**
 * Loads the real automation modules — no stubs — so a malformed one fails here
 * rather than at boot on a server nobody is watching.
 *
 * The registry discovers modules off the filesystem, so a new automation is
 * covered by these checks the moment it is added.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const cron   = require('node-cron');
const path   = require('path');

process.env.ORGANISATION_ID = '1';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/unused';

const registry = require('../automations/registry');

// The config an automation sees at boot, with nothing configured.
const EMPTY_CFG = {};

// A fully populated config.
const FULL_CFG = {
  syncTime: '10:00', eodCheckTime: '18:30', deadlineTime: '09:00',
  reportDay: 'Friday', reportTime: '17:00', checkoutHours: '16-19',
  workdays: '1-5', timezone: 'Asia/Kolkata',
};

test('every automation module loads and declares the required metadata', () => {
  const count = registry.load();
  assert.ok(count > 0, 'expected at least one automation to be discovered');

  const keys = registry.keys();
  assert.equal(new Set(keys).size, keys.length, 'automation keys must be unique');
});

test('every automation produces a valid cron expression, configured or not', () => {
  registry.load();

  for (const key of registry.keys()) {
    const mod = require(resolveModule(key));

    for (const [label, cfg] of [['empty config', EMPTY_CFG], ['full config', FULL_CFG]]) {
      let expression;
      assert.doesNotThrow(
        () => { expression = mod.schedule(cfg); },
        `${key}.schedule() threw with ${label}`
      );
      assert.ok(
        cron.validate(expression),
        `${key}.schedule() produced an invalid expression with ${label}: ${expression}`
      );
    }
  }
});

test('the standup sync is on by default and the checkout watcher is not', () => {
  registry.load();
  const standup  = require(resolveModule('standup-sync'));
  const checkout = require(resolveModule('checkout-watch'));

  assert.notEqual(standup.defaultEnabled, false, 'the core sync should default to on');
  assert.equal(checkout.defaultEnabled, false, 'the checkout watcher should default to off');
});

test('person-facing automations declare a human audience', () => {
  registry.load();
  for (const key of registry.keys()) {
    const mod = require(resolveModule(key));
    assert.ok(
      registry.AUDIENCES.includes(mod.audience),
      `${key} declares an unknown audience: ${mod.audience}`
    );
  }
});

// Mirrors the registry's own discovery so tests can reach a module by key.
function resolveModule(key) {
  const fs = require('fs');
  const root = path.join(__dirname, '..', 'automations');
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(root, dir.name))) {
      if (!file.endsWith('.js')) continue;
      const full = path.join(root, dir.name, file);
      if (require(full).key === key) return full;
    }
  }
  throw new Error(`No module found for key ${key}`);
}
