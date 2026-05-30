'use strict';

const memberRepo       = require('../repositories/memberRepository');
const sprintRepo       = require('../repositories/sprintRepository');
const taskRepo         = require('../repositories/taskRepository');
const standupRepo      = require('../repositories/standupRepository');
const deadlineRepo     = require('../repositories/deadlineRepository');
const statsRepo        = require('../repositories/statsRepository');
const notifRepo        = require('../repositories/notificationRepository');
const scoringService   = require('./scoringService');
const slackService     = require('./slackService');
const jiraService      = require('./jiraService');
const claudeService    = require('./claudeService');
const { getSprintConfig } = require('../utils/sprintConfig');

function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  return d.toISOString().substring(0, 10);
}

function workingDaysInRange(startDate, endDate) {
  const start = new Date(startDate);
  const end   = new Date(endDate);
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function workingDaysUntilToday(startDate) {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return workingDaysInRange(startDate, today);
}

function computeStreaks(dailyPosts, expectedDates) {
  // expectedDates: array of 'YYYY-MM-DD' strings (working days)
  const posted = new Set(dailyPosts.map((p) => toDateStr(p.post_date)));
  let currentStreak = 0;
  let maxStreak = 0;
  let running = 0;

  for (const date of expectedDates) {
    if (posted.has(date)) {
      running++;
      maxStreak = Math.max(maxStreak, running);
    } else {
      running = 0;
    }
  }

  // Current streak = tail of consecutive hits
  for (let i = expectedDates.length - 1; i >= 0; i--) {
    if (posted.has(expectedDates[i])) currentStreak++;
    else break;
  }

  return { currentStreak, maxStreak };
}

function getWorkingDaysList(startDate, endDate) {
  const days = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) days.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

async function syncMemberStandup(organisationId, sprintId, slackMessage) {
  const cfg = getSprintConfig();
  const slackUserId = slackMessage.user;
  if (!slackUserId) return null;

  const memberCfg = cfg.teamMembers.find((m) => m.id === slackUserId);
  const name = memberCfg?.name || slackUserId;
  const email = memberCfg?.email || null;
  const role = memberCfg?.role || null;

  const member = await memberRepo.findOrCreate(organisationId, slackUserId, name, email, role);
  const postDate = toDateStr(new Date(parseFloat(slackMessage.ts) * 1000));

  const standupPost = await standupRepo.recordPost(
    organisationId, sprintId, member.id,
    slackMessage.ts, postDate, slackMessage.text
  );

  await statsRepo.upsertDailyStats(organisationId, sprintId, member.id, postDate, {
    posted_standup: true,
    standup_post_id: standupPost.id,
  });

  // Update current standup streak in overall stats
  const overall = await statsRepo.getOverallStats(member.id, organisationId) || {};
  const sprint = await sprintRepo.findById(sprintId);
  const allDays = sprint ? getWorkingDaysList(sprint.start_date, new Date()) : [];
  const posts = await standupRepo.getPostsForMemberInSprint(member.id, sprintId);
  const { currentStreak, maxStreak } = computeStreaks(posts, allDays);

  await statsRepo.upsertOverallStats(organisationId, member.id, {
    sprints_participated:   overall.sprints_participated   || 0,
    total_tasks_completed:  overall.total_tasks_completed  || 0,
    total_deadlines_hit:    overall.total_deadlines_hit    || 0,
    total_deadlines_missed: overall.total_deadlines_missed || 0,
    total_standup_posts:    (overall.total_standup_posts   || 0) + 1,
    avg_performance_score:  overall.avg_performance_score  || 0,
    best_sprint_score:      overall.best_sprint_score      || 0,
    best_sprint_id:         overall.best_sprint_id         || null,
    current_standup_streak: currentStreak,
    longest_ever_streak:    Math.max(overall.longest_ever_streak || 0, maxStreak),
  });

  return { member, standupPost };
}

async function recordJiraSync(organisationId, sprintId, memberId, taskId, fromStatus, toStatus, triggeredBy) {
  try {
    await require('../db').query(
      `INSERT INTO task_transitions
         (organisation_id, task_id, member_id, from_status, to_status, triggered_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organisationId, taskId, memberId, fromStatus || null, toStatus, triggeredBy || 'slack_sync']
    );
  } catch (err) {
    console.error('[performanceService.recordJiraSync] transition insert:', err.message);
  }

  const DONE_STATUSES = ['done', 'closed', 'resolved', 'complete', 'completed'];
  const isDone = DONE_STATUSES.includes((toStatus || '').toLowerCase());

  if (isDone) {
    await taskRepo.markCompleted(taskId);

    const deadlineEvent = await deadlineRepo.findByTaskId(taskId);
    if (deadlineEvent) {
      const today = toDateStr(new Date());
      const dueDate = toDateStr(deadlineEvent.due_date);
      const daysOverdue = today > dueDate
        ? Math.floor((new Date(today) - new Date(dueDate)) / 86400000)
        : 0;
      const status = today <= dueDate ? 'hit' : 'missed';
      await deadlineRepo.updateStatus(deadlineEvent.id, status, today, daysOverdue);
    }
  }

  const today = toDateStr(new Date());
  await statsRepo.upsertDailyStats(organisationId, sprintId, memberId, today, {
    tasks_completed:     isDone ? 1 : 0,
    tasks_moved_forward: isDone ? 0 : 1,
    jira_comments_added: 1,
  });
}

async function recordNoMatchDM(organisationId, sprintId, memberId, slackMessageTs) {
  try {
    await notifRepo.recordNotification(organisationId, memberId, 'no_match_dm', 'dm', null);
    const today = toDateStr(new Date());
    await statsRepo.upsertDailyStats(organisationId, sprintId, memberId, today, {
      no_match_dms_received: 1,
    });
  } catch (err) {
    console.error('[performanceService.recordNoMatchDM]', err.message);
  }
}

async function runDailyDeadlineCheck(organisationId, sprintId) {
  const cfg = getSprintConfig();

  let overdueTasks = [];
  try {
    overdueTasks = await taskRepo.getOverdueTasks(organisationId, sprintId);
  } catch (err) {
    console.error('[performanceService.runDailyDeadlineCheck] getOverdueTasks:', err.message);
    return;
  }

  for (const task of overdueTasks) {
    try {
      const daysOverdue = Math.floor(
        (new Date() - new Date(task.due_date)) / 86400000
      );

      if (task.assignee_id) {
        let event = await deadlineRepo.findByTaskId(task.id);
        if (!event) {
          event = await deadlineRepo.recordDeadlineEvent(
            organisationId, sprintId, task.assignee_id, task.id,
            toDateStr(task.due_date), 'missed', daysOverdue
          );
        }

        const alreadyNotified = await notifRepo.wasNotifiedRecently(
          task.assignee_id, 'deadline_reminder', task.id, 24
        );

        if (!alreadyNotified && task.slack_user_id) {
          try {
            const jiraSiteUrl = process.env.JIRA_SITE_URL || '';
            const issueUrl = `${jiraSiteUrl.replace(/\/$/, '')}/browse/${task.jira_key}`;
            const dmText = await claudeService.draftDeadlineDM(
              task.assignee_name || task.slack_user_id,
              task.jira_key,
              task.title,
              daysOverdue,
              issueUrl
            );
            await slackService.sendDM(task.slack_user_id, dmText);
            await notifRepo.recordNotification(
              organisationId, task.assignee_id, 'deadline_reminder', 'dm', task.id
            );
            if (event) await deadlineRepo.incrementReminderCount(event.id);

            if (daysOverdue > 3) {
              const escalated =
                `🚨 *Escalation — ${daysOverdue} days overdue*\n` +
                `*${task.jira_key}*: "${task.title}"\n` +
                `This task is critically overdue. Please update its status immediately.\n` +
                `→ ${issueUrl}`;
              await slackService.sendDM(task.slack_user_id, escalated);
              await notifRepo.recordNotification(
                organisationId, task.assignee_id, 'deadline_overdue_3d', 'dm', task.id
              );

              if (cfg.managerSlackId) {
                const managerDM =
                  `📋 *Overdue escalation* — ${daysOverdue} days\n` +
                  `<@${task.slack_user_id}>'s task *${task.jira_key}* ("${task.title}") has not been updated.\n` +
                  `→ ${issueUrl}`;
                await slackService.sendDM(cfg.managerSlackId, managerDM);
              }
            }
          } catch (dmErr) {
            console.error('[performanceService.runDailyDeadlineCheck] DM failed:', dmErr.message);
          }
        }

        const today = toDateStr(new Date());
        await statsRepo.upsertDailyStats(organisationId, sprintId, task.assignee_id, today, {
          deadlines_due:    1,
          deadlines_missed: 1,
        });
      }
    } catch (err) {
      console.error('[performanceService.runDailyDeadlineCheck] task error:', err.message);
    }
  }
}

