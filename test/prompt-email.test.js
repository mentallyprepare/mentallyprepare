'use strict';

// The weekly prompt email: what it says, and the three things that must stay
// true about it — one prompt, a working unsubscribe link, and nothing that
// reports back whether someone opened it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const { PROMPTS, promptForWeek, buildPromptEmail, unsubscribeUrlFor } = require('../lib/prompt-email');

// 1. The prompt is stable within a week and rotates across them.
{
  const monday = new Date('2026-11-23T06:00:00Z');
  const friday = new Date('2026-11-27T06:00:00Z');
  assert.equal(promptForWeek(monday), promptForWeek(friday), 'the same week sends the same prompt');
  const nextWeek = new Date('2026-11-30T06:00:00Z');
  assert.notEqual(promptForWeek(monday), promptForWeek(nextWeek), 'the next week moves on');
  assert.ok(PROMPTS.includes(promptForWeek(monday)));
}

// 2. The email carries the prompt, the unsubscribe link and the 18+ line.
{
  const url = unsubscribeUrlFor('abc123', 'https://mymentallyprepare.com');
  const email = buildPromptEmail({ prompt: PROMPTS[0], unsubscribeUrl: url, baseUrl: 'https://mymentallyprepare.com' });
  assert.ok(email.html.includes(PROMPTS[0]));
  assert.ok(email.text.includes(PROMPTS[0]));
  assert.ok(email.html.includes('/prompts/unsubscribe?token=abc123'));
  assert.ok(email.text.includes('/prompts/unsubscribe?token=abc123'));
  assert.equal(email.subject, 'one question for this week');
  assert.ok(/18\+/.test(email.html), 'the age line stays');
}

// 3. Nothing reports back. No pixel, no campaign parameters, no address.
{
  const email = buildPromptEmail({
    prompt: PROMPTS[1],
    unsubscribeUrl: unsubscribeUrlFor('tok', 'https://mymentallyprepare.com'),
    baseUrl: 'https://mymentallyprepare.com'
  });
  assert.ok(!/<img/i.test(email.html), 'no tracking pixel or images');
  assert.ok(!/utm_/.test(email.html), 'no campaign parameters');
  assert.ok(!/gtag|analytics|pixel/i.test(email.html));
}

// 4. The sender only picks people who are due, and only once a week.
{
  const db = new Database(':memory:');
  db.exec(read('migrations', '0002_prompt_list.sql'));
  db.exec(read('migrations', '0003_prompt_list_send_tracking.sql'));
  const insert = db.prepare('INSERT INTO prompt_subscribers (email, source, token) VALUES (?, ?, ?)');
  insert.run('a@example.com', 'blog', 'a'.repeat(48));
  insert.run('b@example.com', 'blog', 'b'.repeat(48));
  insert.run('c@example.com', 'blog', 'c'.repeat(48));
  db.prepare("UPDATE prompt_subscribers SET unsubscribed_at = datetime('now') WHERE email = 'c@example.com'").run();
  db.prepare("UPDATE prompt_subscribers SET last_sent_at = datetime('now') WHERE email = 'b@example.com'").run();

  const due = db.prepare(`
    SELECT email FROM prompt_subscribers
    WHERE unsubscribed_at IS NULL
      AND (last_sent_at IS NULL OR last_sent_at < datetime('now', '-6 days'))
  `).all().map(row => row.email);
  assert.deepEqual(due, ['a@example.com'], 'unsubscribed and recently-mailed addresses are both skipped');
}

// 5. The sender refuses to send without the flag, and the flag is explicit.
{
  const script = read('scripts', 'send-prompt-email.js');
  assert.ok(script.includes("args.includes('--send')"), 'a real send needs --send');
  assert.ok(script.includes('Dry run only'), 'the default path prints a preview instead of sending');
  assert.ok(script.includes("'-6 days'"), 'a second run in the same week is a no-op');
}

console.log('Prompt email: prompt rotation, unsubscribe, no-tracking and due-date checks passed');
