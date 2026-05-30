'use strict';

/**
 * Thin compatibility shim — delegates to configService (DB-backed).
 * Config is now stored in the `app_config` DB table. This file is kept for
 * backward-compat so existing routes / services don't need changing.
 */
const configService = require('../services/configService');

function getSprintConfig() {
  return configService.getSprintConfig();
}

/**
 * setSprintConfig — updates config in DB via configService.
 * Kept for backward-compat; new code should call configService.setMany() directly.
 */
async function setSprintConfig(updates) {
  const map = {};
  if (updates.sprintName     !== undefined) map['sprint.name']                = updates.sprintName;
  if (updates.startDate      !== undefined) map['sprint.start_date']          = updates.startDate;
  if (updates.durationWeeks  !== undefined) map['sprint.duration_weeks']      = String(updates.durationWeeks);
  if (updates.projectKey     !== undefined) map['jira.project_key']           = updates.projectKey;
  if (updates.channelId      !== undefined) map['slack.channel_id']           = updates.channelId;
  if (updates.timezone       !== undefined) map['schedule.timezone']          = updates.timezone;
  if (updates.eodCheckTime   !== undefined) map['schedule.eod_time']          = updates.eodCheckTime;
  if (updates.reportDay      !== undefined) map['schedule.report_day']        = updates.reportDay;
  if (updates.reportTime     !== undefined) map['schedule.report_time']       = updates.reportTime;
  if (updates.managerSlackId !== undefined) map['schedule.manager_slack_id']  = updates.managerSlackId;
  if (Object.keys(map).length) await configService.setMany(map);
}

function setTeamMembers(members) {
  process.env.TEAM_MEMBERS = JSON.stringify(members);
}

module.exports = { getSprintConfig, setSprintConfig, setTeamMembers };
