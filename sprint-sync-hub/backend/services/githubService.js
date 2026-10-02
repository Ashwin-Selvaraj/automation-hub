'use strict';

const axios = require('axios');

/**
 * A small, read-only client for the GitHub REST API.
 *
 * It never writes: it lists pull requests, their events, and their reviews. The
 * token it needs can be a fine-grained personal access token with read-only
 * "Pull requests" and "Metadata" access on the repositories in GITHUB_REPOS, and
 * nothing more. That is a deliberate property — an integration that can only
 * read is one a team can approve without a security review.
 *
 * Configuration (environment):
 *   GITHUB_TOKEN          required
 *   GITHUB_REPOS          required, comma-separated "owner/repo"
 *   GITHUB_API_URL        optional, for GitHub Enterprise Server (https only)
 *   GITHUB_CACHE_SECONDS  optional, default 300; 0 disables caching
 */

const API_VERSION        = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES          = 5;
const DEFAULT_CACHE_SECONDS = 300;
const CACHE_PURGE_AT     = 500;

// Responses are cached briefly: the dashboard re-reads the brief on every page
// load, and without this each load would spend a call per open pull request.
const cache = new Map(); // key -> { expires, value }

// ─── Configuration ────────────────────────────────────────────────────────────

function cacheTtlMs() {
  const raw = process.env.GITHUB_CACHE_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_CACHE_SECONDS * 1000;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_CACHE_SECONDS * 1000;
}

function baseUrl() {
  const raw = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('GITHUB_API_URL is not a valid URL');
  }
  // The token travels in the Authorization header, so plain http would send it
  // in the clear.
  if (parsed.protocol !== 'https:') throw new Error('GITHUB_API_URL must use https');
  return raw;
}

/** "owner/repo" with neither half empty or made only of dots (no path tricks). */
function isValidRepoName(name) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(name || ''));
  return Boolean(m) && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2]);
}

function configuredRepoNames() {
  return String(process.env.GITHUB_REPOS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** Repositories to read — only well-formed names. */
function getRepos() {
  return configuredRepoNames().filter(isValidRepoName);
}

/** Configured names that are not well-formed, so a typo is reported not ignored. */
function getInvalidRepos() {
  return configuredRepoNames().filter((n) => !isValidRepoName(n));
}

function isConfigured() {
  return Boolean(process.env.GITHUB_TOKEN) && getRepos().length > 0;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Turns an axios failure into an error that is safe to log and to show.
 *
 * An axios error carries the whole request config, which includes the
 * Authorization header. It is never attached as `cause`, never serialised, and
 * only GitHub's own short message and the HTTP status are kept.
 */
function toSafeError(err) {
  const status = err.response?.status;
  if (!status) {
    const e = new Error(`GitHub could not be reached (${err.code || 'network error'})`);
    e.code = 'GITHUB_NETWORK';
    return e;
  }

  const apiMessage = String(err.response?.data?.message || '').slice(0, 200);
  const rateLimited = status === 429 ||
    (status === 403 && err.response.headers?.['x-ratelimit-remaining'] === '0');

  let code = 'GITHUB_ERROR';
  let hint = '';
  if (status === 401) {
    code = 'GITHUB_AUTH';
    hint = ' — the token is invalid or expired';
  } else if (rateLimited) {
    code = 'GITHUB_RATE_LIMIT';
    hint = ' — rate limit reached';
  } else if (status === 404) {
    // GitHub answers 404, not 403, for a repository the token cannot see.
    code = 'GITHUB_NOT_FOUND';
    hint = ' — the repository does not exist or the token cannot access it';
  }

  const e = new Error(`GitHub ${status}${apiMessage ? `: ${apiMessage}` : ''}${hint}`);
  e.code = code;
  e.status = status;
  return e;
}

// ─── Requests ─────────────────────────────────────────────────────────────────

function purgeExpired(now) {
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
}

async function getPage(path, params, { useCache = true } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    const e = new Error('GITHUB_TOKEN is not set');
    e.code = 'GITHUB_NOT_CONFIGURED';
    throw e;
  }

  const url = `${baseUrl()}${path}`;
  const key = `${url}?${new URLSearchParams(params).toString()}`;
  const ttl = useCache ? cacheTtlMs() : 0;
  const now = Date.now();

  const hit = cache.get(key);
  if (ttl > 0 && hit && hit.expires > now) return hit.value;

  let response;
  try {
    response = await axios.get(url, {
      params,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'sprint-sync-hub',
      },
    });
  } catch (err) {
    throw toSafeError(err);
  }

  const value = {
    data: response.data,
    hasNext: /<[^>]+>;\s*rel="next"/.test(String(response.headers?.link || '')),
  };

  if (ttl > 0) {
    if (cache.size >= CACHE_PURGE_AT) purgeExpired(now);
    cache.set(key, { expires: now + ttl, value });
  }
  return value;
}

/** Collects every page of a list endpoint, up to MAX_PAGES of 100. */
async function paginate(path, params = {}) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, hasNext } = await getPage(path, { ...params, per_page: 100, page });
    if (Array.isArray(data)) items.push(...data);
    if (!hasNext) return items;
  }
  console.warn(`[github] ${path} has more than ${MAX_PAGES * 100} results — the rest are not read`);
  return items;
}

function repoPath(repo) {
  if (!isValidRepoName(repo)) throw new Error(`"${repo}" is not a valid owner/repo name`);
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Open pull requests, oldest first. */
async function listOpenPullRequests(repo) {
  return paginate(`${repoPath(repo)}/pulls`, { state: 'open', sort: 'created', direction: 'asc' });
}

/** Timeline events on a pull request: review requests, ready-for-review, etc. */
async function listIssueEvents(repo, number) {
  return paginate(`${repoPath(repo)}/issues/${Number(number)}/events`);
}

/** Submitted reviews on a pull request. */
async function listReviews(repo, number) {
  return paginate(`${repoPath(repo)}/pulls/${Number(number)}/reviews`);
}

/**
 * Whether the token can see a repository. Used to explain a misconfiguration
 * ("not found" almost always means the token lacks access) before it shows up
 * as a quietly empty brief. Bypasses the cache so a fixed token is noticed.
 */
async function checkRepoAccess(repo) {
  if (!isValidRepoName(repo)) {
    return { repo, ok: false, code: 'INVALID_NAME', message: 'Not a valid owner/repo name' };
  }
  try {
    await getPage(repoPath(repo), {}, { useCache: false });
    return { repo, ok: true };
  } catch (err) {
    return { repo, ok: false, code: err.code || 'GITHUB_ERROR', status: err.status, message: err.message };
  }
}

function _resetCache() {
  cache.clear();
}

module.exports = {
  isConfigured, getRepos, getInvalidRepos, isValidRepoName,
  listOpenPullRequests, listIssueEvents, listReviews, checkRepoAccess,
  _resetCache,
};
