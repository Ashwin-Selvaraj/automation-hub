'use strict';

require('dotenv').config();
const { WebClient } = require('@slack/web-api');

let client = null;

/**
 * Returns a singleton Slack WebClient using the bot token from env.
 * @returns {WebClient}
 */
function getClient() {
  if (!client) {
    if (!process.env.SLACK_BOT_TOKEN) {
      throw new Error('SLACK_BOT_TOKEN is not configured');
    }
    client = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return client;
}

/**
 * Fetches messages from a Slack channel within a Unix timestamp range.
 * @param {string} channelId - Slack channel ID
 * @param {number} oldestTs - Unix timestamp (seconds) for earliest message
 * @param {number} latestTs - Unix timestamp (seconds) for latest message
 * @returns {Promise<Array<Object>>} Array of Slack message objects
 */
async function getChannelMessages(channelId, oldestTs, latestTs) {
  try {
    const slack = getClient();
    const messages = [];
    let cursor;

    do {
      const res = await slack.conversations.history({
        channel: channelId,
        oldest: String(oldestTs),
        latest: String(latestTs),
        limit: 200,
        cursor,
      });

      if (res.messages) {
        messages.push(...res.messages.filter((m) => !m.subtype));
      }

      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    return messages;
  } catch (err) {
    const msg = err.data?.error || err.message;
    throw new Error(`Slack getChannelMessages failed: ${msg}`);
  }
}

/**
 * Opens a DM channel with a user and posts a message.
 * @param {string} userId - Slack user ID
 * @param {string} text - Message text
 * @returns {Promise<void>}
 */
async function sendDM(userId, text) {
  try {
    const slack = getClient();
    const im = await slack.conversations.open({ users: userId });
    const channelId = im.channel.id;
    await slack.chat.postMessage({ channel: channelId, text });
  } catch (err) {
    const msg = err.data?.error || err.message;
    throw new Error(`Slack sendDM to ${userId} failed: ${msg}`);
  }
}

/**
 * Posts a message to a Slack channel.
 * @param {string} channelId - Slack channel ID
 * @param {string} text - Message text (Slack mrkdwn supported)
 * @returns {Promise<void>}
 */
async function postToChannel(channelId, text) {
  try {
    const slack = getClient();
    await slack.chat.postMessage({ channel: channelId, text });
  } catch (err) {
    const msg = err.data?.error || err.message;
    throw new Error(`Slack postToChannel ${channelId} failed: ${msg}`);
  }
}

/**
 * Retrieves display name and real name for a Slack user.
 * @param {string} userId - Slack user ID
 * @returns {Promise<{ id: string, displayName: string, realName: string, email: string }>}
 */
async function getUserInfo(userId) {
  try {
    const slack = getClient();
    const res = await slack.users.info({ user: userId });
    const profile = res.user.profile;
    return {
      id: userId,
      displayName: profile.display_name || profile.real_name || userId,
      realName: profile.real_name || userId,
      email: profile.email || '',
    };
  } catch (err) {
    const msg = err.data?.error || err.message;
    throw new Error(`Slack getUserInfo for ${userId} failed: ${msg}`);
  }
}

/**
 * Tests the Slack connection by calling auth.test.
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    const slack = getClient();
    await slack.auth.test();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch email addresses for all team members from Slack using their Slack user IDs.
 * Skips members who already have an email. Stores fetched emails in the DB.
 *
 * Required Slack scope: users:read.email
 * If this scope is missing, individual calls will fail with 'missing_scope'.
 *
 * @param {number} organisationId
 * @returns {Promise<{ fetched: Array, failed: Array, skipped: Array }>}
 */
async function fetchAndStoreSlackEmails(organisationId) {
  const memberRepository = require('../repositories/memberRepository');
  const members  = await memberRepository.findAll(organisationId);
  const results  = { fetched: [], failed: [], skipped: [] };

  for (const member of members) {
    if (member.email) {
      results.skipped.push({
        memberId:    member.id,
        name:        member.name,
        reason:      `Already has email: ${member.email}`,
      });
      continue;
    }

    if (!member.slack_user_id) {
      results.failed.push({
        memberId:    member.id,
        name:        member.name,
        slackUserId: null,
        reason:      'No Slack user ID on record',
      });
      continue;
    }

    try {
      const slack    = getClient();
      const response = await slack.users.info({ user: member.slack_user_id });

      if (response.ok && response.user?.profile?.email) {
        const email = response.user.profile.email;
        await memberRepository.updateEmail(member.id, email);
        results.fetched.push({
          memberId:    member.id,
          name:        member.name,
          slackUserId: member.slack_user_id,
          email,
        });
      } else {
        const reason = response.error === 'missing_scope'
          ? 'users:read.email scope missing — add it in api.slack.com/apps under OAuth & Permissions → Bot Token Scopes'
          : 'Email not available in Slack profile — ask member to make their email visible';
        results.failed.push({
          memberId:    member.id,
          name:        member.name,
          slackUserId: member.slack_user_id,
          reason,
        });
      }
    } catch (err) {
      const slackErr = err.data?.error || err.message;
      const reason   = slackErr === 'missing_scope'
        ? 'users:read.email scope missing — add it in api.slack.com/apps under OAuth & Permissions → Bot Token Scopes'
        : slackErr;
      results.failed.push({
        memberId:    member.id,
        name:        member.name,
        slackUserId: member.slack_user_id,
        reason,
      });
    }

    // 100 ms delay between requests to respect Slack rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  return results;
}

module.exports = {
  getChannelMessages,
  sendDM,
  postToChannel,
  getUserInfo,
  testConnection,
  fetchAndStoreSlackEmails,
};
