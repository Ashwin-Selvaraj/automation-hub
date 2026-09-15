'use strict';

/**
 * Helpers for turning config values into cron expressions.
 *
 * Every automation computes its own schedule from the resolved config, so a
 * changed sync time takes effect on the next reschedule instead of requiring a
 * restart — which is what the old scheduler claimed to do but did not.
 */

const DAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/** Parses "HH:MM", falling back when absent or malformed. */
function parseTime(value, fallback = '09:00') {
  const fb = /^(\d{1,2}):(\d{2})$/.exec(fallback) || [null, '9', '00'];
  const m  = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  const src = m || fb;
  const hour   = Math.min(23, Number(src[1]));
  const minute = Math.min(59, Number(src[2]));
  return { hour, minute };
}

function dayNumber(dayName, fallback = 5) {
  return DAYS[String(dayName || '').toLowerCase()] ?? fallback;
}

/** Every day at the given time. */
function daily(time, fallback) {
  const { hour, minute } = parseTime(time, fallback);
  return `${minute} ${hour} * * *`;
}

/** On the given days (cron day-of-week field) at the given time. */
function onDays(time, fallback, days = '1-5') {
  const { hour, minute } = parseTime(time, fallback);
  return `${minute} ${hour} * * ${days}`;
}

/** Weekly, on a named day. */
function weekly(dayName, time, fallback) {
  const { hour, minute } = parseTime(time, fallback);
  return `${minute} ${hour} * * ${dayNumber(dayName)}`;
}

/**
 * Every N minutes within an hour range like "16-19", on the given days.
 * Falls back to the given range if the config value isn't a valid hour range.
 */
function everyNMinutesDuring(minutes, hourRange, fallbackRange, days = '1-5') {
  const range = /^\d{1,2}-\d{1,2}$/.test(String(hourRange || '')) ? hourRange : fallbackRange;
  return `*/${minutes} ${range} * * ${days}`;
}

module.exports = { parseTime, dayNumber, daily, onDays, weekly, everyNMinutesDuring };
