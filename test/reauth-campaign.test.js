'use strict';

const assert = require('assert');
const express = require('express');
const Database = require('better-sqlite3');
const { registerAdminRoutes } = require('../routes/admin');
const { signInAgainEmail } = require('../email-templates');

async function main() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, account_status TEXT DEFAULT 'active', auth_version INTEGER DEFAULT 0, auth_reset_at INTEGER DEFAULT 0, archetype TEXT, scores TEXT, switch_count INTEGER DEFAULT 0, last_active_date TEXT, push_preferences TEXT);
    CREATE TABLE matches (id INTEGER PRIMARY KEY, user1_id INTEGER, user2_id INTEGER, started_at TEXT, archived_at TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, user_id INTEGER, match_id INTEGER, day INTEGER, text TEXT, mood TEXT, prompt TEXT, created_at TEXT);
    CREATE TABLE waiting_entries (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT);
    CREATE TABLE tonights_question_entries (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT);
    CREATE TABLE daily_notes (id INTEGER PRIMARY KEY, user_id INTEGER, landed TEXT);
    CREATE TABLE archived_user_records (id INTEGER PRIMARY KEY, user_id INTEGER, source TEXT, content_json TEXT, archived_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE reauth_campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), started_by TEXT, status TEXT DEFAULT 'sending', total INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0);
    CREATE TABLE reauth_campaign_deliveries (campaign_id INTEGER, user_id INTEGER, email TEXT, name TEXT, status TEXT DEFAULT 'pending', attempted_at TEXT, PRIMARY KEY(campaign_id, user_id));
    CREATE TABLE admin_audit (actor_admin_id INTEGER, actor_label TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata TEXT);
  `);
  db.prepare('INSERT INTO users (id, name, email) VALUES (1, ?, ?)').run('<script>bad</script>', 'a@example.test');
  db.prepare('INSERT INTO users (id, name, email) VALUES (2, ?, ?)').run('B', 'bad address');
  db.prepare("INSERT INTO users (id, name, email, account_status) VALUES (3, 'C', 'c@example.test', 'deleted')").run();
  db.prepare("UPDATE users SET archetype = 'connector', scores = '{}', switch_count = 2, push_preferences = '{\"enabled\":false,\"emailReminders\":false}' WHERE id IN (1, 2)").run();
  db.prepare("INSERT INTO matches (id, user1_id, user2_id, started_at) VALUES (1, 1, 2, datetime('now'))").run();
  db.prepare("INSERT INTO entries (user_id, match_id, day, text) VALUES (1, 1, 1, 'private note')").run();
  db.prepare("INSERT INTO waiting_entries (user_id, text) VALUES (2, 'older waiting note')").run();

  const delivered = [];
  const app = express();
  app.use(express.json());
  const pass = (req, res, next) => next();
  const admin = (req, res, next) => { req.admin = { id: 1, email: 'founder@example.test', role: req.headers['x-role'] || 'admin', legacy: req.headers['x-legacy'] === '1' }; next(); };
  registerAdminRoutes(app, { db, rootDir: __dirname, authLimiter: pass, requireAdmin: admin,
    emailServiceEnabled: true, sendSignInAgain: async (email, name) => { delivered.push({ email, name }); } });
  const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const preview = await fetch(`${base}/admin/reauth-campaign/preview`).then(r => r.json());
    assert.strictEqual(preview.totalAccounts, 2);
    assert.strictEqual(preview.recipientCount, 1);
    assert.strictEqual(preview.skippedCount, 1);
    assert.deepStrictEqual(preview.recipients, [{ userId: 1, email: 'a@example.test' }]);
    assert.strictEqual(preview.canStart, true);
    assert.deepStrictEqual(preview.freshStart, { activeMatches: 1, matchEntries: 1, standaloneReflections: 1 });
    assert.ok(preview.sampleHtml.includes('Sign in to your space'));
    assert.ok(!signInAgainEmail('<script>bad</script>').includes('Hi <script>'));

    const denied = await fetch(`${base}/admin/reauth-campaign/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'support' }, body: JSON.stringify({ confirmation: 'REQUIRE SIGN-IN' }) });
    assert.strictEqual(denied.status, 403);
    const legacy = await fetch(`${base}/admin/reauth-campaign/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-legacy': '1' }, body: JSON.stringify({ confirmation: 'REQUIRE SIGN-IN' }) });
    assert.strictEqual(legacy.status, 403);
    const missing = await fetch(`${base}/admin/reauth-campaign/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(db.prepare('SELECT SUM(auth_version) AS value FROM users').get().value, 0);

    const started = await fetch(`${base}/admin/reauth-campaign/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'REQUIRE SIGN-IN' }) });
    assert.strictEqual(started.status, 202);
    assert.strictEqual((await started.json()).queued, 1);
    assert.deepStrictEqual(db.prepare('SELECT id, auth_version FROM users ORDER BY id').all(), [{ id: 1, auth_version: 1 }, { id: 2, auth_version: 1 }, { id: 3, auth_version: 0 }]);
    assert.ok(db.prepare('SELECT archived_at FROM matches WHERE id = 1').get().archived_at);
    assert.strictEqual(db.prepare('SELECT text FROM entries WHERE id = 1').get().text, 'private note', 'matched writing preserved');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM waiting_entries').get().n, 0);
    assert.strictEqual(JSON.parse(db.prepare("SELECT content_json FROM archived_user_records WHERE source = 'waiting'").get().content_json).text, 'older waiting note');
    assert.strictEqual(db.prepare('SELECT archetype FROM users WHERE id = 1').get().archetype, null);
    assert.strictEqual(JSON.parse(db.prepare('SELECT push_preferences FROM users WHERE id = 2').get().push_preferences).emailReminders, true);
    assert.strictEqual(JSON.parse(db.prepare('SELECT push_preferences FROM users WHERE id = 2').get().push_preferences).enabled, false, 'existing push choice preserved');
    for (let i = 0; i < 20 && delivered.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepStrictEqual(delivered, [{ email: 'a@example.test', name: '<script>bad</script>' }]);
    assert.strictEqual(db.prepare('SELECT status FROM reauth_campaigns').get().status, 'completed');
    const after = await fetch(`${base}/admin/reauth-campaign/preview`).then(r => r.json());
    assert.strictEqual(after.deliveries[0].status, 'sent');
    assert.strictEqual(after.canStart, false);
    const duplicate = await fetch(`${base}/admin/reauth-campaign/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'REQUIRE SIGN-IN' }) });
    assert.strictEqual(duplicate.status, 409);
    assert.strictEqual(delivered.length, 1);
    const interrupted = db.prepare("INSERT INTO reauth_campaigns (started_by, total) VALUES ('founder@example.test', 1)").run().lastInsertRowid;
    db.prepare("INSERT INTO reauth_campaign_deliveries (campaign_id, user_id, email, name, status, attempted_at) VALUES (?, 1, 'a@example.test', 'A', 'sending', datetime('now', '-11 minutes'))").run(interrupted);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.strictEqual(db.prepare('SELECT status FROM reauth_campaign_deliveries WHERE campaign_id = ?').get(interrupted).status, 'uncertain');
    assert.strictEqual(db.prepare('SELECT status FROM reauth_campaigns WHERE id = ?').get(interrupted).status, 'completed_with_errors');
    assert.strictEqual(delivered.length, 1, 'uncertain delivery must not be resent automatically');
    console.log('Re-sign-in campaign preview, permission, dedupe and delivery checks passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
