'use strict';

require('dotenv').config();

// Runtime overrides — applied on top of .env values
const overrides = {};

/**
 * Returns the full sprint configuration, merging env defaults with any runtime overrides.
 * @returns {{ sprintName: string, startDate: string, durationWeeks: number, projectKey: string,
 *             channelId: string, timezone: string, eodCheckTime: string, reportDay: string,
 *             reportTime: string, managerSlackId: string, teamMembers: Array }}
 */
function getSprintConfig() {
  const teamMembers = (() => {
    const raw = overrides.teamMembers || process.env.TEAM_MEMBERS || '';
    if (!raw.trim()) return [];
    try {
      // First try parsing as-is
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Dotenv multi-line values (no surrounding quotes) arrive with literal newlines.
      // Also handle: trailing backslashes used as line-continuations, trailing commas.
      try {
        const cleaned = raw
          .replace(/\\\s*[\r\n]+\s*/g, '')   // "da"},\ \n  {"  → "da"},{"
          .replace(/[\r\n\t]/g, ' ')          // collapse all whitespace to spaces
          .replace(/,\s*([}\]])/g, '$1')      // remove trailing commas before } or ]
          .trim();
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.warn('[sprintConfig] TEAM_MEMBERS could not be parsed:', err.message,
          '\nHint: use a single-line value in .env, e.g. TEAM_MEMBERS=[{"id":"U123","name":"Alice","initials":"AL"}]');
        return [];
      }
    }
  })();

  return {
    sprintName:     overrides.sprintName    || process.env.SPRINT_NAME             || 'Sprint 1',
    startDate:      overrides.startDate     || process.env.SPRINT_START_DATE        || '2026-05-18',
    durationWeeks:  parseInt(overrides.durationWeeks || process.env.SPRINT_DURATION_WEEKS || '2', 10),
    projectKey:     overrides.projectKey    || process.env.JIRA_PROJECT_KEY         || 'QG',
    channelId:      overrides.channelId     || process.env.SLACK_CHANNEL_ID         || '',
    timezone:       overrides.timezone      || process.env.TIMEZONE                 || 'UTC',
    eodCheckTime:   overrides.eodCheckTime  || process.env.EOD_CHECK_TIME           || '17:30',
    reportDay:      overrides.reportDay     || process.env.REPORT_DAY               || 'Friday',
    reportTime:     overrides.reportTime    || process.env.REPORT_TIME              || '17:00',
    managerSlackId: overrides.managerSlackId || process.env.MANAGER_SLACK_ID        || '',
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
  if (updates.channelId !== undefined) {
    overrides.channelId = updates.channelId;
    process.env.SLACK_CHANNEL_ID = updates.channelId;
  }
  if (updates.timezone !== undefined) {
    overrides.timezone = updates.timezone;
    process.env.TIMEZONE = updates.timezone;
  }
  if (updates.eodCheckTime !== undefined) {
    overrides.eodCheckTime = updates.eodCheckTime;
    process.env.EOD_CHECK_TIME = updates.eodCheckTime;
  }
  if (updates.reportDay !== undefined) {
    overrides.reportDay = updates.reportDay;
    process.env.REPORT_DAY = updates.reportDay;
  }
  if (updates.reportTime !== undefined) {
    overrides.reportTime = updates.reportTime;
    process.env.REPORT_TIME = updates.reportTime;
  }
  if (updates.managerSlackId !== undefined) {
    overrides.managerSlackId = updates.managerSlackId;
    process.env.MANAGER_SLACK_ID = updates.managerSlackId;
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
