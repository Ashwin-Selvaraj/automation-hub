'use strict';

/**
 * Safe interpolation of untrusted text into Slack messages.
 *
 * Pull request titles, branch names and logins are written by whoever has access
 * to a repository, and in Slack's mrkdwn `<!channel>`, `<@U123>` and
 * `<https://elsewhere|click here>` are live syntax. Dropping a title straight
 * into a message would let it mention people, ping a channel, or present a link
 * that reads as something else. Slack's documented rule is that `&`, `<` and `>`
 * are the only characters that must be escaped.
 */

/** Escapes the three characters Slack treats as control syntax. */
function escape(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Shortens text to at most `max` characters. Done on the raw text, before
 * escaping, so an `&amp;` is never cut in half.
 */
function truncate(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

/**
 * A Slack link: `<url|label>`. Only https URLs become links; anything else is
 * shown as plain, escaped text rather than a link to somewhere unexpected.
 */
function link(url, label, { max = 80 } = {}) {
  const text = escape(truncate(label, max));
  if (!/^https:\/\//i.test(String(url || ''))) return text;
  // `>`, `|` and whitespace would end the link early or smuggle in a label.
  const safeUrl = String(url).replace(/[<>|\s]/g, '');
  return `<${safeUrl}|${text}>`;
}

module.exports = { escape, truncate, link };
