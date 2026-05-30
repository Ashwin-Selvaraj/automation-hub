'use strict';

function computePerformanceScore(stats) {
  const {
    standup_days_posted = 0,
    standup_days_expected = 0,
    deadlines_hit = 0,
    deadlines_total = 0,
    tasks_completed = 0,
    tasks_assigned = 0,
    jira_auto_updates = 0,
    slack_messages_processed = 0,
    no_match_dms_received = 0,
    tasks_created_after_dm = 0,
    deadlines_missed = 0,
    avg_days_overdue = 0,
    bulk_standup_posts = 0,   // days covered by bulk/late posts
  } = stats;

  const standupRate    = standup_days_expected > 0 ? standup_days_posted / standup_days_expected : 1;
  const deadlineRate   = deadlines_total > 0 ? deadlines_hit / deadlines_total : 1;
  const completionRate = tasks_assigned > 0 ? tasks_completed / tasks_assigned : 1;
  const jiraSyncRate   = slack_messages_processed > 0 ? jira_auto_updates / slack_messages_processed : 1;

  let score = (
    Math.min(standupRate, 1)    * 30 +
    Math.min(deadlineRate, 1)   * 35 +
    Math.min(completionRate, 1) * 25 +
    Math.min(jiraSyncRate, 1)   * 10
  );

  // Penalty deductions
  const unmatchedDMs    = Math.max(0, no_match_dms_received - tasks_created_after_dm);
  const severelyOverdue = deadlines_missed > 0 && avg_days_overdue > 3 ? deadlines_missed : 0;
  // Bulk posting penalty: -2 per day posted in bulk (not daily), max 10
  const bulkPenalty     = Math.min(bulk_standup_posts * 2, 10);

  let penalty = 0;
  penalty += unmatchedDMs * 5;
  penalty += severelyOverdue * 3;
  penalty += bulkPenalty;
  penalty = Math.min(penalty, 20);

  return Math.max(0, Math.min(100, Math.round((score - penalty) * 100) / 100));
}

function getTrend(previousScore, currentScore) {
  if (previousScore == null || currentScore == null) return 'stable';
  const diff = currentScore - previousScore;
  if (diff >= 5)  return 'improving';
  if (diff <= -5) return 'declining';
  return 'stable';
}

function getRiskLevel(stats) {
  const {
    performance_score = 0,
    deadlines_missed = 0,
    standup_days_posted = 0,
    standup_days_expected = 0,
  } = stats;

  const standupRate = standup_days_expected > 0
    ? standup_days_posted / standup_days_expected
    : 1;

  if (performance_score < 40 || deadlines_missed >= 2 || standupRate < 0.4) return 'high';
  if (performance_score < 60 || deadlines_missed >= 1 || standupRate < 0.6) return 'medium';
  return 'low';
}

function getPerformanceLabel(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Strong';
  if (score >= 60) return 'On Track';
  if (score >= 45) return 'Needs Attention';
  return 'At Risk';
}

module.exports = { computePerformanceScore, getTrend, getRiskLevel, getPerformanceLabel };
