'use strict';

require('dotenv').config();

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
 * Determines if a given date string falls within the current sprint window.
 * @param {string} dateStr - ISO date string or YYYY-MM-DD
 * @returns {boolean}
 */
function isInSprintWindow(dateStr) {
  const { start, end } = getSprintWindow();
  const date = new Date(dateStr);
  const dayStart = new Date(date.toISOString().split('T')[0] + 'T00:00:00.000Z');
  return dayStart >= start && dayStart <= end;
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
 * Converts a YYYY-MM-DD date string to a Unix timestamp (seconds).
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {number}
 */
function toUnixTimestamp(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00.000Z').getTime() / 1000);
}

/**
 * Counts Mon–Fri working days since the given date up to today.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {number}
 */
function getWorkingDaysSince(dateStr) {
  const start = new Date(dateStr + 'T00:00:00.000Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= today) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

module.exports = { getSprintWindow, isInSprintWindow, getSprintWeeks, toUnixTimestamp, getWorkingDaysSince };
