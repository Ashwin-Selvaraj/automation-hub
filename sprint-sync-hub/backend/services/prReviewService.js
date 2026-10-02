'use strict';

const githubService = require('./githubService');
const configService = require('./configService');
const memberRepo    = require('../repositories/memberRepository');
const { workingHoursBetween, toMinutes } = require('../utils/workingTime');

/**
 * Who is a pull request waiting on, and for how long?
 *
 * A pull request that sits unreviewed is the most common thing blocking an
 * engineer that nobody sees, because the person blocked has no good way to say
 * so without feeling like they are nagging a colleague. A lead who sees "waiting
 * 31 working hours on Bob" can fix it in one sentence.
 *
 * Three decisions here are worth stating, because each was checked against the
 * real GitHub API rather than assumed:
 *
 *  - WHO owes a review is the pull request's CURRENT list of requested
 *    reviewers. GitHub removes a reviewer from that list when they submit a
 *    review and puts them back when the author re-requests, so the list already
 *    encodes "the ball is in this person's court" — including the case where
 *    changes were requested and it is the author's turn.
 *
 *  - SINCE WHEN is per reviewer, from that reviewer's own most recent
 *    `review_requested` event. One pull request routinely has one reviewer asked
 *    on day one and another added weeks later; a single timestamp for the whole
 *    pull request would blame the second reviewer for the first one's wait.
 *
 *  - THE CLOCK only runs in working hours, and for a pull request that started
 *    as a draft it starts when it was marked ready, not when it was opened.
 *
 * Drafts, bot-authored pull requests (dependency bumps), bot reviewers, and
 * anything carrying an ignored label are left out: none of them is a person
 * waiting on a person.
 */

const DEFAULT_SLA_HOURS = 24;
const DEFAULT_STALE_DAYS = 10;
const CONCURRENCY       = 5;

// ─── Small helpers ────────────────────────────────────────────────────────────