async function computeSprintSummary(organisationId, sprintId, memberId) {
  const sprint = await sprintRepo.findById(sprintId);
  if (!sprint) return null;

  const today = new Date();
  const sprintEnd = new Date(sprint.end_date);
  const effectiveEnd = today < sprintEnd ? today : sprintEnd;

  const allWorkingDays = getWorkingDaysList(sprint.start_date, effectiveEnd);

  // Load daily stats to find leave/absent days — those are excluded from standup expectations
  const dailyStatsFull = await statsRepo.getDailyStats(memberId, sprintId);
  const leaveOrAbsentDates = new Set(
    dailyStatsFull
      .filter((d) => d.on_leave === true || d.checked_in === false)
      .map((d) => toDateStr(d.stat_date))
  );

  // Working days where the person was actually expected to be present
  const effectiveDays = allWorkingDays.filter((d) => !leaveOrAbsentDates.has(d));
  const standup_days_expected = effectiveDays.length;

  const posts = await standupRepo.getPostsForMemberInSprint(memberId, sprintId);
  const standup_days_posted = posts.length;
  const { currentStreak, maxStreak } = computeStreaks(posts, effectiveDays);

  const taskCounts = await taskRepo.countByStatus(sprintId, memberId);
  const deadlineEvents = await deadlineRepo.getByMemberAndSprint(memberId, sprintId);

  const deadlines_total    = deadlineEvents.length;
  const deadlines_hit      = deadlineEvents.filter((d) => d.status === 'hit').length;
  const deadlines_missed   = deadlineEvents.filter((d) => d.status === 'missed').length;
  const deadlines_extended = deadlineEvents.filter((d) => d.status === 'extended').length;

  const overdueEvents = deadlineEvents.filter((d) => d.days_overdue > 0);
  const avg_days_overdue = overdueEvents.length > 0
    ? overdueEvents.reduce((s, d) => s + (d.days_overdue || 0), 0) / overdueEvents.length
    : 0;

  const dailyStats = dailyStatsFull; // already fetched above
  const slack_messages_processed = dailyStats.reduce((s, d) => s + (d.jira_comments_added || 0) + (d.tasks_moved_forward || 0), 0);
  const jira_auto_updates        = dailyStats.reduce((s, d) => s + (d.jira_comments_added || 0), 0);

  // Attendance aggregates (from Zoho data stored in daily stats)
  const days_present  = dailyStats.filter((d) => d.checked_in === true).length;
  const days_on_leave = dailyStats.filter((d) => d.on_leave   === true).length;
  const days_absent   = dailyStats.filter((d) => d.checked_in === false && !d.on_leave).length;

  // Late arrivals (check_in_time > WORK_START_TIME)
  const workStartStr  = process.env.WORK_START_TIME || '09:00';
  const [wsh, wsm]    = workStartStr.split(':').map(Number);
  const workStartMins = wsh * 60 + wsm;
  const late_arrivals = dailyStats.filter((d) => {
    if (!d.check_in_time) return false;
    const t = String(d.check_in_time).substring(0, 5);
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m > workStartMins;
  }).length;

  // Average check-in time
  const checkInTimes = dailyStats
    .map((d) => d.check_in_time ? String(d.check_in_time).substring(0, 5) : null)
    .filter(Boolean);
  let avg_checkin_time = null;
  if (checkInTimes.length > 0) {
    const totalMins = checkInTimes.reduce((sum, t) => {
      const [h, m] = t.split(':').map(Number);
      return sum + h * 60 + m;
    }, 0);
    const avgMins = Math.round(totalMins / checkInTimes.length);
    avg_checkin_time = `${String(Math.floor(avgMins / 60)).padStart(2, '0')}:${String(avgMins % 60).padStart(2, '0')}`;
  }

  const attendance_rate = allWorkingDays.length > 0
    ? Math.round(((days_present + days_on_leave) / allWorkingDays.length) * 10000) / 100
    : 100;

  const notifHistory = await notifRepo.getNotificationHistory(organisationId, memberId, 200);
  const no_match_dms_received  = notifHistory.filter((n) => n.type === 'no_match_dm').length;
  const tasks_created_after_dm = 0; // no automated tracking of post-DM task creation yet

  const summaryData = {
    standup_days_posted,
    standup_days_expected,
    standup_streak_max:     maxStreak,
    standup_streak_current: currentStreak,
    tasks_assigned:    taskCounts.total,
    tasks_completed:   taskCounts.completed,
    tasks_in_progress: taskCounts.inProgress,
    tasks_not_started: taskCounts.notStarted,
    completion_rate:   taskCounts.total > 0 ? Math.round((taskCounts.completed / taskCounts.total) * 10000) / 100 : 0,
    deadlines_total,
    deadlines_hit,
    deadlines_missed,
    deadlines_extended,
    deadline_hit_rate: deadlines_total > 0 ? Math.round((deadlines_hit / deadlines_total) * 10000) / 100 : 100,
    avg_days_overdue:  Math.round(avg_days_overdue * 100) / 100,
    slack_messages_processed,
    jira_auto_updates,
    no_match_dms_received,
    tasks_created_after_dm,
    // Attendance
    days_present,
    days_absent,
    days_on_leave,
    late_arrivals,
    avg_checkin_time,
    attendance_rate,
  };

  summaryData.performance_score = scoringService.computePerformanceScore(summaryData);

  await statsRepo.upsertSprintSummary(organisationId, sprintId, memberId, summaryData);

  // Update overall stats running totals
  const existing = await statsRepo.getOverallStats(memberId, organisationId) || {};
  const allSprints = await statsRepo.getCrossSprintTrend(memberId, organisationId, 100);
  const sprintCount = new Set(allSprints.map((s) => s.sprint_id)).size;
  const totalScore = allSprints.reduce((sum, s) => sum + parseFloat(s.performance_score || 0), 0);
  const avgScore = sprintCount > 0 ? Math.round((totalScore / sprintCount) * 100) / 100 : 0;
  const bestSprint = allSprints.reduce((best, s) => {
    return !best || parseFloat(s.performance_score) > parseFloat(best.performance_score) ? s : best;
  }, null);

  await statsRepo.upsertOverallStats(organisationId, memberId, {
    sprints_participated:   sprintCount,
    total_tasks_completed:  allSprints.reduce((s, x) => s + (x.tasks_completed || 0), 0),
    total_deadlines_hit:    allSprints.reduce((s, x) => s + (x.deadlines_hit || 0), 0),
    total_deadlines_missed: allSprints.reduce((s, x) => s + (x.deadlines_missed || 0), 0),
    total_standup_posts:    allSprints.reduce((s, x) => s + (x.standup_days_posted || 0), 0),
    avg_performance_score:  avgScore,
    best_sprint_score:      bestSprint ? parseFloat(bestSprint.performance_score) : 0,
    best_sprint_id:         bestSprint ? bestSprint.sprint_id : null,
    current_standup_streak: currentStreak,
    longest_ever_streak:    Math.max(existing.longest_ever_streak || 0, maxStreak),
  });

  return summaryData;
}

