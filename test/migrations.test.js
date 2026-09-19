'use strict';

// Every invariant of the migration runner, exercised against a scratch
// in-memory database and a per-test temp directory of .sql files.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { applyMigrations, getStatus } = require('../lib/migrations');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-migrations-'));
}
function scratchDb() {
  return new Database(':memory:');
}
function writeMigration(dir, name, sql) {
  fs.writeFileSync(path.join(dir, name), sql, 'utf8');
}

test('empty directory: no-op, no errors', () => {
  const dir = scratchDir();
  const db = scratchDb();
  const result = applyMigrations(db, { dir });
  assert.deepStrictEqual(result, { applied: [], skipped: [] });
  assert.deepStrictEqual(getStatus(db, { dir }), []);
});

test('applies pending migrations in filename order', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, '0001_create_widgets.sql', 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);');
  writeMigration(dir, '0002_add_widget_name.sql', 'ALTER TABLE widgets ADD COLUMN name TEXT;');

  const result = applyMigrations(db, { dir });
  assert.deepStrictEqual(result.applied, ['0001_create_widgets.sql', '0002_add_widget_name.sql']);
  assert.deepStrictEqual(result.skipped, []);

  // The DDL took effect.
  db.prepare('INSERT INTO widgets (name) VALUES (?)').run('a');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM widgets').get().c, 1);
});

test('rerun skips already-applied migrations', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, '0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  applyMigrations(db, { dir });
  const second = applyMigrations(db, { dir });
  assert.deepStrictEqual(second.applied, []);
  assert.deepStrictEqual(second.skipped, ['0001_a.sql']);
});

test('a failing statement rolls back — no partial state, no tracking row', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, '0001_good.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  writeMigration(dir, '0002_broken.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'); // duplicate
  assert.throws(() => applyMigrations(db, { dir }), /0002_broken\.sql failed/);
  // 0001 stayed applied. 0002 did not.
  const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r => r.name);
  assert.deepStrictEqual(rows, ['0001_good.sql']);
});

test('checksum drift on an already-applied file is a hard error', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, '0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  applyMigrations(db, { dir });
  // Someone edits the file after it applied — a real hazard.
  writeMigration(dir, '0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT);');
  assert.throws(() => applyMigrations(db, { dir }), /checksum drift/);
  // getStatus reports the drift without throwing.
  const [row] = getStatus(db, { dir });
  assert.strictEqual(row.driftDetected, true);
});

test('out-of-order pending is refused — no silent rewind', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, '0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  writeMigration(dir, '0003_c.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
  applyMigrations(db, { dir });
  // Later, someone lands 0002 between 0001 and 0003.
  writeMigration(dir, '0002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
  assert.throws(
    () => applyMigrations(db, { dir }),
    /0003_c\.sql is already applied but an earlier migration is pending/,
  );
});

test('malformed filenames are rejected up front', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, 'add_widgets.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  assert.throws(() => applyMigrations(db, { dir }), /NNNN_slug\.sql/);
});

test('multi-statement migrations run in a single transaction', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, '0001_multi.sql', `
    CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO t (name) VALUES ('one');
    INSERT INTO t (name) VALUES ('two');
    CREATE INDEX idx_t_name ON t (name);
  `);
  applyMigrations(db, { dir });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM t').get().c, 2);
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t_name'"
  ).get();
  assert.ok(idx, 'index created');
});

test('getStatus is read-only and reports applied vs pending', () => {
  const dir = scratchDir();
  const db = scratchDb();
  writeMigration(dir, '0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  writeMigration(dir, '0002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
  applyMigrations(db, { dir });
  writeMigration(dir, '0003_c.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
  const status = getStatus(db, { dir });
  assert.deepStrictEqual(status.map(r => [r.name, r.applied]), [
    ['0001_a.sql', true],
    ['0002_b.sql', true],
    ['0003_c.sql', false],
  ]);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   -', name);
      passed++;
    } catch (err) {
      console.error('FAIL -', name);
      console.error('      ', err && err.message ? err.message : err);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} migrations tests passed.`);
})();
