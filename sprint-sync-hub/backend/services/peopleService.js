'use strict';

const peopleRepo       = require('../repositories/peopleRepository');
const memberRepo       = require('../repositories/memberRepository');
const memberRoleRepo   = require('../repositories/memberRoleRepository');
const githubService    = require('./githubService');
const prReviewService  = require('./prReviewService');
const configService    = require('./configService');
const slackText        = require('../utils/slackText');
const { dateOnlyString, dateInZone, todayInZone } = require('../utils/dateOnly');

/**
 * The people side of a lead's week: preparing for 1:1s, noticing work worth
 * acknowledging, and assembling the record for a performance review.
 *
 * Ground rules, because this is the part of the system that could most easily
 * turn into surveillance:
 *
 *  - Everything here goes to the lead and only the lead. Nothing is posted to a
 *    channel or sent to the person it is about.
 *  - It reports facts with their source (a Jira key, a pull request, a dated
 *    standup line), never a score, a rating, or a comparison between people.
 *  - No model writes anything about a person. A sentence like "Alice seems
 *    disengaged" from a model, sitting in a lead's DMs, is exactly the kind of
 *    thing that should never exist. The topics below are fixed rules that turn a
 *    fact into a question for the lead to ask.
 *  - It does not count standups posted, hours online, or anything else that
 *    measures presence rather than work.
 *  - It says what it cannot see, so an empty section is not read as "did nothing".
 */

const STUCK_DAYS        = 5;   // an in-progress task with no movement for this long
const LONG_OPEN_DAYS    = 14;  // a task open this long is worth noticing when it lands
const REVIEW_LOAD       = 4;   // this many review requests on one person is worth a question
const REVIEWS_NOTEWORTHY = 3;  // reviews for teammates in a week worth acknowledging
const MAX_WINDOW_DAYS   = 400;
const MAX_REVIEW_FETCHES = 120; // per GitHub activity read, across all repositories
const GITHUB_CONCURRENCY = 4;

const CADENCE_MIN_GAP = { weekly: 0, fortnightly: 10, monthly: 24 };
const NOT_STARTED = new Set(['to do', 'todo', 'backlog', 'open', 'new', 'selected for development']);

// ─── Dates ────────────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().substring(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00.000Z`) - new Date(`${from}T00:00:00.000Z`)) / 86_400_000);
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
}

