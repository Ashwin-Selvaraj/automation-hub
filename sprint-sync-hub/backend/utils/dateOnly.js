'use strict';

/**
 * Reading calendar dates correctly, whatever timezone the server runs in.
 *
 * node-postgres returns a DATE column as a JS Date built at LOCAL midnight
 * (`new Date(year, month, day)`). Reading it back with UTC components — the
 * natural `toISOString().substring(0, 10)` — therefore gives the PREVIOUS day on
 * any server east of UTC (Asia/Kolkata, Europe, Australia...) and the right day
 * only on a UTC server. That bug passes in a UTC CI and on a UTC host and is
 * wrong exactly where the team is.
 *
 * A DATE is a calendar day with no time, so it is read back with local
 * components, which is how the driver constructed it.
 */

const pad = (n) => String(n).padStart(2, '0');

/**
 * "YYYY-MM-DD" for a DATE column value, or for a string that starts with one.
 * Returns null for null, undefined, an invalid Date, or an unparseable string.
 */
function dateOnlyString(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

/** UTC midnight of a DATE value, so day arithmetic is exact in any zone. */
function dateOnlyToUtc(value) {
  const s = dateOnlyString(value);
  return s ? new Date(`${s}T00:00:00.000Z`) : null;
}

// Re-exported so existing callers keep importing dates from one place; the
// zone arithmetic itself lives in utils/timeZone.
const { dateInZone, todayInZone } = require('./timeZone');

// ─── Calendar arithmetic on YYYY-MM-DD strings ───────────────────────────────
//
// Done in UTC on date strings, so the answer is the same on a server in any
// timezone. Date#setDate / getDay work in the *server's* zone and, around a
// daylight-saving change or on a machine not in the team's zone, step to the
// wrong day.

const { parseWorkdays } = require('./workingTime');

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().substring(0, 10);
}

/** Whole calendar days from `from` to `to`; negative if `to` is earlier. */
function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00.000Z`) - new Date(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/** Weekday of a calendar date, 0 = Sunday. */
function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
}

/**
 * Every working date from `start` to `end` inclusive, as YYYY-MM-DD. `workdays`
 * is the team's cron-style day-of-week field (default Monday-Friday), so a team
 * that works Saturdays is not told Saturday is a weekend.
 */
function workingDatesBetween(start, end, workdays = '1-5') {
  const days = workdays instanceof Set ? workdays : parseWorkdays(workdays);
  const out = [];
  const stop = dateOnlyString(end);
  for (let d = dateOnlyString(start); d && stop && d <= stop; d = addDays(d, 1)) {
    if (days.has(weekdayOf(d))) out.push(d);
  }
  return out;
}

module.exports = {
  dateOnlyString, dateOnlyToUtc, dateInZone, todayInZone,
  addDays, daysBetween, weekdayOf, workingDatesBetween,
};
