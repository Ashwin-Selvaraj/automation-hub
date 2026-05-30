'use strict';

const db = require('../db');

async function upsertDailyStats(organisationId, sprintId, memberId, statDate, fields) {
  try {
    const {
      posted_standup = false,
      standup_post_id = null,
      tasks_completed = 0,
      tasks_moved_forward = 0,
      deadlines_due = 0,
      deadlines_hit = 0,
      deadlines_missed = 0,
      jira_comments_added = 0,
    } = fields;

    const { rows } = await db.query(
      `INSERT INTO member_daily_stats
         (organisation_id, sprint_id, member_id, stat_date,
          posted_standup, standup_post_id, tasks_completed, tasks_moved_forward,
          deadlines_due, deadlines_hit, deadlines_missed, jira_comments_added)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (organisation_id, sprint_id, member_id, stat_date) DO UPDATE SET
         posted_standup      = GREATEST(member_daily_stats.posted_standup::int, EXCLUDED.posted_standup::int)::boolean,
         standup_post_id     = COALESCE(EXCLUDED.standup_post_id, member_daily_stats.standup_post_id),
         tasks_completed     = member_daily_stats.tasks_completed + EXCLUDED.tasks_completed,
         tasks_moved_forward = member_daily_stats.tasks_moved_forward + EXCLUDED.tasks_moved_forward,
         deadlines_due       = member_daily_stats.deadlines_due + EXCLUDED.deadlines_due,
         deadlines_hit       = member_daily_stats.deadlines_hit + EXCLUDED.deadlines_hit,
         deadlines_missed    = member_daily_stats.deadlines_missed + EXCLUDED.deadlines_missed,
         jira_comments_added = member_daily_stats.jira_comments_added + EXCLUDED.jira_comments_added
       RETURNING *`,
      [organisationId, sprintId, memberId, statDate,
       posted_standup, standup_post_id, tasks_completed, tasks_moved_forward,
       deadlines_due, deadlines_hit, deadlines_missed, jira_comments_added]
    );
    return rows[0];
  } catch (err) {
    console.error('[statsRepository.upsertDailyStats]', err.message);
    throw err;
  }
}

async function getDailyStats(memberId, sprintId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM member_daily_stats WHERE member_id = $1 AND sprint_id = $2 ORDER BY stat_date ASC',
      [memberId, sprintId]
    );
    return rows;
  } catch (err) {
    console.error('[statsRepository.getDailyStats]', err.message);
    throw err;
  }
}

async function upsertSprintSummary(organisationId, sprintId, memberId, data) {
  try {
    const { rows } = await db.query(
      `INSERT INTO member_sprint_summary
         (organisation_id, sprint_id, member_id,
          standup_days_posted, standup_days_expected, standup_streak_max, standup_streak_current,
          tasks_assigned, tasks_completed, tasks_in_progress, tasks_not_started,
          completion_rate, deadlines_total, deadlines_hit, deadlines_missed, deadlines_extended,
          deadline_hit_rate, avg_days_overdue, slack_messages_processed, jira_auto_updates,
          no_match_dms_received, tasks_created_after_dm, performance_score, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
       ON CONFLICT (organisation_id, sprint_id, member_id) DO UPDATE SET
         standup_days_posted      = EXCLUDED.standup_days_posted,
         standup_days_expected    = EXCLUDED.standup_days_expected,
         standup_streak_max       = EXCLUDED.standup_streak_max,
         standup_streak_current   = EXCLUDED.standup_streak_current,
         tasks_assigned           = EXCLUDED.tasks_assigned,
         tasks_completed          = EXCLUDED.tasks_completed,
         tasks_in_progress        = EXCLUDED.tasks_in_progress,
         tasks_not_started        = EXCLUDED.tasks_not_started,
         completion_rate          = EXCLUDED.completion_rate,
         deadlines_total          = EXCLUDED.deadlines_total,
         deadlines_hit            = EXCLUDED.deadlines_hit,
         deadlines_missed         = EXCLUDED.deadlines_missed,
         deadlines_extended       = EXCLUDED.deadlines_extended,
         deadline_hit_rate        = EXCLUDED.deadline_hit_rate,
         avg_days_overdue         = EXCLUDED.avg_days_overdue,
         slack_messages_processed = EXCLUDED.slack_messages_processed,
         jira_auto_updates        = EXCLUDED.jira_auto_updates,
         no_match_dms_received    = EXCLUDED.no_match_dms_received,
         tasks_created_after_dm   = EXCLUDED.tasks_created_after_dm,
         performance_score        = EXCLUDED.performance_score,
         computed_at              = NOW()
       RETURNING *`,
      [
        organisationId, sprintId, memberId,
        data.standup_days_posted || 0,
        data.standup_days_expected || 0,
        data.standup_streak_max || 0,
        data.standup_streak_current || 0,
        data.tasks_assigned || 0,
        data.tasks_completed || 0,
        data.tasks_in_progress || 0,
        data.tasks_not_started || 0,
        data.completion_rate || 0,
        data.deadlines_total || 0,
        data.deadlines_hit || 0,
        data.deadlines_missed || 0,
        data.deadlines_extended || 0,
        data.deadline_hit_rate || 0,
        data.avg_days_overdue || 0,
        data.slack_messages_processed || 0,
        data.jira_auto_updates || 0,
        data.no_match_dms_received || 0,
        data.tasks_created_after_dm || 0,
        data.performance_score || 0,
      ]
    );
    return rows[0];
  } catch (err) {
    console.error('[statsRepository.upsertSprintSummary]', err.message);
    throw err;
  }
}

