'use strict';

/**
 * Working-time arithmetic: how many working hours lie between two instants.
 *
 * A review SLA measured in wall-clock hours is wrong in a way that gets noticed
 * immediately — a pull request opened at 5pm on Friday would read as "overdue"
 * by Saturday morning, and a 24-hour SLA would flag every Friday afternoon PR
 * every single week. The clock only runs during working hours on working days,
 * in the team's timezone.
 *
 * There is no holiday calendar. A public holiday counts as a working day, which
 * errs toward flagging a little early rather than missing a wait.
 */

const { localParts, zonedToUtcMs } = require('./timeZone');

const DEFAULT_START_MINUTES = 9 * 60;
const DEFAULT_END_MINUTES   = 18 * 60;
const DEFAULT_WORKDAYS      = [1, 2, 3, 4, 5];
const DAY_MS = 86_400_000;

// A wait longer than this is far over any plausible SLA, so the walk stops.
const MAX_DAYS_WALKED = 800;

/** "HH:MM" → minutes past midnight, or null when malformed. */
function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Parses a cron-style day-of-week field ("1-5", "1,2,3,4,5", "1-6") into a set
 * of weekday numbers where 0 is Sunday. Falls back to Monday–Friday when the
 * input is empty or unusable, rather than treating every day as a rest day.
 */
function parseWorkdays(spec) {
  const days = new Set();
  for (const token of String(spec == null ? '' : spec).split(',')) {
    const t = token.trim();
    const range = /^(\d)-(\d)$/.exec(t);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) days.add(d % 7);
    } else if (/^\d$/.test(t)) {
      days.add(Number(t) % 7);
    }
  }
  return days.size > 0 ? days : new Set(DEFAULT_WORKDAYS);
}

/**
 * Working minutes between two instants.
 *
 * @param {Date|string|number} from
 * @param {Date|string|number} to
 * @param {object} [opts]
 * @param {string} [opts.timeZone='UTC']  IANA zone the working day is defined in.
 * @param {string} [opts.workStart='09:00']
 * @param {string} [opts.workEnd='18:00']
 * @param {string|Set<number>} [opts.workdays='1-5']  Cron day-of-week field, or a set (0 = Sunday).
 * @returns {number} 0 for an empty, reversed, or unparseable range.
 */
function workingMinutesBetween(from, to, opts = {}) {
  const start = new Date(from).getTime();
  const end   = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;

  const timeZone = opts.timeZone || 'UTC';
  let dayStart = toMinutes(opts.workStart ?? '09:00');
  let dayEnd   = toMinutes(opts.workEnd ?? '18:00');
  // A window that ends before it starts is a misconfiguration; falling back to a
  // sane day is safer than silently measuring every wait as zero.
  if (dayStart == null || dayEnd == null || dayEnd <= dayStart) {
    dayStart = DEFAULT_START_MINUTES;
    dayEnd   = DEFAULT_END_MINUTES;
  }
  const workdays = opts.workdays instanceof Set ? opts.workdays : parseWorkdays(opts.workdays);

  const first = localParts(new Date(start), timeZone);
  const last  = localParts(new Date(end), timeZone);
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  const stop = Date.UTC(last.year, last.month - 1, last.day);

  let totalMs = 0;
  for (let walked = 0; cursor <= stop && walked < MAX_DAYS_WALKED; walked++, cursor += DAY_MS) {
    const day = new Date(cursor);
    // The weekday is a property of the calendar date, so reading it from a UTC
    // midnight built from the local date is correct whatever the zone.
    if (!workdays.has(day.getUTCDay())) continue;

    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const windowStart = zonedToUtcMs(y, m, d, dayStart, timeZone);
    const windowEnd   = zonedToUtcMs(y, m, d, dayEnd, timeZone);

    const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart);
    if (overlap > 0) totalMs += overlap;
  }
  return totalMs / 60_000;
}

/** Working hours between two instants, to one decimal place. */
function workingHoursBetween(from, to, opts) {
  return Math.round((workingMinutesBetween(from, to, opts) / 60) * 10) / 10;
}

module.exports = {
  workingMinutesBetween,
  workingHoursBetween,
  parseWorkdays,
  toMinutes,
};