function isDateStr(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** Validates a from/to pair. Throws an error with code BAD_WINDOW. */
function checkWindow(from, to) {
  const bad = (message) => Object.assign(new Error(message), { code: 'BAD_WINDOW' });
  if (!isDateStr(from) || !isDateStr(to)) throw bad('from and to must be YYYY-MM-DD dates');
  if (from > to) throw bad('from must not be after to');
  if (daysBetween(from, to) > MAX_WINDOW_DAYS) throw bad(`A window can be at most ${MAX_WINDOW_DAYS} days`);
}

function teamZone() {
  return configService.getSprintConfig().timezone || 'UTC';
}

// ─── 1:1 schedule ─────────────────────────────────────────────────────────────

/**
 * Whether a person's 1:1 prep should go out on `today`. Fortnightly and monthly
 * count from the last 1:1 the lead recorded, so a skipped or moved 1:1 does not
 * push the next one a whole cycle away, and recording one is what resets it.
 */
function isOneOnOneDue(member, today) {
  if (member.one_on_one_weekday == null) return false;
  if (Number(member.one_on_one_weekday) !== weekdayOf(today)) return false;

  const last = dateOnlyString(member.last_held_on);
  if (last && last >= today) return false; // already held (or recorded ahead) today
  const gap = CADENCE_MIN_GAP[member.one_on_one_cadence] ?? 0;
  return !last || daysBetween(last, today) >= gap;
}

// ─── Standup mentions ─────────────────────────────────────────────────────────

const WAITING_RE = /\b(blocked|blocker|blocking|waiting (?:on|for)|stuck|depends? on|depending on|need(?:s|ed)? (?:help|access|a review|review|input)|can'?t (?:proceed|continue|start)|unable to)\b/i;

/**
 * Standup lines where the person said they were waiting on something. These are
 * their own words, quoted, so the lead can ask whether it got resolved — not an
 * interpretation of them.
 */
function waitingMentions(standups, limit = 4) {
  const out = [];
  for (const s of standups) {
    const text = String(s.message_text || '');
    const sentence = text
      .split(/(?<=[.!?])\s+|\n+/)
      .find((part) => WAITING_RE.test(part));
    if (!sentence) continue;
    out.push({ date: dateOnlyString(s.post_date), text: slackText.truncate(sentence.trim(), 160) });
    if (out.length >= limit) break;
  }
  return out;
}

// ─── GitHub activity ──────────────────────────────────────────────────────────

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

const isBot = (user) => !user || user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');
const lower = (s) => String(s || '').toLowerCase();

/**
 * Who authored and who reviewed pull requests merged in a window, keyed by
 * lowercase login. Pure, so the counting rules can be tested: an author's own
 * comments on their PR are not a review, bots are not people, and one person
 * reviewing the same PR three times reviewed it once.
 */
function activityByLogin(merged, reviewsByKey) {
  const byLogin = new Map();
  const slot = (login) => {
    const key = lower(login);
    if (!byLogin.has(key)) byLogin.set(key, { authored: [], reviewed: [] });
    return byLogin.get(key);
  };

  for (const pr of merged) {
    const ref = { repo: pr.repo, number: pr.number, title: pr.title, url: pr.html_url, mergedAt: pr.merged_at, author: pr.user?.login || null };
    if (!isBot(pr.user)) slot(pr.user.login).authored.push(ref);

    const reviewers = new Set();
    for (const review of reviewsByKey.get(`${pr.repo}#${pr.number}`) || []) {
      if (isBot(review.user) || review.state === 'PENDING') continue;
      if (lower(review.user.login) === lower(pr.user?.login)) continue;
      reviewers.add(lower(review.user.login));
    }
    for (const login of reviewers) slot(login).reviewed.push(ref);
  }
  return byLogin;
}

/**
 * Reads merged pull requests and their reviews for a window, within a time
 * budget. Returns { configured, byLogin, errors, truncated, timedOut }.
 */
async function githubActivity({ from, to, timeZone, budgetMs = 20_000 }) {
  if (!githubService.isConfigured()) return { configured: false, byLogin: new Map(), errors: [] };

  const errors = [];
  let truncated = false;

  const work = (async () => {
    const merged = [];
    // A day of slack on the lower bound: `from` is a local date and the API
    // compares instants.
    const since = `${addDays(from, -1)}T00:00:00Z`;

    await Promise.all(githubService.getRepos().map(async (repo) => {
      try {
        const pulls = await githubService.listClosedPullRequestsSince(repo, since);
        for (const pr of pulls) {
          if (!pr.merged_at) continue;
          const day = dateInZone(new Date(pr.merged_at), timeZone);
          if (day >= from && day <= to) merged.push({ ...pr, repo });
        }
      } catch (err) {
        errors.push({ repo, error: err.message, code: err.code });
      }
    }));

    merged.sort((a, b) => a.merged_at.localeCompare(b.merged_at));
    const toFetch = merged.slice(-MAX_REVIEW_FETCHES);
    if (toFetch.length < merged.length) truncated = true;

    const reviewsByKey = new Map();
    await mapLimit(toFetch, GITHUB_CONCURRENCY, async (pr) => {
      try {
        reviewsByKey.set(`${pr.repo}#${pr.number}`, await githubService.listReviews(pr.repo, pr.number));
      } catch (err) {
        errors.push({ repo: pr.repo, error: err.message, code: err.code });
      }
    });
    return activityByLogin(merged, reviewsByKey);
  })();
  work.catch(() => {});

  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
  try {
    const byLogin = await Promise.race([work, budget]);
    if (byLogin === null) return { configured: true, timedOut: true, byLogin: new Map(), errors };
    return { configured: true, byLogin, errors, truncated };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 1:1 prep ─────────────────────────────────────────────────────────────────

function classifyOpen(open, today, timeZone = 'UTC') {
  const overdue = [];
  const stuck = [];
  const inFlight = [];
  for (const t of open) {
    const due = dateOnlyString(t.due_date);
    const moved = t.last_movement ? dateInZone(new Date(t.last_movement), timeZone) : null;
    const idle = moved ? daysBetween(moved, today) : null;
    const started = !NOT_STARTED.has(lower(t.status));
    const item = { key: t.jira_key, title: t.title, status: t.status, dueDate: due, idleDays: idle };

    if (due && due < today) overdue.push({ ...item, daysLate: daysBetween(due, today) });
    else if (started && idle != null && idle >= STUCK_DAYS) stuck.push(item);
    if (started) inFlight.push(item);
  }
  return { overdue, stuck, inFlight };
}

/**
 * Turns facts into questions for the lead. Fixed rules, no model: each topic
 * names the fact it came from so the lead can check it.
 */
function suggestTopics({ stuck = [], overdue = [], mentions = [], theirPrs = [], reviewsOwed = [], shipped = [] }) {
  const topics = [];

  for (const t of stuck.slice(0, 2)) {
    topics.push(`${t.key} has not moved in ${t.idleDays} days — is anything in the way, or has it been parked?`);
  }
  if (overdue.length > 0) {
    const keys = overdue.slice(0, 3).map((t) => t.key).join(', ');
    topics.push(`${overdue.length === 1 ? `${keys} is` : `${overdue.length} tasks (${keys}) are`} past due — do the dates still reflect the plan?`);
  }
  if (mentions.length > 0) {
    topics.push(`They mentioned waiting on something on ${mentions[0].date} — did it get resolved?`);
  }
  const blockedPrs = theirPrs.filter((p) => p.overSla);
  if (blockedPrs.length > 0) {
    const p = blockedPrs[0];
    topics.push(`Their PR #${p.number} has waited ${Math.round(p.waitingHours)} working hours for review — something you could unblock.`);
  }
  if (reviewsOwed.length >= REVIEW_LOAD) {
    topics.push(`${reviewsOwed.length} review requests are waiting on them — is their review load reasonable?`);
  }
  const landedLong = shipped.find((t) => t.openDays != null && t.openDays >= LONG_OPEN_DAYS);
  if (landedLong) {
    topics.push(`They closed ${landedLong.key}, open for ${landedLong.openDays} days — worth acknowledging.`);
  }
  if (topics.length === 0) {
    topics.push('Nothing in the data stands out — a good 1:1 to spend on them rather than on the work.');
  }
  return topics;
}

function openDaysOf(task) {
  const created = dateOnlyString(task.created_at_jira);
  const done = dateOnlyString(task.completed_on);
  return created && done ? daysBetween(created, done) : null;
}

async function oneOnOnePrep(organisationId, memberId, { today = todayInZone(teamZone()), reviewBudgetMs = 4000 } = {}) {
  const member = await memberRepo.findById(memberId);
  if (!member || Number(member.organisation_id) !== Number(organisationId)) return null;

  const timeZone = teamZone();
  const [last] = await peopleRepo.recentOneOnOnes(organisationId, memberId, 1);
  const lastHeldOn = last ? dateOnlyString(last.held_on) : null;
  // Since the last 1:1, or the last two weeks if there is no record of one. A 1:1
  // recorded today means the next one starts from today, so the pack then shows
  // only what has happened since — not the fortnight that was just discussed.
  const from = lastHeldOn && lastHeldOn <= today ? lastHeldOn : addDays(today, -14);

  const [completed, open, standups, actions, reviews] = await Promise.all([
    peopleRepo.completedBetween(organisationId, { from, to: today, timeZone, memberId }),
    peopleRepo.openFor(organisationId, memberId),
    peopleRepo.standupsBetween(organisationId, { from, to: today, memberId }),
    peopleRepo.actionsFor(organisationId, memberId, { closedSince: last?.created_at || null }),
    prReviewService.assessWithin(organisationId, { budgetMs: reviewBudgetMs }).catch(() => null),
  ]);

  const shipped = completed.map((t) => ({ key: t.jira_key, title: t.title, type: t.issue_type, openDays: openDaysOf(t) }));
  const { overdue, stuck, inFlight } = classifyOpen(open, today, timeZone);
  const mentions = waitingMentions(standups);

  const login = lower(member.github_login);
  const reviewsUsable = reviews && reviews.configured && !reviews.pending;
  const reviewsOwed = reviewsUsable
    ? reviews.waiting.filter((w) => w.member && Number(w.member.id) === Number(memberId))
    : [];
  const theirPrs = reviewsUsable && login
    ? [...reviews.waiting, ...reviews.unassigned].filter((w) => lower(w.author) === login)
    : [];
  // One PR waiting on two reviewers is still one PR.
  const theirPrsUnique = [...new Map(theirPrs.map((p) => [`${p.repo}#${p.number}`, p])).values()];

  const openActions = actions.filter((a) => !a.done_at);
  const closedActions = actions.filter((a) => a.done_at);

  return {
    member: { id: member.id, name: member.name, githubLinked: Boolean(member.github_login) },
    today,
    since: from,
    lastHeldOn,
    lastNotes: last?.notes || null,
    actions: { open: openActions, closedSinceLast: closedActions },
    shipped,
    inFlight,
    overdue,
    stuck,
    mentions,
    reviewsOwed: reviewsOwed.map((w) => ({ repo: w.repo, number: w.number, title: w.title, url: w.url, waitingHours: w.waitingHours })),
    theirPrs: theirPrsUnique.map((w) => ({ repo: w.repo, number: w.number, title: w.title, url: w.url, waitingHours: w.waitingHours, overSla: w.overSla })),
    github: reviews ? (reviewsUsable ? 'ok' : reviews.configured === false ? 'not-configured' : 'pending') : 'unavailable',
    topics: suggestTopics({ stuck, overdue, mentions, theirPrs: theirPrsUnique, reviewsOwed, shipped }),
  };
}

function jiraLink(key, title, max = 60) {
  const base = String(process.env.JIRA_SITE_URL || '').replace(/\/+$/, '');
  return slackText.link(base ? `${base}/browse/${key}` : '', `${key} ${title || ''}`.trim(), { max });
}

/** The prep pack as a Slack DM to the lead. */
function renderPrep(prep) {
  const first = slackText.escape(String(prep.member.name).split(/\s+/)[0]);
  const lines = [];
  lines.push(`*1:1 prep — ${slackText.escape(prep.member.name)}*`);
  lines.push(prep.lastHeldOn
    ? `_Since your last recorded 1:1 on ${prep.lastHeldOn}._`
    : `_No earlier 1:1 recorded, so this covers the last two weeks._`);

  const leadOwed = prep.actions.open.filter((a) => a.owner === 'lead');
  const memberOwed = prep.actions.open.filter((a) => a.owner === 'member');
  if (leadOwed.length || memberOwed.length) {
    lines.push('', '*Open follow-ups*');
    for (const a of leadOwed) lines.push(`• You: ${slackText.escape(slackText.truncate(a.text, 140))}`);
    for (const a of memberOwed) lines.push(`• ${first}: ${slackText.escape(slackText.truncate(a.text, 140))}`);
  }

  lines.push('', '*Worth asking about*');
  for (const t of prep.topics) lines.push(`• ${slackText.escape(t)}`);

  if (prep.shipped.length) {
    lines.push('', `*Closed since then* (${prep.shipped.length})`);
    for (const t of prep.shipped.slice(0, 8)) lines.push(`• ${jiraLink(t.key, t.title)}`);
    if (prep.shipped.length > 8) lines.push(`_…and ${prep.shipped.length - 8} more_`);
  }

  if (prep.inFlight.length) {
    lines.push('', `*In progress now* (${prep.inFlight.length})`);
    for (const t of prep.inFlight.slice(0, 6)) {
      const idle = t.idleDays != null && t.idleDays >= STUCK_DAYS ? ` — no movement in ${t.idleDays} days` : '';
      lines.push(`• ${jiraLink(t.key, t.title)} (${slackText.escape(t.status)})${idle}`);
    }
  }

  if (prep.mentions.length) {
    lines.push('', '*In their own words*');
    for (const m of prep.mentions) lines.push(`• ${m.date}: “${slackText.escape(m.text)}”`);
  }

  if (prep.theirPrs.length || prep.reviewsOwed.length) {
    lines.push('', '*Code review*');
    for (const p of prep.theirPrs.slice(0, 4)) {
      lines.push(`• Their ${slackText.link(p.url, `#${p.number} ${p.title}`, { max: 60 })} is waiting for review (${Math.round(p.waitingHours)}h)`);
    }
    if (prep.reviewsOwed.length) lines.push(`• ${prep.reviewsOwed.length} review request${prep.reviewsOwed.length === 1 ? '' : 's'} waiting on them`);
  }

  lines.push('', '_What the tools can see. The 1:1 is for what they can’t._');
  return lines.join('\n');
}

// ─── Recognition ──────────────────────────────────────────────────────────────

/**
 * Specific things worth a thank-you, per person. Pure, so the rules — and the
 * rule that it is never a ranking — can be tested.
 *
 * People are listed alphabetically and nobody's count is compared with anyone
 * else's. A plain "closed N tasks" only appears when there is nothing more
 * specific to say, because a list of counts is a leaderboard by another name.
 */
function buildRecognition({ completed, members, github }) {
  const byMember = new Map(members.map((m) => [m.id, { member: m, items: [] }]));
  const tasksBy = new Map();
  for (const t of completed) {
    if (!byMember.has(t.assignee_id)) continue;
    if (!tasksBy.has(t.assignee_id)) tasksBy.set(t.assignee_id, []);
    tasksBy.get(t.assignee_id).push(t);
  }

  for (const [id, entry] of byMember) {
    const tasks = tasksBy.get(id) || [];
    const specific = [];

    for (const t of tasks) {
      const openDays = openDaysOf(t);
      if (openDays != null && openDays >= LONG_OPEN_DAYS) {
        specific.push({ kind: 'long-running', key: t.jira_key, title: t.title, text: `closed ${t.jira_key}, which had been open for ${openDays} days` });
      }
    }

    for (const t of tasks) {
      const due = dateOnlyString(t.due_date);
      const done = dateOnlyString(t.completed_on);
      if (due && done && done < due && daysBetween(done, due) >= 2) {
        specific.push({ kind: 'early', key: t.jira_key, title: t.title, text: `finished ${t.jira_key} ${daysBetween(done, due)} days ahead of its due date` });
      }
    }

    const bugs = tasks.filter((t) => lower(t.issue_type) === 'bug');
    if (bugs.length > 0) {
      specific.push({
        kind: 'bugs', keys: bugs.map((b) => b.jira_key),
        text: `fixed ${bugs.length === 1 ? 'a bug' : `${bugs.length} bugs`} (${bugs.slice(0, 4).map((b) => b.jira_key).join(', ')}${bugs.length > 4 ? ', …' : ''})`,
      });
    }

    const gh = entry.member.github_login && github?.byLogin?.get(lower(entry.member.github_login));
    if (gh && gh.reviewed.length >= REVIEWS_NOTEWORTHY) {
      specific.push({
        kind: 'reviews', count: gh.reviewed.length,
        text: `reviewed ${gh.reviewed.length} teammates' pull requests that were merged`,
      });
    }

    if (specific.length === 0 && tasks.length > 0) {
      specific.push({
        kind: 'closed', keys: tasks.map((t) => t.jira_key),
        text: `closed ${tasks.slice(0, 4).map((t) => t.jira_key).join(', ')}${tasks.length > 4 ? ` and ${tasks.length - 4} more` : ''}`,
      });
    }
    entry.items = specific;
  }

  return [...byMember.values()]
    .filter((e) => e.items.length > 0)
    .sort((a, b) => a.member.name.localeCompare(b.member.name))
    .map((e) => ({ memberId: e.member.id, name: e.member.name, items: e.items }));
}

async function recognition(organisationId, { from, to, githubBudgetMs = 20_000 } = {}) {
  const timeZone = teamZone();
  const today = todayInZone(timeZone);
  to = to || today;
  from = from || addDays(to, -6);
  checkWindow(from, to);

  const [completed, allMembers, managerial, github] = await Promise.all([
    peopleRepo.completedBetween(organisationId, { from, to, timeZone }),
    memberRepo.findAll(organisationId),
    memberRoleRepo.getManagerialMemberKeys(organisationId).catch(() => ({ memberIds: new Set() })),
    githubActivity({ from, to, timeZone, budgetMs: githubBudgetMs }),
  ]);
  const members = allMembers.filter((m) => !managerial.memberIds.has(m.id));

  return {
    from, to,
    people: buildRecognition({ completed, members, github }),
    github: github.configured ? (github.timedOut ? 'timed-out' : 'ok') : 'not-configured',
    githubErrors: github.errors,
  };
}

function renderRecognition(rec) {
  const lines = [`*Worth recognising — ${rec.from} to ${rec.to}*`];
  if (rec.people.length === 0) {
    lines.push('', 'Nothing specific in Jira or GitHub this week.');
  } else {
    for (const p of rec.people) {
      lines.push('', `*${slackText.escape(p.name)}*`);
      for (const item of p.items) lines.push(`• ${slackText.escape(item.text)}`);
    }
  }
  lines.push(
    '',
    '_Suggestions for you to acknowledge in your own words — nothing has been posted. People not listed may well have done work these tools can’t see: support, mentoring, design, unblocking others._'
  );
  return lines.join('\n');
}

// ─── Review evidence ──────────────────────────────────────────────────────────

/** How tasks due in a window turned out, against each task's current due date. */
function summariseDeadlines(rows, today) {
  const out = { onTime: [], late: [], open: [], notYetDue: [] };
  for (const r of rows) {
    const due = dateOnlyString(r.due_date);
    const done = dateOnlyString(r.completed_on);
    const item = { key: r.jira_key, title: r.title, dueDate: due };
    if (done) {
      if (done <= due) out.onTime.push({ ...item, completedOn: done });
      else out.late.push({ ...item, completedOn: done, daysLate: daysBetween(due, done) });
    } else if (due < today) {
      out.open.push({ ...item, daysLate: daysBetween(due, today) });
    } else {
      out.notYetDue.push(item);
    }
  }
  return out;
}

async function evidencePack(organisationId, memberId, { from, to, githubBudgetMs = 30_000 } = {}) {
  checkWindow(from, to);
  const member = await memberRepo.findById(memberId);
  if (!member || Number(member.organisation_id) !== Number(organisationId)) return null;

  const timeZone = teamZone();
  const today = todayInZone(timeZone);

  const [completed, due, oneOnOnes, github] = await Promise.all([
    peopleRepo.completedBetween(organisationId, { from, to, timeZone, memberId }),
    peopleRepo.dueBetween(organisationId, { from, to, timeZone, memberId }),
    peopleRepo.recentOneOnOnes(organisationId, memberId, 500),
    member.github_login
      ? githubActivity({ from, to, timeZone, budgetMs: githubBudgetMs })
      : Promise.resolve({ configured: githubService.isConfigured(), byLogin: new Map(), errors: [], unlinked: true }),
  ]);

  const bySprint = new Map();
  const byType = {};
  for (const t of completed) {
    const sprint = t.sprint_name || 'No sprint';
    if (!bySprint.has(sprint)) bySprint.set(sprint, []);
    bySprint.get(sprint).push({
      key: t.jira_key, title: t.title, type: t.issue_type || null,
      completedOn: dateOnlyString(t.completed_on), openDays: openDaysOf(t),
    });
    const type = t.issue_type || 'Unspecified';
    byType[type] = (byType[type] || 0) + 1;
  }

  const gh = github.byLogin.get(lower(member.github_login)) || { authored: [], reviewed: [] };
  const heldInWindow = oneOnOnes.filter((o) => {
    const d = dateOnlyString(o.held_on);
    return d >= from && d <= to;
  });

  const limits = [
    'Due dates are compared with each task’s current due date in Jira. A date that was moved is not recorded as missed, and the history of moves is not kept.',
    'Work outside Jira and GitHub is not here: design, mentoring, interviewing, incidents, support, documentation, helping teammates.',
    'Task counts say nothing about size or difficulty. Read the list, not the number.',
  ];
  if (!github.configured) limits.push('GitHub is not connected, so pull requests and reviews are not included.');
  else if (github.unlinked) limits.push(`${member.name} has no GitHub username linked on the Team tab, so pull requests and reviews are not included.`);
  else if (github.timedOut) limits.push('GitHub took too long to answer, so pull requests and reviews are missing. Try again.');
  else if (github.truncated) limits.push('There were more merged pull requests than could be read in one go; reviews on the oldest are not counted.');
  if (github.errors?.length) limits.push(`Some repositories could not be read: ${[...new Set(github.errors.map((e) => e.repo))].join(', ')}.`);

  return {
    member: { id: member.id, name: member.name, githubLogin: member.github_login || null },
    from, to,
    generatedOn: today,
    completed: { total: completed.length, byType, bySprint: [...bySprint].map(([sprint, tasks]) => ({ sprint, tasks })) },
    deadlines: summariseDeadlines(due, today),
    github: { authored: gh.authored, reviewed: gh.reviewed },
    oneOnOnes: { held: heldInWindow.length },
    limits,
  };
}

/** The evidence pack as Markdown, for pasting into a review document. */
function renderEvidenceMarkdown(pack) {
  const md = [];
  const esc = (s) => String(s ?? '').replace(/([\\`*_[\]|<>])/g, '\\$1');
  md.push(`# Review evidence — ${esc(pack.member.name)}`);
  md.push('', `${pack.from} to ${pack.to}. Generated ${pack.generatedOn} from Jira${pack.member.githubLogin ? ' and GitHub' : ''}. Facts only — the judgement is yours.`);

  md.push('', `## Work completed (${pack.completed.total})`);
  const types = Object.entries(pack.completed.byType).map(([t, n]) => `${esc(t)}: ${n}`).join(' · ');
  if (types) md.push('', types);
  for (const { sprint, tasks } of pack.completed.bySprint) {
    md.push('', `### ${esc(sprint)}`);
    for (const t of tasks) {
      const extra = [t.type, t.openDays != null && t.openDays >= LONG_OPEN_DAYS ? `open ${t.openDays} days` : null].filter(Boolean).join(', ');
      md.push(`- **${esc(t.key)}** ${esc(t.title)} — closed ${t.completedOn}${extra ? ` (${esc(extra)})` : ''}`);
    }
  }

  const d = pack.deadlines;
  md.push('', '## Due dates in this period');
  md.push('', `On time: ${d.onTime.length} · Late: ${d.late.length} · Still open past due: ${d.open.length} · Not yet due: ${d.notYetDue.length}`);
  for (const t of d.late) md.push(`- ${esc(t.key)} ${esc(t.title)} — due ${t.dueDate}, closed ${t.completedOn} (${t.daysLate} day${t.daysLate === 1 ? '' : 's'} later)`);
  for (const t of d.open) md.push(`- ${esc(t.key)} ${esc(t.title)} — due ${t.dueDate}, still open`);

  if (pack.member.githubLogin) {
    md.push('', `## Pull requests merged (${pack.github.authored.length})`);
    for (const p of pack.github.authored) md.push(`- [${esc(p.repo)}#${p.number}](${p.url}) ${esc(p.title)}`);
    md.push('', `## Reviews given on teammates' merged pull requests (${pack.github.reviewed.length})`);
    for (const p of pack.github.reviewed) md.push(`- [${esc(p.repo)}#${p.number}](${p.url}) ${esc(p.title)}${p.author ? ` — by ${esc(p.author)}` : ''}`);
  }

  md.push('', '## 1:1s', '', `${pack.oneOnOnes.held} recorded in this period. Notes are not included here.`);

  md.push('', '## What this does not show');
  for (const l of pack.limits) md.push(`- ${l}`);
  return md.join('\n') + '\n';
}

module.exports = {
  oneOnOnePrep, renderPrep,
  recognition, renderRecognition, buildRecognition,
  evidencePack, renderEvidenceMarkdown, summariseDeadlines,
  isOneOnOneDue, waitingMentions, suggestTopics, classifyOpen, activityByLogin, githubActivity,
  checkWindow, addDays,
  STUCK_DAYS, LONG_OPEN_DAYS,
};
