'use strict';

const slackService = require('./slackService');
const standupRepo = require('../repositories/standupRepository');
const zohoService = require('./employeeZohoService');

function partsAt(date, timeZone) {
  const values = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function zonedDateTimeToUtc(parts, timeZone) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let guess = desired;
  // Two passes account for zones with daylight-saving transitions.
  for (let i = 0; i < 2; i++) {
    const actual = partsAt(new Date(guess), timeZone);
    const represented = Date.UTC(
      actual.year, actual.month - 1, actual.day,
      actual.hour || 0, actual.minute || 0, actual.second || 0
    );
    guess += desired - represented;
  }
  return new Date(guess);
}

function currentDayWindow(now = new Date(), timeZone = process.env.TIMEZONE || 'Asia/Kolkata') {
  // This throws for an invalid IANA timezone, which is a server configuration
  // error and must not be reported as an employee's missing update.
  const local = partsAt(now, timeZone);
  const date = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  const start = zonedDateTimeToUtc({ ...local, hour: 0, minute: 0, second: 0 }, timeZone);
  const nextCalendar = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const end = zonedDateTimeToUtc({
    year: nextCalendar.getUTCFullYear(),
    month: nextCalendar.getUTCMonth() + 1,
    day: nextCalendar.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  }, timeZone);
  return { date, start, end, timeZone };
}

function checkoutDestination() {
  const value = process.env.ZOHO_CHECKOUT_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^people\.zoho\./i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function slackChannelUrl(channelId) {
  if (process.env.SLACK_CHANNEL_URL) {
    try {
      const configured = new URL(process.env.SLACK_CHANNEL_URL);
      if (configured.protocol === 'https:') return configured.toString();
    } catch { /* use the verified Slack redirect fallback */ }
  }
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(channelId)}`;
}

async function validate(employee, now = new Date()) {
  const connection = await zohoService.ensureConnected(employee.memberId);
  if (!connection.connected) {
    return {
      code: 'NOT_CONNECTED',
      connected: false,
      reconnectRequired: connection.reconnectRequired === true,
      message: connection.status === 'revoked'
        ? 'Your Zoho connection has expired or been revoked. Please reconnect it.'
        : 'Zoho People not connected.',
    };
  }

  const destination = checkoutDestination();
  if (!destination) {
    const err = new Error('Zoho checkout destination is not configured');
    err.code = 'DESTINATION_NOT_CONFIGURED';
    throw err;
  }

  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!channelId) {
    const err = new Error('Slack daily-update channel is not configured');
    err.code = 'SLACK_NOT_CONFIGURED';
    throw err;
  }

  const window = currentDayWindow(now);
  const storedPost = await standupRepo.findByMemberAndDate(employee.memberId, window.date);
  if (storedPost) {
    const timestamp = Number.parseFloat(storedPost.slack_message_ts);
    if (Number.isFinite(timestamp) &&
        timestamp >= window.start.getTime() / 1000 &&
        timestamp < window.end.getTime() / 1000) {
      return {
        code: 'UPDATE_FOUND',
        message: "Your daily update has been found. You're ready to check out.",
        checkoutUrl: destination,
        date: window.date,
      };
    }
  }

  let messages;
  try {
    messages = await slackService.getChannelMessages(
      channelId,
      window.start.getTime() / 1000,
      window.end.getTime() / 1000
    );
  } catch (err) {
    const wrapped = new Error('Slack could not be checked right now');
    wrapped.code = 'SLACK_ERROR';
    wrapped.cause = err;
    throw wrapped;
  }

  const ownUpdate = messages.some((message) => {
    if (message.user !== employee.slackUserId || !message.text?.trim()) return false;
    const timestamp = Number.parseFloat(message.ts);
    if (!Number.isFinite(timestamp) ||
        timestamp < window.start.getTime() / 1000 ||
        timestamp >= window.end.getTime() / 1000) return false;
    // conversations.history returns top-level messages. Keep this explicit so
    // a future Slack helper change cannot accidentally make replies count.
    return !message.thread_ts || message.thread_ts === message.ts;
  });

  if (ownUpdate) {
    return {
      code: 'UPDATE_FOUND',
      message: "Your daily update has been found. You're ready to check out.",
      checkoutUrl: destination,
      date: window.date,
    };
  }

  return {
    code: 'UPDATE_MISSING',
    message: "Your daily update hasn't been found yet. Please post your update in the team channel before proceeding.",
    slackChannelUrl: slackChannelUrl(channelId),
    date: window.date,
  };
}

module.exports = {
  validate,
  currentDayWindow,
  checkoutDestination,
  slackChannelUrl,
};
