'use strict';

const deliveryRepo = require('../repositories/deliveryRepository');
const sprintRepo   = require('../repositories/sprintRepository');

/**
 * Delivery risk: will this sprint land, who is holding too much at once, and
 * what was added after it started.
 *
 * All three are things a lead notices late and a machine notices immediately.
 * None of them results in a message to an engineer — they are inputs to a
 * conversation or a scope decision, which is a human's job.
 *
 * The forecast deliberately refuses to answer early. Two days into a sprint the
 * sample is one or two data points, and a confident-looking projection built on
 * that is worse than no projection at all: it gets acted on.
 */

// Working days that must have elapsed before a throughput forecast means
// anything. Below this the honest answer is "too early".
const MIN_DAYS_FOR_FORECAST = 3;

// Started, unfinished items one person is holding before it is worth a word.
const DEFAULT_WIP_LIMIT = 3;

/**
 * Normalises anything date-shaped to UTC midnight, always as a new object.
 *
 * Both halves matter. Without the midnight normalisation a Date carrying a time
 * component fails the final `cursor <= end` comparison, so the forecast lost a
 * day when it ran in the afternoon and found it again at midnight. Without the
 * copy, the day counter mutated the caller's date.
 */
function toDate(value) {
  const d = value instanceof Date ? value : new Date(`${String(value).substring(0, 10)}T00:00:00.000Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Working days between two dates, inclusive of both ends. */
function workingDaysBetween(from, to) {
  const cursor = toDate(from);
  const end    = toDate(to);
  let count = 0;
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** YYYY-MM-DD, whether the input arrived as a Date or a string. */
function isoDate(value) {
  if (value == null) return null;
  return value instanceof Date
    ? toDate(value).toISOString().substring(0, 10)
    : String(value).substring(0, 10);
}

/**
 * Projects whether the open work will be finished by the sprint end, based on
 * how fast this team has actually closed things this sprint.
 *
 * @returns {{
 *   status: 'on-track'|'at-risk'|'too-early'|'no-data'|'stalled',
 *   summary: string,
 *   throughputPerDay?: number, daysElapsed?: number, daysLeft?: number,
 *   open?: number, done?: number, projectedShortfall?: number
 * }}
 */
function forecast({ open, done, unassigned, completionsByDay, startDate, endDate, today = new Date() }) {
  const total = open + done;
  if (total === 0) {
    return { status: 'no-data', summary: 'No tasks are recorded against this sprint yet.' };
  }

  const daysElapsed = workingDaysBetween(startDate, today);
  const daysLeft    = Math.max(0, workingDaysBetween(today, endDate) - 1); // exclude today

  if (daysElapsed < MIN_DAYS_FOR_FORECAST) {
    return {
      status: 'too-early',
      summary: `Too early to forecast — ${daysElapsed} working ${daysElapsed === 1 ? 'day' : 'days'} in. Ask again after day ${MIN_DAYS_FOR_FORECAST}.`,
      open, done, daysElapsed, daysLeft,
    };
  }

  const finished = completionsByDay.reduce((sum, d) => sum + d.finished, 0);
  const throughput = finished / daysElapsed;

  if (throughput === 0) {
    return {
      status: 'stalled',
      summary: `Nothing has been closed in ${daysElapsed} working days. All ${open} open ${open === 1 ? 'task is' : 'tasks are'} still open.`,
      open, done, daysElapsed, daysLeft, throughputPerDay: 0,
    };
  }

  const capacity = throughput * daysLeft;
  const shortfall = Math.max(0, Math.ceil(open - capacity));

  const base = {
    open, done, daysElapsed, daysLeft,
    throughputPerDay: round1(throughput),
    projectedShortfall: shortfall,
  };

  if (shortfall === 0) {
    return {
      ...base,
      status: 'on-track',
      summary: `On track — closing ${round1(throughput)} a day, ${open} open, ${daysLeft} working ${daysLeft === 1 ? 'day' : 'days'} left.`,
    };
  }

  const unassignedNote = unassigned > 0
    ? ` ${unassigned} of the open ${unassigned === 1 ? 'task has' : 'tasks have'} no assignee.`
    : '';

  return {
    ...base,
    status: 'at-risk',
    summary: `At this rate ${shortfall} ${shortfall === 1 ? 'task' : 'tasks'} will not land — closing ${round1(throughput)} a day, ${open} open, ${daysLeft} working ${daysLeft === 1 ? 'day' : 'days'} left.${unassignedNote}`,
  };
}

/** People holding more started work than the limit allows. */
function wipBreaches(rows, limit = DEFAULT_WIP_LIMIT) {
  return rows
    .filter((r) => r.in_flight > limit)
    .map((r) => ({
      name:     r.name,
      inFlight: r.in_flight,
      over:     r.in_flight - limit,
      keys:     (r.keys || []).filter(Boolean).slice(0, 6),
    }));
}

/**
 * Everything at once, for a given organisation and its active sprint.
 * Returns null when there is no sprint to assess.
 */
async function assess(organisationId, { wipLimit = DEFAULT_WIP_LIMIT } = {}) {
  const sprint = await sprintRepo.getActiveSprint(organisationId);
  if (!sprint) return null;

  const [counts, byDay, perMember, added] = await Promise.all([
    deliveryRepo.openAndDone(organisationId, sprint.id),
    deliveryRepo.completionsByDay(organisationId, sprint.id),
    deliveryRepo.openWorkPerMember(organisationId, sprint.id),
    deliveryRepo.addedAfterStart(organisationId, sprint.id, sprint.start_date),
  ]);

  const projection = forecast({
    open:  counts.open,
    done:  counts.done,
    unassigned: counts.unassigned,
    completionsByDay: byDay,
    startDate: sprint.start_date,
    endDate:   sprint.end_date,
  });

  const scopeAdded = added.map((t) => ({
    key:      t.jira_key,
    title:    t.title,
    assignee: t.assignee,
    // pg returns DATE columns as Date objects, whose default stringification is
    // "Sun Sep 13 2026 …" — slicing that gives a weekday, not a date.
    addedOn:  isoDate(t.created_at_jira),
    done:     Boolean(t.completed_at),
  }));

  return {
    sprint:     { id: sprint.id, name: sprint.name, startDate: isoDate(sprint.start_date), endDate: isoDate(sprint.end_date) },
    forecast:   projection,
    wip:        wipBreaches(perMember, wipLimit),
    wipLimit,
    scopeAdded,
    // Proportion of the sprint that arrived after it started. Shown only when
    // there is enough work for the number to mean anything.
    scopeAddedShare: (counts.open + counts.done) >= 5
      ? Math.round((scopeAdded.length / (counts.open + counts.done)) * 100)
      : null,
  };
}

module.exports = {
  assess, forecast, wipBreaches, workingDaysBetween,
  MIN_DAYS_FOR_FORECAST, DEFAULT_WIP_LIMIT,
};
