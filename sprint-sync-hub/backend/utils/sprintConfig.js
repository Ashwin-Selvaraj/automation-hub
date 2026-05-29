'use strict';

require('dotenv').config();

// Runtime overrides — applied on top of .env values
const overrides = {};

/**
 * Returns the full sprint configuration, merging env defaults with any runtime overrides.
 * @returns {{ sprintName: string, startDate: string, durationWeeks: number, projectKey: string, channelId: string, timezone: string, teamMembers: Array }}
 */
function getSprintConfig() {
  const teamMembers = (() => {
    try {
      return JSON.parse(overrides.teamMembers || process.env.TEAM_MEMBERS || '[]');
    } catch {
      return [];
    }
  })();

  return {
    sprintName: overrides.sprintName || process.env.SPRINT_NAME || 'Sprint 1',
    startDate: overrides.startDate || process.env.SPRINT_START_DATE || '2026-05-18',
    durationWeeks: parseInt(overrides.durationWeeks || process.env.SPRINT_DURATION_WEEKS || '2', 10),
    projectKey: overrides.projectKey || process.env.JIRA_PROJECT_KEY || 'QG',

    channelId: process.env.SLACK_CHANNEL_ID || '',
    timezone: process.env.TIMEZONE || 'UTC',
    eodCheckTime: process.env.EOD_CHECK_TIME || '17:30',
    reportDay: process.env.REPORT_DAY || 'Friday',
    reportTime: process.env.REPORT_TIME || '17:00',
    managerSlackId: process.env.MANAGER_SLACK_ID || '',
    teamMembers,
  };
}

/**
 * Applies runtime overrides to sprint configuration without restarting.
 * @param {Object} updates - Key-value pairs to override
 */
function setSprintConfig(updates) {
  if (updates.sprintName !== undefined) overrides.sprintName = updates.sprintName;
  if (updates.startDate !== undefined) {
    overrides.startDate = updates.startDate;
    // Propagate to env so dateUtils picks it up
    process.env.SPRINT_START_DATE = updates.startDate;
  }
  if (updates.durationWeeks !== undefined) {
    overrides.durationWeeks = String(updates.durationWeeks);
    process.env.SPRINT_DURATION_WEEKS = String(updates.durationWeeks);
  }
  if (updates.projectKey !== undefined) {
    overrides.projectKey = updates.projectKey;
    process.env.JIRA_PROJECT_KEY = updates.projectKey;
  }
}

/**
 * Replaces the team members list entirely.
 * @param {Array} members - Array of { id, name, initials, role? }
 */
function setTeamMembers(members) {
  overrides.teamMembers = JSON.stringify(members);
  process.env.TEAM_MEMBERS = overrides.teamMembers;
}

module.exports = { getSprintConfig, setSprintConfig, setTeamMembers };
