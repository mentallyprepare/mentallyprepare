'use strict';

// Versioned tracked SQL migrations for the SQLite database.
//
// Why this exists: `server.js` has a home-grown `ensureColumn()` helper and a
// long list of `ensureColumn(...)` calls that add columns idempotently by
// swallowing "duplicate column" errors. That worked for the app's first
// year, but it can't do anything but add columns — no backfills, no
// index-drops, no data migrations, no ordering guarantees. This runner is
// the go-forward pattern; existing `ensureColumn` calls stay as-is.
//
// Convention:
//   * Migrations live in the `migrations/` directory (configurable).
//   * Files named `NNNN_slug.sql` — four-digit zero-padded, lower-kebab.
//     Discovery is filename-sorted, so ordering is lexicographic on the
//     four-digit prefix.
//   * Contents are plain SQL. Multiple statements are fine; each file
//     runs inside a single transaction.
//   * A `_migrations` table tracks which have been applied, when, and their
//     checksum. A checksum drift means the file changed after it applied,
//     which is a hard error — a silent reapply would corrupt state.
//   * Out-of-order pending is a hard error too: if 0002 is unapplied but
//     0003 exists, refuse. Rewinding history is intentional, not silent.
//
// Public surface:
//   applyMigrations(db, options)  — apply every pending file in order
//   getStatus(db, options)        — read-only inventory: applied vs pending
//
// Both live behind a single default export so the server startup path and
// the CLI can share exactly the same code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.resolve(__dirname, '..', 'migrations');
const FILENAME_RE = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT NOT NULL
    );
  `);
}

function discover(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
  const bad = files.filter(f => !FILENAME_RE.test(f));
  if (bad.length) {
    throw new Error(
      `Migration filenames must match NNNN_slug.sql — offending: ${bad.join(', ')}`,
    );
  }
  return files.sort().map(name => {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    return { name, sql, checksum };
  });
}

function readApplied(db) {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT name, applied_at, checksum FROM _migrations ORDER BY name').all();
  return new Map(rows.map(r => [r.name, r]));
}

/**
 * Inventory. Never writes. Every returned entry has:
 *   { name, checksum, applied: boolean, applied_at?, driftDetected?: boolean }
 * `driftDetected` is true when the file's current checksum differs from the
 * one stored when it was applied.
 */
function getStatus(db, { dir = DEFAULT_DIR } = {}) {
  const files = discover(dir);
  const applied = readApplied(db);
  return files.map(f => {
    const record = applied.get(f.name);
    if (!record) return { ...f, applied: false };
    return {
      ...f,
      applied: true,
      applied_at: record.applied_at,
      driftDetected: record.checksum !== f.checksum,
    };
  });
}

/**
 * Apply every pending migration in filename order. Idempotent — re-runs are
 * safe because already-applied files are skipped.
 *
 * Throws on:
 *   * malformed filename (see FILENAME_RE)
 *   * an earlier migration missing when a later one is applied (rewind
 *     without an explicit down-migration)
 *   * a stored checksum that no longer matches the file (silent-drift guard)
 *   * a migration statement that errors — the transaction rolls back and
 *     the `_migrations` row is not written
 *
 * Returns { applied: [names], skipped: [names] }.
 */
function applyMigrations(db, { dir = DEFAULT_DIR, log = () => {} } = {}) {
  const files = discover(dir);
  const applied = readApplied(db);

  // Guard 1 · drift on any already-applied file.
  for (const f of files) {
    const record = applied.get(f.name);
    if (record && record.checksum !== f.checksum) {
      throw new Error(
        `Migration ${f.name} was applied at ${record.applied_at} but its file has changed ` +
        `since (checksum drift). A migration file is immutable once applied — revert the ` +
        `edit or land a new migration on top.`,
      );
    }
  }

  // Guard 2 · out-of-order pending. If any applied migration sits after an
  // unapplied one, someone tried to rewind history.
  let sawUnapplied = false;
  for (const f of files) {
    if (!applied.has(f.name)) sawUnapplied = true;
    else if (sawUnapplied) {
      throw new Error(
        `Migration ${f.name} is already applied but an earlier migration is pending. ` +
        `Refusing to apply out of order.`,
      );
    }
  }

  const result = { applied: [], skipped: [] };
  const insert = db.prepare(
    'INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, datetime(\'now\'), ?)',
  );

  for (const f of files) {
    if (applied.has(f.name)) { result.skipped.push(f.name); continue; }
    // Wrap DDL + the tracking row insert in one transaction so a broken
    // statement never leaves the file marked applied.
    const run = db.transaction(() => {
      db.exec(f.sql);
      insert.run(f.name, f.checksum);
    });
    try {
      run();
      log(`✓ migration applied: ${f.name}`);
      result.applied.push(f.name);
    } catch (err) {
      const wrapped = new Error(`Migration ${f.name} failed: ${err.message}`);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  return result;
}

module.exports = { applyMigrations, getStatus, DEFAULT_DIR };
