'use strict';

// admin_users + admin_audit behavior. Uses an in-memory SQLite and applies
// migration 0001 directly so the tests aren't coupled to boot order.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  ROLES,
  createAdmin,
  bootstrapFirstAdmin,
  verifyCredentials,
  logAdminAction,
  markLogin,
} = require('../lib/admin-auth');

function freshDb() {
  const db = new Database(':memory:');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '0001_demo_admin_users.sql'),
    'utf8',
  );
  db.exec(sql);
  return db;
}

function withEnv(overrides, fn) {
  const backup = {};
  for (const k of Object.keys(overrides)) {
    backup[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(backup)) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  }
}

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('ROLES lists the three intended roles', () => {
  assert.deepStrictEqual(new Set(ROLES), new Set(['admin', 'moderator', 'support']));
});

test('createAdmin stores a bcrypted hash, never the raw password', () => {
  const db = freshDb();
  const admin = createAdmin(db, { email: 'A@Ex.com', password: 'a-secure-passphrase' });
  assert.strictEqual(admin.email, 'a@ex.com', 'email is normalized to lower-case');
  assert.strictEqual(admin.role, 'moderator', 'default role is moderator');
  const row = db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(admin.id);
  assert.ok(row.password_hash.startsWith('$2'), 'bcrypt hash prefix');
  assert.ok(!row.password_hash.includes('a-secure-passphrase'), 'raw password never stored');
});

test('createAdmin rejects short passwords, bad emails, and unknown roles', () => {
  const db = freshDb();
  assert.throws(() => createAdmin(db, { email: 'x@y.com', password: 'short' }), /12 characters/);
  assert.throws(() => createAdmin(db, { email: 'not-an-email', password: 'a-secure-passphrase' }), /look like an email/);
  assert.throws(
    () => createAdmin(db, { email: 'x@y.com', password: 'a-secure-passphrase', role: 'owner' }),
    /role must be one of/,
  );
});

test('createAdmin refuses a duplicate email (unique constraint)', () => {
  const db = freshDb();
  createAdmin(db, { email: 'a@ex.com', password: 'a-secure-passphrase' });
  assert.throws(() => createAdmin(db, { email: 'a@ex.com', password: 'another-passphrase' }));
});

test('verifyCredentials returns ok on match and hides failure reasons', () => {
  const db = freshDb();
  createAdmin(db, { email: 'a@ex.com', password: 'right-answer-here', role: 'admin' });
  const good = verifyCredentials(db, 'A@ex.com', 'right-answer-here');
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.admin.email, 'a@ex.com');
  assert.strictEqual(good.admin.role, 'admin');
  // Wrong password
  assert.strictEqual(verifyCredentials(db, 'a@ex.com', 'wrong').ok, false);
  // Unknown email still spends a bcrypt round (returns ok:false, no throw)
  assert.strictEqual(verifyCredentials(db, 'ghost@ex.com', 'anything').ok, false);
  // Inactive admin can't log in
  db.prepare("UPDATE admin_users SET active = 0 WHERE email = ?").run('a@ex.com');
  assert.strictEqual(verifyCredentials(db, 'a@ex.com', 'right-answer-here').ok, false);
});

test('bootstrapFirstAdmin creates the first admin when env is set and table empty', () => {
  const db = freshDb();
  const result = withEnv(
    { ADMIN_BOOTSTRAP_EMAIL: 'first@ex.com', ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-secret-1' },
    () => bootstrapFirstAdmin(db, { log: () => {} }),
  );
  assert.strictEqual(result.bootstrapped, true);
  assert.strictEqual(result.admin.role, 'admin');
  const row = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get();
  assert.strictEqual(row.c, 1);
});

test('bootstrapFirstAdmin is a no-op when an admin already exists', () => {
  const db = freshDb();
  createAdmin(db, { email: 'existing@ex.com', password: 'a-secure-passphrase' });
  const result = withEnv(
    { ADMIN_BOOTSTRAP_EMAIL: 'first@ex.com', ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-secret-1' },
    () => bootstrapFirstAdmin(db, { log: () => {} }),
  );
  assert.strictEqual(result.bootstrapped, false);
  const row = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get();
  assert.strictEqual(row.c, 1);
});

test('bootstrapFirstAdmin without env is a silent no-op — legacy ADMIN_PASSWORD path remains', () => {
  const db = freshDb();
  const result = withEnv(
    { ADMIN_BOOTSTRAP_EMAIL: undefined, ADMIN_BOOTSTRAP_PASSWORD: undefined },
    () => bootstrapFirstAdmin(db, { log: () => {} }),
  );
  assert.strictEqual(result.bootstrapped, false);
});

test('logAdminAction writes a row with actor snapshot + metadata', () => {
  const db = freshDb();
  const admin = createAdmin(db, { email: 'a@ex.com', password: 'a-secure-passphrase' });
  const req = { admin: { id: admin.id, email: admin.email, role: admin.role } };
  logAdminAction(db, req, 'user.suspend', {
    targetType: 'user',
    targetId: 42,
    metadata: { reason: 'spam' },
  });
  const row = db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(row.actor_admin_id, admin.id);
  assert.strictEqual(row.actor_label, 'a@ex.com (moderator)');
  assert.strictEqual(row.action, 'user.suspend');
  assert.strictEqual(row.target_type, 'user');
  assert.strictEqual(row.target_id, '42');
  assert.deepStrictEqual(JSON.parse(row.metadata), { reason: 'spam' });
});

test('logAdminAction accepts a null request (bootstrap / CLI / failed login)', () => {
  const db = freshDb();
  logAdminAction(db, null, 'admin.login_failed', { actor: 'ghost@ex.com' });
  const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'admin.login_failed'").get();
  assert.strictEqual(row.actor_admin_id, null);
  assert.strictEqual(row.actor_label, 'ghost@ex.com');
});

test('logAdminAction never throws even if the DB refuses the write', () => {
  const db = freshDb();
  db.exec('DROP TABLE admin_audit');
  // Should log to console and continue, not throw.
  logAdminAction(db, null, 'anything');
});

test('markLogin updates last_login_at without throwing on a missing id', () => {
  const db = freshDb();
  const admin = createAdmin(db, { email: 'a@ex.com', password: 'a-secure-passphrase' });
  markLogin(db, admin.id);
  const row = db.prepare('SELECT last_login_at FROM admin_users WHERE id = ?').get(admin.id);
  assert.ok(row.last_login_at, 'last_login_at set');
  markLogin(db, 99999); // no throw
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
  console.log(`\n${passed}/${tests.length} admin-auth tests passed.`);
})();
