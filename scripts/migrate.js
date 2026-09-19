#!/usr/bin/env node
'use strict';

// CLI wrapper around lib/migrations.js. Same runner the server calls at boot.
//
//   node scripts/migrate.js                # alias for `status`
//   node scripts/migrate.js status         # list applied + pending
//   node scripts/migrate.js pending        # list only pending
//   node scripts/migrate.js apply          # apply pending migrations
//   node scripts/migrate.js apply --dry-run  # list what would apply
//
// Refuses to `apply` in production without --yes so nobody triggers a schema
// change with muscle memory. The startup runner in server.js applies without
// the flag because the deploy pipeline is the explicit ack.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { applyMigrations, getStatus } = require('../lib/migrations');

const IS_PROD = process.env.NODE_ENV === 'production';
const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const DRY = args.includes('--dry-run');
const PROD_ACK = args.includes('--yes');

function resolveDbPath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  const dataDir = process.env.DATA_DIR
    || process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (IS_PROD ? '/data/db' : path.join(__dirname, '..'));
  return path.join(dataDir, 'mentally-prepare.db');
}

const dbPath = resolveDbPath();
if (!fs.existsSync(dbPath)) {
  console.error(`✗ Database not found at ${dbPath}. Set DB_PATH or DATA_DIR.`);
  process.exit(1);
}

console.log(`• Database: ${dbPath}`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function printStatus() {
  const rows = getStatus(db);
  if (!rows.length) { console.log('(no migrations in the directory)'); return; }
  for (const r of rows) {
    const mark = r.applied ? '✓' : '·';
    const when = r.applied ? r.applied_at : 'pending';
    const drift = r.driftDetected ? '  DRIFT' : '';
    console.log(`  ${mark} ${r.name}   ${when}${drift}`);
  }
}

try {
  if (cmd === 'status') {
    printStatus();
  } else if (cmd === 'pending') {
    const pending = getStatus(db).filter(r => !r.applied);
    if (!pending.length) { console.log('(none)'); }
    else pending.forEach(r => console.log(`  · ${r.name}`));
  } else if (cmd === 'apply') {
    const pending = getStatus(db).filter(r => !r.applied);
    if (!pending.length) { console.log('(no pending migrations)'); process.exit(0); }
    if (IS_PROD && !PROD_ACK && !DRY) {
      console.error('✗ NODE_ENV=production and --yes was not passed. Refusing to touch production schema.');
      process.exit(1);
    }
    if (DRY) {
      console.log('Would apply:');
      pending.forEach(r => console.log(`  · ${r.name}`));
      process.exit(0);
    }
    const result = applyMigrations(db, { log: msg => console.log(msg) });
    console.log(`\napplied=${result.applied.length}  skipped=${result.skipped.length}`);
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: migrate.js [status|pending|apply] [--dry-run] [--yes]');
    process.exit(2);
  }
} finally {
  db.close();
}