async function getMemberProfile(organisationId, memberId) {
  const member  = await memberRepo.findAll(organisationId).then((all) => all.find((m) => m.id === parseInt(memberId, 10)));
  if (!member) return null;

  const currentSprint  = await sprintRepo.getActiveSprint(organisationId);
  const history        = await statsRepo.getCrossSprintTrend(memberId, organisationId, 5);
  const overallStats   = await statsRepo.getOverallStats(memberId, organisationId);
  const recentActivity = await notifRepo.getNotificationHistory(organisationId, memberId, 10);

  let trend = 'stable';
  if (history.length >= 2) {
    trend = scoringService.getTrend(
      parseFloat(history[1].performance_score),
      parseFloat(history[0].performance_score)
    );
  }

  const currentSummary = currentSprint
    ? await statsRepo.getSprintSummary(memberId, currentSprint.id)
    : null;

  return { member, currentSprint, currentSummary, history, trend, overallStats, recentActivity };
}

async function getTeamLeaderboard(organisationId, sprintId) {
  const rows = await statsRepo.getLeaderboard(organisationId, sprintId);
  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    trend: 'stable',
    riskLevel: scoringService.getRiskLevel(r),
    label: scoringService.getPerformanceLabel(parseFloat(r.performance_score)),
  }));
}

