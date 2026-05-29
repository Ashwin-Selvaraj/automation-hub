'use strict';

const MAX_ENTRIES = 500;

/** @type {Array<Object>} */
const log = [];

let idCounter = 1;

/**
 * Adds a new entry to the in-memory activity log, capping at MAX_ENTRIES.
 * @param {{ type: string, userId?: string, userName?: string, slackMessageTs?: string, jiraKey?: string, action: string, success: boolean, details?: string }} entry
 * @returns {Object} The stored entry with generated id and timestamp
 */
function addEntry(entry) {
  const stored = {
    id: idCounter++,
    timestamp: new Date().toISOString(),
    type: entry.type || 'unknown',
    userId: entry.userId || null,
    userName: entry.userName || null,
    slackMessageTs: entry.slackMessageTs || null,
    jiraKey: entry.jiraKey || null,
    action: entry.action || '',
    success: entry.success !== undefined ? entry.success : true,
    details: entry.details || '',
  };

  log.push(stored);

  if (log.length > MAX_ENTRIES) {
    log.splice(0, log.length - MAX_ENTRIES);
  }

  return stored;
}

/**
 * Returns the most recent N entries from the log.
 * @param {number} [limit=50] - Maximum entries to return
 * @returns {Array<Object>}
 */
function getEntries(limit = 50) {
  return log.slice(-Math.min(limit, log.length)).reverse();
}

/**
 * Returns all log entries associated with a specific Slack user ID.
 * @param {string} userId
 * @returns {Array<Object>}
 */
function getEntriesForUser(userId) {
  return log.filter((e) => e.userId === userId).reverse();
}

/**
 * Checks if a DM of the given type was sent to userId within the last 24 hours.
 * @param {string} userId
 * @param {string} type - e.g. "no_match_dm"
 * @returns {boolean}
 */
function recentDMExists(userId, type) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return log.some(
    (e) => e.userId === userId && e.type === type && e.success && new Date(e.timestamp).getTime() > cutoff
  );
}

module.exports = { addEntry, getEntries, getEntriesForUser, recentDMExists };
