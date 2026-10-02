'use strict';

/**
 * Wall-clock arithmetic in an IANA timezone — the one place it is done.
 *
 * The team works in its own zone (Asia/Kolkata by default) while the server and
 * the database may be in any other, so "what day is it", "is it working hours"
 * and "when does today start" all have to be asked in the team's zone. This used
 * to be answered by four separate hand-written copies, which had already started
 * to disagree: one treated the weekend as Saturday and Sunday whatever the team's
 * configured working days were.
 */

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws a RangeError for an unknown zone — a configuration error the caller
    // should see, not a value to guess around.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
      // h23, not hour12:false: the latter renders midnight as "24" in some engines.
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Calendar parts of an instant as read off a wall clock in `timeZone`:
 * { year, month, day, hour, minute, second, weekday } — month 1-12, weekday 0 = Sunday.
 */
function localParts(instant, timeZone = 'UTC') {
  const parts = {};
  for (const part of formatterFor(timeZone || 'UTC').formatToParts(new Date(instant))) {
    if (part.type === 'weekday') parts.weekday = WEEKDAYS[part.value];
    else if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

const pad = (n) => String(n).padStart(2, '0');

/** The calendar date, "YYYY-MM-DD", that an instant falls on in `timeZone`. */
function dateInZone(instant, timeZone) {
  const p = localParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Today's date in `timeZone`. For a team in Kolkata, UTC's date is wrong for the first 5½ hours of the day. */
function todayInZone(timeZone, now = new Date()) {
  return dateInZone(now, timeZone);
}

/** Minutes past local midnight, and the weekday, of an instant in `timeZone`. */
function localClock(instant, timeZone) {
  const p = localParts(instant, timeZone);
  return { minutes: p.hour * 60 + p.minute, weekday: p.weekday };
}

/**
 * The UTC epoch milliseconds at which the wall clock in `timeZone` reads the
 * given local date and minute of the day. Two correction passes settle the
 * offset in zones with daylight saving, so it is right on the day of a change as
 * well as either side of it.
 */
function zonedToUtcMs(year, month, day, minuteOfDay, timeZone) {
  const desired = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0);
  let guess = desired;
  for (let pass = 0; pass < 2; pass++) {
    const a = localParts(guess, timeZone);
    guess += desired - Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second);
  }
  return guess;
}

/**
 * The local calendar day containing `now`: its date and the [start, end) instants
 * of its midnights. `end` is the next midnight, so a 23-or-25-hour day across a
 * daylight-saving change is measured correctly.
 */
function dayWindow(now, timeZone) {
  const local = localParts(now, timeZone);
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return {
    date:  `${local.year}-${pad(local.month)}-${pad(local.day)}`,
    start: new Date(zonedToUtcMs(local.year, local.month, local.day, 0, timeZone)),
    end:   new Date(zonedToUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, timeZone)),
    timeZone,
  };
}

module.exports = { localParts, localClock, dateInZone, todayInZone, zonedToUtcMs, dayWindow };