async function getAtRiskMembers(organisationId, sprintId) {
  const all = await statsRepo.getAllSprintSummaries(sprintId);
  return all.filter((m) => {
    const standupRate = m.standup_days_expected > 0
      ? m.standup_days_posted / m.standup_days_expected : 1;
    const deadlineRate = m.deadlines_total > 0
      ? m.deadlines_hit / m.deadlines_total : 1;
    const score = parseFloat(m.performance_score || 0);
    return standupRate < 0.6 || deadlineRate < 0.7 || score < 50;
  }).map((m) => ({
    ...m,
    riskLevel: scoringService.getRiskLevel(m),
    riskReason: buildRiskReason(m),
  }));
}

function buildRiskReason(m) {
  const reasons = [];
  const standupRate = m.standup_days_expected > 0
    ? m.standup_days_posted / m.standup_days_expected : 1;
  const deadlineRate = m.deadlines_total > 0
    ? m.deadlines_hit / m.deadlines_total : 1;
  if (standupRate < 0.6) reasons.push(`${Math.round(standupRate * 100)}% standup attendance`);
  if (deadlineRate < 0.7) reasons.push(`${m.deadlines_missed} deadline(s) missed`);
  if (parseFloat(m.performance_score) < 50) reasons.push(`score ${m.performance_score}`);
  return reasons.join(', ') || 'low performance score';
}

module.exports = {
  syncMemberStandup,
  recordJiraSync,
  recordNoMatchDM,
  runDailyDeadlineCheck,
  computeSprintSummary,
  getMemberProfile,
  getTeamLeaderboard,
  getAtRiskMembers,
};
