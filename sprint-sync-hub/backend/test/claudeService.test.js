'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.ANTHROPIC_API_KEY = 'test-key';

// ── Stub the Anthropic SDK before claudeService (which requires it) loads ──
// claudeService always does JSON.parse(match) on res.content[0].text, so the
// fake client just needs to hand back whatever text the current test wants.
let nextResponseText = '{}';

class FakeAnthropic {
  constructor(opts) { this.opts = opts; }
  get messages() {
    return {
      create: async () => ({ content: [{ text: nextResponseText }] }),
    };
  }
}

const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const claudeService = require('../services/claudeService');

function setResponse(obj) {
  nextResponseText = typeof obj === 'string' ? obj : JSON.stringify(obj);
}

// ── matchHuddleToJira ────────────────────────────────────────────────────────

test('matchHuddleToJira: parses a well-formed JSON response', async () => {
  setResponse({
    matched: true, confidence: 92, issueKey: 'QG-12', issueTitle: 'Build login page',
    suggestedStatus: 'In Progress', commentText: 'Working on login page',
    reason: 'Direct match', matchType: 'assigned_task', mismatchDetails: null,
  });

  const result = await claudeService.matchHuddleToJira(
    'Finished the login page UI', 'Alice',
    [{ key: 'QG-12', summary: 'Build login page', status: 'To Do' }],
    'Sprint 1', [{ key: 'QG-12', summary: 'Build login page' }]
  );

  assert.equal(result.matched, true);
  assert.equal(result.issueKey, 'QG-12');
  assert.equal(result.matchType, 'assigned_task');
  assert.equal(result.confidence, 92);
});

test('matchHuddleToJira: extracts the JSON object even with surrounding prose', async () => {
  nextResponseText = 'Here is my analysis:\n' +
    '{"matched":false,"confidence":10,"issueKey":null,"issueTitle":null,"suggestedStatus":"To Do","commentText":"","reason":"no match","matchType":"no_match","mismatchDetails":null}' +
    '\nHope that helps!';

  const result = await claudeService.matchHuddleToJira('unrelated text', 'Bob', [], 'Sprint 1', []);
  assert.equal(result.matched, false);
  assert.equal(result.matchType, 'no_match');
});

test('matchHuddleToJira: derives matchType from legacy matched/confidence fields when matchType is missing', async () => {
  setResponse({
    matched: true, confidence: 80, issueKey: 'QG-5', issueTitle: 'X',
    suggestedStatus: 'Done', commentText: 'done', reason: 'ok',
  });

  const assignedResult = await claudeService.matchHuddleToJira(
    'text', 'Alice', [{ key: 'QG-5', summary: 'X', status: 'To Do' }], 'Sprint 1',
    [{ key: 'QG-5', summary: 'X' }]
  );
  assert.equal(assignedResult.matchType, 'assigned_task');

  const unassignedResult = await claudeService.matchHuddleToJira(
    'text', 'Alice', [{ key: 'QG-5', summary: 'X', status: 'To Do' }], 'Sprint 1', []
  );
  assert.equal(unassignedResult.matchType, 'unassigned_task');
});

test('matchHuddleToJira: throws when Claude returns no JSON object at all', async () => {
  nextResponseText = 'I cannot help with that.';
  await assert.rejects(
    () => claudeService.matchHuddleToJira('text', 'Alice', [], 'Sprint 1', []),
    /Claude matchHuddleToJira failed/
  );
});

// ── parseMultiDateStandup ────────────────────────────────────────────────────

test('parseMultiDateStandup: parses a multi-date bulk post', async () => {
  setResponse({
    isMultiDate: true,
    entries: [
      { date: '2026-06-30', updates: ['Fixed bug A'] },
      { date: '2026-07-01', updates: ['Shipped feature B'] },
    ],
    note: 'Posted 2 days of updates in one message',
  });

  const result = await claudeService.parseMultiDateStandup(
    'Monday: fixed bug A\nTuesday: shipped feature B', 'Alice'
  );
  assert.ok(result);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].date, '2026-06-30');
});

test('parseMultiDateStandup: returns null for a single-day update', async () => {
  setResponse({ isMultiDate: false, entries: null });
  const result = await claudeService.parseMultiDateStandup('Finished the login page', 'Alice');
  assert.equal(result, null);
});

test('parseMultiDateStandup: returns null (not a throw) when the response has no JSON', async () => {
  nextResponseText = 'not json at all, no braces';
  const result = await claudeService.parseMultiDateStandup('text', 'Alice');
  assert.equal(result, null);
});
