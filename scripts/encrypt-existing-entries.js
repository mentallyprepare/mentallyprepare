#!/usr/bin/env node
'use strict';

// One-time migration: encrypt every plaintext row in the sensitive text
// columns in place. Idempotent — rows that are already v1: encrypted are
// skipped, so re-running is safe.
//
// Covers: entries.text, waiting_entries.text, tonights_question_entries.text,
//         crisis_review.content, comments.text
//
// Refuses to run without ENTRIES_ENCRYPTION_KEY set. Refuses to run against
// production without --yes (bare invocation prints the plan and exits 1 so
// nobody encrypts prod by muscle memory).
//
// Prints per-table counts and a totals line. Runs inside a single
// transaction per table so a mid-flight crash rolls back cleanly.
//
// Usage:
//   ENTRIES_ENCRYPTION_KEY=<base64> node scripts/encrypt-existing-entries.js
//   ENTRIES_ENCRYPTION_KEY=<base64> node scripts/encrypt-existing-entries.js --yes    # prod
//   ENTRIES_ENCRYPTION_KEY=<base64> node scripts/encrypt-existing-entries.js --dry-run

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { encrypt, isEncrypted, hasKey } = require('../lib/entry-crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const PROD_ACK = args.has('--yes');

function resolveDbPath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  const dataDir = process.env.DATA_DIR
    || process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (IS_PROD ? '/data/db' : path.join(__dirname, '..'));
  return path.join(dataDir, 'mentally-prepare.db');
}

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

if (!hasKey()) {
  die('ENTRIES_ENCRYPTION_KEY is not set. Refusing to run.');
}
if (IS_PROD && !PROD_ACK && !DRY_RUN) {
  die('NODE_ENV=production and --yes was not passed. Refusing to touch production data without an explicit ack.');
}

const dbPath = resolveDbPath();
if (!fs.existsSync(dbPath)) {
  die(`Database not found at ${dbPath}. Set DB_PATH or DATA_DIR.`);
}

console.log(`• Database: ${dbPath}`);
console.log(`• Mode: ${DRY_RUN ? 'dry-run (no writes)' : IS_PROD ? 'PRODUCTION (--yes)' : 'dev/staging'}`);
console.log('');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Table → (id column, text column). The id column is used to route the
// UPDATE; every table listed here has a rowid-shaped `id` primary key.
const TABLES = [
  { table: 'entries',                   idCol: 'id', textCol: 'text' },
  { table: 'waiting_entries',           idCol: 'id', textCol: 'text' },
  { table: 'tonights_question_entries', idCol: 'id', textCol: 'text' },
  { table: 'crisis_review',             idCol: 'id', textCol: 'content' },
  { table: 'comments',                  idCol: 'id', textCol: 'text' },
];

const totals = { scanned: 0, encrypted: 0, alreadyEncrypted: 0, empty: 0 };

for (const { table, idCol, textCol } of TABLES) {
  // Confirm the table exists — the schema may not include every one of these
  // in every environment (crisis_review is optional in older schemas).
  const exists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  if (!exists) {
    console.log(`- ${table}: table not present, skipping`);
    continue;
  }

  const rows = db.prepare(`SELECT ${idCol} AS id, ${textCol} AS body FROM ${table}`).all();
  const update = db.prepare(`UPDATE ${table} SET ${textCol} = ? WHERE ${idCol} = ?`);

  let encrypted = 0;
  let alreadyEncrypted = 0;
  let empty = 0;

  const applyAll = db.transaction(() => {
    for (const row of rows) {
      if (row.body == null || row.body === '') { empty++; continue; }
      if (isEncrypted(row.body)) { alreadyEncrypted++; continue; }
      if (!DRY_RUN) update.run(encrypt(row.body), row.id);
      encrypted++;
    }
  });
  applyAll();

  totals.scanned += rows.length;
  totals.encrypted += encrypted;
  totals.alreadyEncrypted += alreadyEncrypted;
  totals.empty += empty;

  console.log(
    `✓ ${table.padEnd(28)} scanned=${String(rows.length).padStart(6)}  ` +
    `encrypted=${String(encrypted).padStart(6)}  ` +
    `already=${String(alreadyEncrypted).padStart(6)}  ` +
    `empty=${String(empty).padStart(6)}`,
  );
}

console.log('');
console.log(
  `TOTAL  scanned=${totals.scanned}  encrypted=${totals.encrypted}  ` +
  `already=${totals.alreadyEncrypted}  empty=${totals.empty}` +
  `${DRY_RUN ? '  (dry-run: nothing written)' : ''}`,
);

db.close();