function slaHours() {
  const n = Number(process.env.GITHUB_REVIEW_SLA_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLA_HOURS;
}

function ignoredLabels() {
  return new Set(
    String(process.env.GITHUB_REVIEW_IGNORE_LABELS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
}

/**
 * How long a wait can run before it stops being "waiting on review" and becomes
 * "parked". Measured in working days so it scales with the length of the team's
 * working day.
 *
 * Real repositories carry pull requests that have waited for months. Listed one
 * by one beside genuinely blocked work they bury it, and nudging a reviewer about
 * a six-month-old PR is noise. They are counted and summarised instead.
 */
function staleDays() {
  const days = Number(process.env.GITHUB_REVIEW_STALE_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_STALE_DAYS;
}

function staleAfterHours(workTime) {
  const start = toMinutes(workTime.workStart ?? '09:00');
  const end = toMinutes(workTime.workEnd ?? '18:00');
  const dayHours = start != null && end != null && end > start ? (end - start) / 60 : 9;
  return staleDays() * dayHours;
}

function sameLogin(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

/** The later of two ISO timestamps, ignoring missing ones. */
function laterOf(...stamps) {
  let best = null;
  for (const s of stamps) {
    if (!s) continue;
    if (best === null || new Date(s).getTime() > new Date(best).getTime()) best = s;
  }
  return best;
}

/** The newest `created_at` among events matching a predicate, or null. */
function latestEventAt(events, predicate) {
  return laterOf(...events.filter(predicate).map((e) => e.created_at));
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

function isEligible(pr, ignore) {
  if (pr.draft) return false;
  if (pr.user?.type === 'Bot') return false;
  const labels = (pr.labels || []).map((l) => String(l.name || '').toLowerCase());
  return !labels.some((l) => ignore.has(l));
}

function humanReviewers(pr) {
  return (pr.requested_reviewers || []).filter((r) => r && r.login && r.type !== 'Bot');
}

function requestedTeams(pr) {
  return (pr.requested_teams || []).filter((t) => t && t.slug);
}

/** No person or team has been asked, so only the review history can say more. */
function hasNoRequestedReviewer(pr) {
  return humanReviewers(pr).length === 0 && requestedTeams(pr).length === 0;
}

// ─── The rules (pure) ─────────────────────────────────────────────────────────

/**
 * Applies the rules to already-fetched data. No network, no database.
 *
 * A pull request is skipped, not guessed at, when the data needed to date it is
 * missing: an events list that failed to load would otherwise default to the
 * opening time and overstate the wait.
 *
 * @param {object} input
 * @param {string} input.repo
 * @param {Array}  input.pulls
 * @param {Map<number, Array>} input.eventsByNumber
 * @param {Map<number, Array>} input.reviewsByNumber  only needed where nobody was asked
 * @param {Date}   input.now
 * @param {number} input.sla                          working hours
 * @param {object} input.workTime                     see utils/workingTime
 * @param {Map<string, object>} [input.membersByLogin]  lower-cased GitHub login → member
 * @param {Set<string>} [input.ignoreLabels]
 * @param {number} [input.staleAfter]  working hours beyond which a wait counts as parked
 */
function evaluate({
  repo, pulls, eventsByNumber, reviewsByNumber = new Map(), now, sla, workTime,
  membersByLogin = new Map(), ignoreLabels = new Set(), staleAfter = Infinity,
}) {
  const waiting = [];
  const unassigned = [];

  const entry = (kind, pr, since, extra) => {
    const waitingHours = workingHoursBetween(since, now, workTime);
    return {
      kind,
      repo,
      number: pr.number,
      title:  pr.title,
      url:    pr.html_url,
      author: pr.user?.login || null,
      since,
      waitingHours,
      // Strictly greater: waiting exactly the SLA is within it.
      overSla: waitingHours > sla,
      // Waited so long it is parked rather than blocked; see staleAfterHours.
      stale: waitingHours > staleAfter,
      ...extra,
    };
  };

  for (const pr of pulls) {
    if (!isEligible(pr, ignoreLabels)) continue;
    if (!eventsByNumber.has(pr.number)) continue;

    const events = eventsByNumber.get(pr.number);
    // A draft that was later marked ready starts its clock at that moment.
    const baseline = laterOf(pr.created_at, latestEventAt(events, (e) => e.event === 'ready_for_review'));

    for (const reviewer of humanReviewers(pr)) {
      const requestedAt = latestEventAt(events, (e) =>
        e.event === 'review_requested' && sameLogin(e.requested_reviewer?.login, reviewer.login));
      waiting.push(entry('reviewer', pr, laterOf(baseline, requestedAt), {
        reviewer: reviewer.login,
        member: membersByLogin.get(reviewer.login.toLowerCase()) || null,
      }));
    }

    for (const team of requestedTeams(pr)) {
      const requestedAt = latestEventAt(events, (e) =>
        e.event === 'review_requested' && e.requested_team?.slug === team.slug);
      waiting.push(entry('team', pr, laterOf(baseline, requestedAt), { team: team.slug, member: null }));
    }

    if (hasNoRequestedReviewer(pr)) {
      if (!reviewsByNumber.has(pr.number)) continue;
      // Someone has looked at it if a person other than the author reviewed it.
      // Bots, the author replying to their own thread, and unsubmitted drafts
      // don't count.
      const looked = reviewsByNumber.get(pr.number).some((r) =>
        r.user?.type !== 'Bot' &&
        !sameLogin(r.user?.login, pr.user?.login) &&
        r.state !== 'PENDING');
      if (!looked) unassigned.push(entry('unassigned', pr, baseline, {}));
    }
  }

  const longestFirst = (a, b) => b.waitingHours - a.waitingHours;
  return { waiting: waiting.sort(longestFirst), unassigned: unassigned.sort(longestFirst) };
}

// ─── Fetch + evaluate ─────────────────────────────────────────────────────────

/**
 * Reads every configured repository and applies the rules.
 *
 * One repository failing — typically a token that cannot see it, which GitHub
 * reports as 404 — does not stop the others, and is returned in `errors` so the
 * caller can say the picture is incomplete instead of presenting a quiet one.
 */
async function assess(organisationId, { now = new Date(), cfg = configService.getSprintConfig() } = {}) {
  if (!githubService.isConfigured()) {
    return {
      configured: false,
      reason: !process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN is not set' : 'GITHUB_REPOS is empty',
      invalidRepos: githubService.getInvalidRepos(),
    };
  }

  const repos = githubService.getRepos();
  const sla = slaHours();
  const ignoreLabels = ignoredLabels();

  const members = await memberRepo.findAll(organisationId);
  const membersByLogin = new Map(
    members.filter((m) => m.github_login).map((m) => [
      m.github_login.toLowerCase(),
      { id: m.id, name: m.name, slackUserId: m.slack_user_id },
    ])
  );

  const workTime = {
    timeZone:  cfg.timezone,
    workStart: process.env.WORK_START_TIME || '09:00',
    workEnd:   process.env.WORK_END_TIME   || '18:00',
    workdays:  cfg.workdays,
  };

  const staleAfter = staleAfterHours(workTime);

  const waiting = [];
  const unassigned = [];
  const errors = [];

  await Promise.all(repos.map(async (repo) => {
    try {
      const pulls = await githubService.listOpenPullRequests(repo);
      const eligible = pulls.filter((pr) => isEligible(pr, ignoreLabels));

      const eventsByNumber  = new Map();
      const reviewsByNumber = new Map();
      const skipped = [];

      await mapLimit(eligible, CONCURRENCY, async (pr) => {
        try {
          eventsByNumber.set(pr.number, await githubService.listIssueEvents(repo, pr.number));
          if (hasNoRequestedReviewer(pr)) {
            reviewsByNumber.set(pr.number, await githubService.listReviews(repo, pr.number));
          }
        } catch (err) {
          skipped.push(err);
        }
      });

      if (skipped.length > 0) {
        errors.push({
          repo,
          error: skipped[0].message,
          code: skipped[0].code,
          skippedPullRequests: skipped.length,
        });
      }

      const result = evaluate({
        repo, pulls, eventsByNumber, reviewsByNumber, now, sla, workTime, membersByLogin, ignoreLabels, staleAfter,
      });
      waiting.push(...result.waiting);
      unassigned.push(...result.unassigned);
    } catch (err) {
      errors.push({ repo, error: err.message, code: err.code });
    }
  }));

  const longestFirst = (a, b) => b.waitingHours - a.waitingHours;
  return {
    configured: true,
    repos,
    invalidRepos: githubService.getInvalidRepos(),
    slaHours: sla,
    staleAfterHours: staleAfter,
    staleDays: staleDays(),
    waiting: waiting.sort(longestFirst),
    unassigned: unassigned.sort(longestFirst),
    errors,
    generatedAt: now.toISOString(),
  };
}

// ─── Time-budgeted, cached access ─────────────────────────────────────────────

/**
 * A full assessment is many sequential-ish API calls (about ten seconds against a
 * repository with seventy open pull requests). The dashboard re-reads the brief
 * on every page view, so without this it would stall for that long each time the
 * cache lapsed.
 *
 * assessWithin() keeps the last good assessment per organisation and applies a
 * time budget: it returns a fresh-enough result immediately, otherwise starts
 * (or joins) a refresh and waits up to `budgetMs` for it. If the refresh is
 * still running it returns the last good result flagged `stale`, or — on the very
 * first call — a `pending` placeholder, and the refresh keeps running so the next
 * request finds it done.
 *
 * Callers that need complete, current data (the morning DM) pass `maxAgeMs: 0`
 * and a long budget.
 */
const snapshots = new Map(); // organisationId -> { value, at, inflight }
const TIMED_OUT = Symbol('timed out');

function defaultMaxAgeMs() {
  const raw = process.env.GITHUB_CACHE_SECONDS;
  const seconds = raw === undefined || raw === '' ? 300 : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300_000;
}

async function assessWithin(organisationId, { budgetMs = 4000, maxAgeMs = defaultMaxAgeMs(), now } = {}) {
  let snap = snapshots.get(organisationId);
  if (!snap) {
    snap = { value: null, at: 0, inflight: null };
    snapshots.set(organisationId, snap);
  }

  if (snap.value && Date.now() - snap.at < maxAgeMs) return snap.value;

  if (!snap.inflight) {
    snap.inflight = assess(organisationId, now ? { now } : {})
      .then((value) => {
        snap.value = value;
        snap.at = Date.now();
        return value;
      })
      .finally(() => { snap.inflight = null; });
    // If the budget runs out first nobody is awaiting this, and a later failure
    // must not surface as an unhandled rejection.
    snap.inflight.catch(() => {});
  }

  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), budgetMs); });
  let result;
  try {
    result = await Promise.race([snap.inflight, budget]);
  } finally {
    clearTimeout(timer);
  }

  if (result !== TIMED_OUT) return result;
  if (snap.value) return { ...snap.value, stale: true };
  return {
    configured: true,
    pending: true,
    repos: githubService.getRepos(),
    invalidRepos: githubService.getInvalidRepos(),
    slaHours: slaHours(),
    waiting: [],
    unassigned: [],
    errors: [],
  };
}

/**
 * Discards cached assessments. The member-to-username mapping is applied inside
 * an assessment, so changing a link must invalidate them or the dashboard keeps
 * showing the old name until the cache lapses.
 */
function invalidate() {
  snapshots.clear();
}

module.exports = {
  assess, assessWithin, evaluate, isEligible, staleAfterHours, slaHours, staleDays,
  DEFAULT_SLA_HOURS, DEFAULT_STALE_DAYS, CONCURRENCY,
  invalidate,
};
