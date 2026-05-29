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

module.exports = { getChannelMessages, sendDM, postToChannel, getUserInfo, testConnection };
