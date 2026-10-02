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

/**
 * The calendar date, as "YYYY-MM-DD", that an instant falls on in an IANA zone.
 *
 * An issue created at 01:00 on the 14th in Kolkata is still the 13th in UTC, so
 * "which day was this" has to be asked in the team's zone, not read off the ISO
 * string.
 */
function dateInZone(instant, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Today's calendar date in an IANA zone: "today" for a team in Kolkata is not UTC's today for the first 5½ hours of their day. */
function todayInZone(timeZone, now = new Date()) {
  return dateInZone(now, timeZone);
}

module.exports = { dateOnlyString, dateOnlyToUtc, dateInZone, todayInZone };
