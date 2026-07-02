'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  computePerformanceScore,
  getTrend,
  getRiskLevel,
  getPerformanceLabel,
} = require('../services/scoringService');

test('computePerformanceScore: full marks with no penalties', () => {
  const score = computePerformanceScore({
    standup_days_posted: 10, standup_days_expected: 10,
    deadlines_hit: 5, deadlines_total: 5,
    tasks_completed: 5, tasks_assigned: 5,
    jira_auto_updates: 10, slack_messages_processed: 10,
  });
  assert.equal(score, 100);
});

test('computePerformanceScore: no activity at all defaults to full marks (no denominators)', () => {
  assert.equal(computePerformanceScore({}), 100);
});

test('computePerformanceScore: missed standups reduce the score below a full attendance record', () => {
  const full = computePerformanceScore({ standup_days_posted: 10, standup_days_expected: 10 });
  const half = computePerformanceScore({ standup_days_posted: 5, standup_days_expected: 10 });
  assert.ok(half < full, `expected ${half} < ${full}`);
});

test('computePerformanceScore: unmatched no-match DMs are penalised', () => {
  const base = computePerformanceScore({ standup_days_posted: 10, standup_days_expected: 10 });
  const withPenalty = computePerformanceScore({
    standup_days_posted: 10, standup_days_expected: 10, no_match_dms_received: 3,
  });
  assert.ok(withPenalty < base, `expected ${withPenalty} < ${base}`);
});

test('computePerformanceScore: creating a task after a no-match DM cancels that penalty', () => {
  const withPenalty = computePerformanceScore({
    standup_days_posted: 10, standup_days_expected: 10, no_match_dms_received: 3,
  });
  const resolved = computePerformanceScore({
    standup_days_posted: 10, standup_days_expected: 10,
    no_match_dms_received: 3, tasks_created_after_dm: 3,
  });
  assert.ok(resolved > withPenalty, `expected ${resolved} > ${withPenalty}`);
});

test('computePerformanceScore: bulk standup posting penalty is capped at 10 points', () => {
  const some = computePerformanceScore({ standup_days_posted: 10, standup_days_expected: 10, bulk_standup_posts: 5 });
  const lots = computePerformanceScore({ standup_days_posted: 10, standup_days_expected: 10, bulk_standup_posts: 50 });
  assert.equal(some, lots);
  assert.equal(some, 90); // 100 - min(5*2,10)=10
});

test('computePerformanceScore: clamps to the [0, 100] range', () => {
  const worst = computePerformanceScore({
    standup_days_posted: 0, standup_days_expected: 10,
    deadlines_hit: 0, deadlines_total: 5,
    tasks_completed: 0, tasks_assigned: 5,
    jira_auto_updates: 0, slack_messages_processed: 5,
    no_match_dms_received: 100, deadlines_missed: 10, avg_days_overdue: 10,
  });
  assert.equal(worst, 0);

  const best = computePerformanceScore({
    standup_days_posted: 10, standup_days_expected: 10,
    deadlines_hit: 10, deadlines_total: 10,
    tasks_completed: 10, tasks_assigned: 10,
    jira_auto_updates: 10, slack_messages_processed: 10,
  });
  assert.equal(best, 100);
});

test('getTrend: classifies improvement, decline, and stability', () => {
  assert.equal(getTrend(50, 60), 'improving');
  assert.equal(getTrend(60, 50), 'declining');
  assert.equal(getTrend(50, 52), 'stable');
  assert.equal(getTrend(null, 50), 'stable');
  assert.equal(getTrend(50, null), 'stable');
});

test('getRiskLevel: high risk on low score, missed deadlines, or low standup rate', () => {
  assert.equal(getRiskLevel({ performance_score: 30 }), 'high');
  assert.equal(getRiskLevel({ performance_score: 80, deadlines_missed: 2 }), 'high');
  assert.equal(getRiskLevel({ performance_score: 80, standup_days_posted: 2, standup_days_expected: 10 }), 'high');
});

test('getRiskLevel: medium risk on a single missed deadline or moderate score', () => {
  assert.equal(getRiskLevel({ performance_score: 55 }), 'medium');
  assert.equal(getRiskLevel({ performance_score: 80, deadlines_missed: 1 }), 'medium');
});

test('getRiskLevel: low risk with a healthy score and full attendance', () => {
  assert.equal(getRiskLevel({
    performance_score: 80, deadlines_missed: 0,
    standup_days_posted: 10, standup_days_expected: 10,
  }), 'low');
});

test('getPerformanceLabel: maps score ranges to labels', () => {
  assert.equal(getPerformanceLabel(95), 'Excellent');
  assert.equal(getPerformanceLabel(80), 'Strong');
  assert.equal(getPerformanceLabel(65), 'On Track');
  assert.equal(getPerformanceLabel(50), 'Needs Attention');
  assert.equal(getPerformanceLabel(10), 'At Risk');
});