async function getSprintSummary(memberId, sprintId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM member_sprint_summary WHERE member_id = $1 AND sprint_id = $2',
      [memberId, sprintId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[statsRepository.getSprintSummary]', err.message);
    throw err;
  }
}

async function getAllSprintSummaries(sprintId) {
  try {
    const { rows } = await db.query(
      `SELECT mss.*, m.name, m.slack_user_id, m.role
       FROM member_sprint_summary mss
       JOIN members m ON mss.member_id = m.id
       WHERE mss.sprint_id = $1
       ORDER BY mss.performance_score DESC`,
      [sprintId]
    );
    return rows;
  } catch (err) {
    console.error('[statsRepository.getAllSprintSummaries]', err.message);
    throw err;
  }
}

async function upsertOverallStats(organisationId, memberId, data) {
  try {
    const { rows } = await db.query(
      `INSERT INTO member_overall_stats
         (organisation_id, member_id, sprints_participated,
          total_tasks_completed, total_deadlines_hit, total_deadlines_missed,
          total_standup_posts, avg_performance_score, best_sprint_score,
          best_sprint_id, current_standup_streak, longest_ever_streak, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (organisation_id, member_id) DO UPDATE SET
         sprints_participated   = EXCLUDED.sprints_participated,
         total_tasks_completed  = EXCLUDED.total_tasks_completed,
         total_deadlines_hit    = EXCLUDED.total_deadlines_hit,
         total_deadlines_missed = EXCLUDED.total_deadlines_missed,
         total_standup_posts    = EXCLUDED.total_standup_posts,
         avg_performance_score  = EXCLUDED.avg_performance_score,
         best_sprint_score      = EXCLUDED.best_sprint_score,
         best_sprint_id         = EXCLUDED.best_sprint_id,
         current_standup_streak = EXCLUDED.current_standup_streak,
         longest_ever_streak    = EXCLUDED.longest_ever_streak,
         last_updated           = NOW()
       RETURNING *`,
      [
        organisationId, memberId,
        data.sprints_participated || 0,
        data.total_tasks_completed || 0,
        data.total_deadlines_hit || 0,
        data.total_deadlines_missed || 0,
        data.total_standup_posts || 0,
        data.avg_performance_score || 0,
        data.best_sprint_score || 0,
        data.best_sprint_id || null,
        data.current_standup_streak || 0,
        data.longest_ever_streak || 0,
      ]
    );
    return rows[0];
  } catch (err) {
    console.error('[statsRepository.upsertOverallStats]', err.message);
    throw err;
  }
}

async function getOverallStats(memberId, organisationId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM member_overall_stats WHERE member_id = $1 AND organisation_id = $2',
      [memberId, organisationId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[statsRepository.getOverallStats]', err.message);
    throw err;
  }
}

async function getLeaderboard(organisationId, sprintId) {
  try {
    const { rows } = await db.query(
      `SELECT mss.*, m.name, m.slack_user_id, m.role,
              ROW_NUMBER() OVER (ORDER BY mss.performance_score DESC) AS rank
       FROM member_sprint_summary mss
       JOIN members m ON mss.member_id = m.id
       WHERE mss.organisation_id = $1 AND mss.sprint_id = $2
       ORDER BY mss.performance_score DESC`,
      [organisationId, sprintId]
    );
    return rows;
  } catch (err) {
    console.error('[statsRepository.getLeaderboard]', err.message);
    throw err;
  }
}

async function getCrossSprintTrend(memberId, organisationId, limit) {
  try {
    const { rows } = await db.query(
      `SELECT mss.*, s.name AS sprint_name, s.start_date, s.end_date
       FROM member_sprint_summary mss
       JOIN sprints s ON mss.sprint_id = s.id
       WHERE mss.member_id = $1 AND mss.organisation_id = $2
       ORDER BY s.start_date DESC
       LIMIT $3`,
      [memberId, organisationId, limit || 5]
    );
    return rows;
  } catch (err) {
    console.error('[statsRepository.getCrossSprintTrend]', err.message);
    throw err;
  }
}

module.exports = {
  upsertDailyStats, getDailyStats,
  upsertSprintSummary, getSprintSummary, getAllSprintSummaries,
  upsertOverallStats, getOverallStats,
  getLeaderboard, getCrossSprintTrend,
};
