'use strict';

require('dotenv').config();
const { workingDatesBetween } = require('./dateOnly');

/**
 * Returns the current sprint window dates based on env config.
 * @returns {{ start: Date, end: Date, startStr: string, endStr: string }}
 */
function getSprintWindow() {
  const startStr = process.env.SPRINT_START_DATE || '2026-05-18';
  const durationWeeks = parseInt(process.env.SPRINT_DURATION_WEEKS || '2', 10);

  const start = new Date(startStr + 'T00:00:00.000Z');
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + durationWeeks * 7 - 1);

  const fmt = (d) => d.toISOString().split('T')[0];

  return { start, end, startStr: fmt(start), endStr: fmt(end) };
}

/**
 * Returns an array of week objects for each week in the sprint.
 * @returns {Array<{ label: string, start: Date, end: Date }>}
 */
function getSprintWeeks() {
  const { start } = getSprintWindow();
  const durationWeeks = parseInt(process.env.SPRINT_DURATION_WEEKS || '2', 10);
  const weeks = [];

  for (let i = 0; i < durationWeeks; i++) {
    const weekStart = new Date(start);
    weekStart.setUTCDate(weekStart.getUTCDate() + i * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weeks.push({
      label: `Week ${i + 1}`,
      start: weekStart,
      end: weekEnd,
    });
  }

  return weeks;
}

/**
 * Counts working days from the given date up to and including today, in the
 * team's timezone and on the team's working days.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {number}
 */
function getWorkingDaysSince(dateStr) {
  const teamClock = require('./teamClock');
  return workingDatesBetween(dateStr, teamClock.today(), teamClock.workdays()).length;
}

module.exports = { getSprintWindow, getSprintWeeks, getWorkingDaysSince };
