'use strict';

/**
 * Regression coverage for two bugs found while investigating confusing
 * Standup Rate numbers on the Overview dashboard:
 *
 *  1. standup_days_posted counted raw standup_posts rows, so posting twice
 *     in one day inflated the numerator (2 messages on day 1 of a 2-day-old
 *     sprint looked like 100% attendance instead of 1/2).
 *  2. The scoring formula already had a bulk-catch-up penalty
 *     (scoringService.computePerformanceScore's bulk_standup_posts), but
 *     computeSprintSummary never populated that field, so it never fired —
 *     dumping a week of updates in one message was scored the same as
 *     posting daily.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/mockRequire');

let dailyStatsReturn = [];

stubModule('repositories/sprintRepository', {
  findById: async (id) => ({ id, name: 'Sprint 1', start_date: '2026-06-29', end_date: '2026-07-05' }),
});

stubModule('repositories/standupRepository', {
  // Two distinct Slack messages, both posted on the same real day.
  getPostsForMemberInSprint: async () => ([
    { post_date: '2026-06-30', created_at: '2026-06-30T09:00:00Z' },
    { post_date: '2026-06-30', created_at: '2026-06-30T14:00:00Z' },
  ]),
});

stubModule('repositories/statsRepository', {
  getDailyStats: async () => dailyStatsReturn,
  upsertSprintSummary: async (orgId, sprintId, memberId, data) => data,
  getOverallStats:     async () => null,
  getCrossSprintTrend: async () => [],
  upsertOverallStats:  async () => {},
});

stubModule('repositories/taskRepository', {
  countByStatus: async () => ({ total: 0, completed: 0, inProgress: 0, notStarted: 0 }),
});
stubModule('repositories/deadlineRepository', {
  getByMemberAndSprint: async () => [],
});
stubModule('repositories/notificationRepository', {
  getNotificationHistory: async () => [],
});

const performanceService = require('../services/performanceService');

test('computeSprintSummary: two messages on the same day count as 1 day posted, not 2', async () => {
  dailyStatsReturn = [
    { stat_date: '2026-06-30', posted_standup: true, is_bulk_post: false, on_leave: false, checked_in: true },
  ];

  const summary = await performanceService.computeSprintSummary(1, 10, 99);
  assert.equal(summary.standup_days_posted, 1);
});

test('computeSprintSummary: bulk catch-up days are counted separately and lower the score', async () => {
  // Scenario A — no bulk catch-ups on record.
  dailyStatsReturn = [
    { stat_date: '2026-06-30', posted_standup: true, is_bulk_post: false, on_leave: false, checked_in: true },
  ];
  const clean = await performanceService.computeSprintSummary(1, 10, 99);
  assert.equal(clean.bulk_standup_posts, 0);

  // Scenario B — same real post, plus 3 days only covered by a later bulk
  // catch-up message (as cron.js's bulk-post detector would record them).
  dailyStatsReturn = [
    { stat_date: '2026-06-30', posted_standup: true, is_bulk_post: false, on_leave: false, checked_in: true },
    { stat_date: '2026-06-25', posted_standup: true, is_bulk_post: true,  on_leave: false, checked_in: true },
    { stat_date: '2026-06-26', posted_standup: true, is_bulk_post: true,  on_leave: false, checked_in: true },
    { stat_date: '2026-06-27', posted_standup: true, is_bulk_post: true,  on_leave: false, checked_in: true },
  ];
  const withBulk = await performanceService.computeSprintSummary(1, 10, 99);
  assert.equal(withBulk.bulk_standup_posts, 3);

  // Bulk catch-up days must not inflate standup_days_posted (only the one
  // real same-day post counts) ...
  assert.equal(withBulk.standup_days_posted, 1);
  // ... but they must pull the score down relative to the clean scenario.
  assert.ok(withBulk.performance_score < clean.performance_score,
    `expected bulk-catchup score ${withBulk.performance_score} < clean score ${clean.performance_score}`);
});
