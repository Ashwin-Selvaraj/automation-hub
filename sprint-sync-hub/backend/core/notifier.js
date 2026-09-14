'use strict';

const slackService = require('../services/slackService');
const configService = require('../services/configService');
const idempotency  = require('./idempotency');
const auditLog     = require('./auditLog');

/**
 * The only way anything in this app sends a message.
 *
 * Routing every outbound message through one function is what makes the
 * duplicate-DM bug structurally impossible rather than fixed case by case.
 * Every send must carry a dedupe key, and every send is checked against quiet
 * hours before it goes out.
 *
 * Direct calls to slackService.sendDM still exist inside this module only.
 */

const DEFAULT_TTL_HOURS = 20;

/** Minutes past midnight, or null if unparseable. */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Current wall-clock minutes and weekday in the configured timezone. */
function localNow(timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date());

  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = get('weekday');
  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
  };
}

/**
 * Whether a person-facing message is allowed to go out right now.
 *
 * A 9pm nudge teaches the team that 9pm is working time. Messages to a channel
 * are exempt — nobody is interrupted by one — as are messages the caller marks
 * urgent.
 */
function quietHoursCheck(cfg) {
  const timezone = cfg.timezone || 'Asia/Kolkata';
  const start = toMinutes(process.env.WORK_START_TIME || '09:00');
  const end   = toMinutes(process.env.WORK_END_TIME   || '18:00');
  if (start == null || end == null) return { allowed: true };

  const { minutes, isWeekend } = localNow(timezone);

  if (isWeekend) {
    return { allowed: false, reason: 'weekend' };
  }
  // Allow a grace hour past the end of the working day, so an 18:30 end-of-day
  // reminder against an 18:00 finish still lands.
  if (minutes < start || minutes > end + 60) {
    return { allowed: false, reason: `outside working hours (${cfg.timezone})` };
  }
  return { allowed: true };
}

/**
 * Sends a direct message to one person.
 *
 * @param {object}  opts
 * @param {number}  opts.orgId
 * @param {string}  opts.slackUserId    Recipient.
 * @param {string}  opts.text
 * @param {string}  opts.dedupeKey      Required. Identity of this message, e.g. "eod-dm:42:2026-09-14".
 * @param {string}  opts.type           Audit log entry type.
 * @param {number} [opts.ttlHours]      How long the dedupe key blocks a repeat.
 * @param {string} [opts.userName]      For the audit trail.
 * @param {string} [opts.action]        Human-readable description for the audit trail.
 * @param {boolean}[opts.urgent]        Bypasses quiet hours. Use sparingly.
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendDM(opts) {
  const { orgId, slackUserId, text, dedupeKey, type, ttlHours = DEFAULT_TTL_HOURS, userName, action, urgent } = opts;

  if (!dedupeKey) {
    throw new Error(`notifier.sendDM requires a dedupeKey (type: ${type || 'unknown'})`);
  }
  if (!slackUserId) {
    return { sent: false, reason: 'no recipient' };
  }

  const cfg = configService.getSprintConfig();

  if (!urgent) {
    const quiet = quietHoursCheck(cfg);
    if (!quiet.allowed) {
      auditLog.record(orgId, {
        type, userId: slackUserId, userName,
        action: `Held back — ${quiet.reason}`, success: true,
      });
      return { sent: false, reason: quiet.reason };
    }
  }

  // Claim before sending. Losing the claim means someone already sent this.
  if (!await idempotency.claim(orgId, dedupeKey, ttlHours)) {
    return { sent: false, reason: 'already sent' };
  }

  try {
    await slackService.sendDM(slackUserId, text);
  } catch (err) {
    // Release so a later run can retry — this message never went out.
    await idempotency.release(orgId, dedupeKey);
    auditLog.record(orgId, {
      type, userId: slackUserId, userName,
      action: action || 'DM failed', success: false, details: err.message,
    });
    return { sent: false, reason: err.message };
  }

  auditLog.record(orgId, {
    type, userId: slackUserId, userName,
    action: action || 'DM sent', success: true,
  });
  return { sent: true };
}

/**
 * Posts to a channel. Exempt from quiet hours — a channel post interrupts
 * nobody — but still requires a dedupe key.
 */
async function postToChannel(opts) {
  const { orgId, channelId, text, dedupeKey, type, ttlHours = DEFAULT_TTL_HOURS, action } = opts;

  if (!dedupeKey) {
    throw new Error(`notifier.postToChannel requires a dedupeKey (type: ${type || 'unknown'})`);
  }
  if (!channelId) {
    return { sent: false, reason: 'no channel configured' };
  }

  if (!await idempotency.claim(orgId, dedupeKey, ttlHours)) {
    return { sent: false, reason: 'already posted' };
  }

  try {
    await slackService.postToChannel(channelId, text);
  } catch (err) {
    await idempotency.release(orgId, dedupeKey);
    auditLog.record(orgId, { type, action: action || 'Channel post failed', success: false, details: err.message });
    return { sent: false, reason: err.message };
  }

  auditLog.record(orgId, { type, action: action || 'Posted to channel', success: true });
  return { sent: true };
}

module.exports = { sendDM, postToChannel, quietHoursCheck, _toMinutes: toMinutes };
