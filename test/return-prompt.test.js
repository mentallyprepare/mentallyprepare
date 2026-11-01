'use strict';

const assert = require('assert');
const express = require('express');
const Database = require('better-sqlite3');
const { registerReturnPromptRoutes } = require('../routes/return-prompt');
const { returnPromptEmail } = require('../lib/email');

async function main() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')), last_active_date TEXT, account_status TEXT DEFAULT 'active', email_verified INTEGER DEFAULT 1, push_preferences TEXT, archetype TEXT, last_login_at TEXT, auth_reset_at INTEGER);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, user_id INTEGER);
    CREATE TABLE analytics_events (id INTEGER PRIMARY KEY, user_id INTEGER, event_name TEXT, created_at TEXT);
    CREATE TABLE reauth_followup_deliveries (user_id INTEGER PRIMARY KEY, status TEXT, attempted_at TEXT);
    CREATE TABLE return_prompt_deliveries (user_id INTEGER PRIMARY KEY, email TEXT, name TEXT, status TEXT DEFAULT 'pending', attempted_at TEXT, next_attempt_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE admin_audit (actor_admin_id INTEGER, actor_label TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata TEXT);
  `);
  const addUser = db.prepare(`INSERT INTO users (id, name, email, email_verified, push_preferences, auth_reset_at) VALUES (?, ?, ?, ?, ?, strftime('%s', 'now', '-10 days'))`);
  const addFollowUp = db.prepare("INSERT INTO reauth_followup_deliveries (user_id, status, attempted_at) VALUES (?, 'sent', datetime('now', '-8 days'))");
  for (let id = 1; id <= 105; id++) {
    addUser.run(id, id === 1 ? '<script>bad</script>' : `Person ${id}`, `person${id}@example.test`, id === 103 ? 0 : 1,
      JSON.stringify({ emailReminders: id !== 104 }));
    addFollowUp.run(id);
  }
  db.prepare("UPDATE users SET last_login_at = datetime('now'), archetype = 'connector' WHERE id = 105").run();
  db.prepare('INSERT INTO entries (user_id) VALUES (1)').run();
  const sends = [];
  const app = express();
  app.use(express.json());
  const pass = (req, res, next) => next();
  const admin = (req, res, next) => { req.admin = { id: 1, email: 'founder@example.test', role: req.headers['x-role'] || 'admin', legacy: req.headers['x-legacy'] === '1' }; next(); };
  registerReturnPromptRoutes(app, { db, rootDir: __dirname, requireAdmin: admin, authLimiter: pass,
    emailServiceEnabled: true, getReminderUnsubscribeUrl: userId => `https://example.test/unsubscribe/${userId}`,
    sendReturnPrompt: async (...args) => sends.push(args) });
  const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const preview = await fetch(`${base}/admin/return-prompt/preview`).then(res => res.json());
    assert.strictEqual(preview.eligible, 100, 'recipient cap');
    assert.strictEqual(preview.recipients[0].userId, 1, 'previous writer prioritized');
    assert.ok(preview.recipients.every(row => ![103, 104, 105].includes(row.userId)), 'unverified, opted-out and returned users excluded');
    assert.ok(preview.sample.text.includes('What did you almost say'));
    assert.ok(!returnPromptEmail('<script>bad</script>', 'https://example.test/unsubscribe').html.includes('Hi <script>'));
    const body = JSON.stringify({ confirmation: 'SEND RETURN PROMPT', recipientHash: preview.recipientHash });
    const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    assert.strictEqual((await fetch(`${base}/admin/return-prompt/start`, { ...opts, headers: { ...opts.headers, 'x-role': 'support' } })).status, 403);
    assert.strictEqual((await fetch(`${base}/admin/return-prompt/start`, { ...opts, headers: { ...opts.headers, 'x-legacy': '1' } })).status, 403);
    assert.strictEqual((await fetch(`${base}/admin/return-prompt/start`, { ...opts, body: JSON.stringify({ confirmation: 'SEND RETURN PROMPT', recipientHash: 'old' }) })).status, 409);
    const started = await fetch(`${base}/admin/return-prompt/start`, opts);
    assert.strictEqual(started.status, 202);
    assert.strictEqual((await started.json()).queued, 100);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM return_prompt_deliveries').get().n, 100);
    for (let i = 0; i < 100 && !sends.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(sends.length, 1);
    assert.deepStrictEqual(sends[0], ['person1@example.test', '<script>bad</script>', 'https://example.test/unsubscribe/1']);
    assert.strictEqual((await fetch(`${base}/admin/return-prompt/start`, opts)).status, 409, 'duplicate campaign blocked');
    db.prepare("UPDATE users SET push_preferences = '{\"emailReminders\":false}' WHERE id = 2").run();
    for (let i = 0; i < 120 && db.prepare('SELECT status FROM return_prompt_deliveries WHERE user_id = 2').get().status !== 'skipped'; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.strictEqual(db.prepare('SELECT status FROM return_prompt_deliveries WHERE user_id = 2').get().status, 'skipped', 'pre-send opt-out is honored');
    assert.ok(!sends.some(args => args[0] === 'person2@example.test'));
    const after = await fetch(`${base}/admin/return-prompt/preview`).then(res => res.json());
    assert.strictEqual(after.eligible, 0, 'campaign cannot exceed 100 total recipients');
    console.log('Return prompt audience, cap, approval, dedupe and delivery checks passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
