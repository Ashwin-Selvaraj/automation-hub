'use strict';

const configService = require('../services/configService');
const { todayInZone, dateInZone } = require('./dateOnly');

/**
 * "Today" and "which day was that" as the team lives them.
 *
 * The server's clock is UTC (or whatever the host is set to); the team's day
 * starts at its own midnight. For a team in Kolkata, UTC's date is still
 * yesterday until 05:30, so anything keyed or filtered by date — stats rows,
 * dedupe keys, "overdue" cut-offs — has to ask here, not call
 * `new Date().toISOString()`.
 */

function teamZone() {
  return configService.getSprintConfig().timezone || 'Asia/Kolkata';
}

/** The team's current date, YYYY-MM-DD. */
function today(now = new Date()) {
  return todayInZone(teamZone(), now);
}

/** The team's date for an instant (e.g. when a Slack message was posted). */
function dateOf(instant) {
  return dateInZone(instant, teamZone());
}

/** The team's working days as a cron day-of-week field, e.g. "1-5". */
function workdays() {
  return configService.getSprintConfig().workdays || '1-5';
}

module.exports = { teamZone, today, dateOf, workdays };
