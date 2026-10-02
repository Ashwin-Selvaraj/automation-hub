'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { escape, truncate, link } = require('../utils/slackText');

test('the characters Slack treats as syntax are escaped, ampersand first', () => {
  assert.equal(escape('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(escape('&lt;'), '&amp;lt;', 'an existing entity is not double-decoded into syntax');
});

test('a title cannot mention a channel, a person, or a group', () => {
  for (const hostile of ['<!channel> deploy now', '<!here>', '<@U12345> approve this', '<!subteam^S123|@oncall>']) {
    const out = escape(hostile);
    assert.ok(!out.includes('<'), `"${hostile}" must not survive with a live <`);
    assert.ok(!out.includes('>'));
  }
});

test('a title cannot present a link that reads as something else', () => {
  const out = link('https://github.com/acme/api/pull/1', 'Fix <https://evil.example|your bank> login');
  assert.equal(out.startsWith('<https://github.com/acme/api/pull/1|'), true, 'the real URL is the only link');
  assert.equal(out.match(/</g).length, 1, 'there is exactly one opening angle bracket');
  assert.ok(out.includes('&lt;https://evil.example'), 'the hostile markup is shown as text');
});

test('only https URLs become links', () => {
  assert.equal(link('http://example.com/x', 'Title'), 'Title');
  assert.equal(link('javascript:alert(1)', 'Title'), 'Title');
  assert.equal(link('', 'Title'), 'Title');
  assert.equal(link(undefined, 'Title'), 'Title');
  assert.equal(link('https://github.com/a/b/pull/1', 'Title'), '<https://github.com/a/b/pull/1|Title>');
});

test('a URL cannot end the link early or smuggle in a label', () => {
  const out = link('https://github.com/a/b/pull/1|fake> <!channel', 'Title');
  assert.ok(!out.includes('<!channel'), 'markup inside the URL is stripped');
  assert.equal(out.match(/\|/g).length, 1, 'one label separator only');
});

test('long text is shortened before escaping so an entity is never cut in half', () => {
  const title = 'Fix & ' + 'x'.repeat(100);
  const out = link('https://github.com/a/b/pull/1', title, { max: 8 });
  assert.ok(out.endsWith('…>'), 'ellipsis added');
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(out), 'no broken entity');
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('a   b\n\nc', 10), 'a b c', 'whitespace is collapsed');
});

test('null and undefined are empty text, not the word "undefined"', () => {
  assert.equal(escape(undefined), '');
  assert.equal(escape(null), '');
  assert.equal(truncate(undefined, 5), '');
});
