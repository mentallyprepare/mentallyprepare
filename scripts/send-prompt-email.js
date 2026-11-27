#!/usr/bin/env node
'use strict';

// Send the weekly prompt to the one-prompt-a-week list.
//
// Nothing sends by accident:
//   node scripts/send-prompt-email.js                 # dry run: who, and what
//   node scripts/send-prompt-email.js --to you@x.com  # one test email, to you only
//   node scripts/send-prompt-email.js --send          # the real send
//
// The real send refuses without --send, refuses if SMTP is not configured, and
// skips anyone already sent to in the last six days, so a second run in the
// same week is a no-op rather than a second email.
//
// Run it where the production data lives: on Railway, set DATA_DIR (or
// RAILWAY_VOLUME_MOUNT_PATH) to the volume before running.

const path = require('path');
const Database = require('better-sqlite3');
const { buildPromptEmail, promptForWeek, unsubscribeUrlFor } = require('../lib/prompt-email');

const IS_PROD = process.env.NODE_ENV === 'production';
const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (IS_PROD ? '/data/db' : APP_ROOT);
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'mentally-prepare.db');
const BASE_URL = (process.env.BASE_URL || 'https://mymentallyprepare.com').replace(/\/$/, '');

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const toIndex = args.indexOf('--to');
const TEST_TO = toIndex >= 0 ? args[toIndex + 1] : null;

function loadDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

async function main() {
  const db = loadDb();
  const prompt = promptForWeek(new Date());
  const rows = db.prepare(`
    SELECT id, email, token FROM prompt_subscribers
    WHERE unsubscribed_at IS NULL
      AND (last_sent_at IS NULL OR last_sent_at < datetime('now', '-6 days'))
    ORDER BY created_at ASC
  `).all();

  console.log(`Prompt: ${prompt}`);
  console.log(`Recipients due: ${rows.length}`);

  if (TEST_TO) {
    const sample = buildPromptEmail({
      prompt,
      unsubscribeUrl: unsubscribeUrlFor('test-token-not-valid', BASE_URL),
      baseUrl: BASE_URL
    });
    const { sendEmail } = require('../lib/email');
    await sendEmail(TEST_TO, sample.subject, sample.html);
    console.log(`Test email sent to ${TEST_TO}. The unsubscribe link in it is intentionally invalid.`);
    return;
  }

  if (!SEND) {
    const first = rows[0];
    if (!first) { console.log('Nobody is due. Nothing to preview.'); return; }
    const sample = buildPromptEmail({
      prompt,
      unsubscribeUrl: unsubscribeUrlFor(first.token, BASE_URL),
      baseUrl: BASE_URL
    });
    console.log('--- preview (first recipient) ---');
    console.log(`To: ${first.email}`);
    console.log(`Subject: ${sample.subject}`);
    console.log(sample.text);
    console.log('--- end preview ---');
    console.log('Dry run only. Add --send to deliver, or --to you@example.com for one test.');
    return;
  }

  if (!rows.length) { console.log('Nobody is due. Nothing sent.'); return; }

  const { sendEmail } = require('../lib/email');
  const markSent = db.prepare("UPDATE prompt_subscribers SET last_sent_at = datetime('now'), send_count = send_count + 1 WHERE id = ?");
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const { subject, html } = buildPromptEmail({
      prompt,
      unsubscribeUrl: unsubscribeUrlFor(row.token, BASE_URL),
      baseUrl: BASE_URL
    });
    try {
      await sendEmail(row.email, subject, html);
      markSent.run(row.id);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`Failed for subscriber ${row.id}`);
    }
  }
  console.log(`Sent ${sent}, failed ${failed}, of ${rows.length} due.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error('Prompt send aborted:', error.message || error);
  process.exitCode = 1;
});
