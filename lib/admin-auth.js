'use strict';

// Admin authentication + audit trail.
//
// The prior model: a single ADMIN_PASSWORD env var, shared across everyone who
// had operator access, hashed with sha256 and compared against a header on
// every admin request. Every action looked the same in logs — no way to know
// who suspended a user or removed a comment.
//
// This module gives each operator a named account in `admin_users` (migration
// 0001), a role (admin | moderator | support), a bcrypted password, and an
// append-only `admin_audit` trail keyed by the acting admin's id. Sessions
// are the express-session store the rest of the app uses; the admin id sits
// alongside the user id and never mixes with regular auth.
//
// The legacy header path stays working as a grace-period fallback wired into
// server.js's requireAdmin so ops scripts and the current admin UI keep
// working while the UI is migrated. Uses of that path are logged loudly.
//
// This module is intentionally auth-only — no HTTP handlers. Routes live in
// routes/admin.js so the app-shaped code stays together.

const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'moderator', 'support'];
const BCRYPT_ROUNDS = 12;

function isRole(x) { return typeof x === 'string' && ROLES.includes(x); }

/**
 * Create a named admin. `password` is bcrypted here — never stored raw.
 * Throws on duplicate email or invalid role. Returns { id, email, role }.
 */
function createAdmin(db, { email, password, role = 'moderator' }) {
  const emailClean = String(email || '').trim().toLowerCase();
  if (!emailClean || !/^\S+@\S+\.\S+$/.test(emailClean)) {
    throw new Error('createAdmin: email is required and must look like an email');
  }
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('createAdmin: password must be at least 12 characters');
  }
  if (!isRole(role)) {
    throw new Error(`createAdmin: role must be one of ${ROLES.join(', ')}`);
  }
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const info = db.prepare(
    'INSERT INTO admin_users (email, password_hash, role, active) VALUES (?, ?, ?, 1)',
  ).run(emailClean, hash, role);
  return { id: info.lastInsertRowid, email: emailClean, role };
}

/**
 * If admin_users has zero active rows and ADMIN_BOOTSTRAP_EMAIL +
 * ADMIN_BOOTSTRAP_PASSWORD are set in the environment, create the first admin
 * account. Called from server.js right after migrations run.
 *
 * Idempotent: once any active admin exists, this is a no-op. The bootstrap
 * env vars can then be removed (they never need to sit in prod after the
 * first login lands).
 *
 * Returns { bootstrapped: boolean, admin? }.
 */
function bootstrapFirstAdmin(db, { log = console.log } = {}) {
  const countRow = db.prepare("SELECT COUNT(*) AS c FROM admin_users WHERE active = 1").get();
  if (countRow.c > 0) return { bootstrapped: false };

  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    // No bootstrap creds — the operator wants to seed manually or via the
    // grace-period ADMIN_PASSWORD path. Do nothing loud here; boot proceeds.
    return { bootstrapped: false };
  }

  try {
    const admin = createAdmin(db, { email, password, role: 'admin' });
    log(`✓ bootstrapped first admin: ${admin.email} (role=admin, id=${admin.id})`);
    log('  ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD can now be removed from the environment.');
    return { bootstrapped: true, admin };
  } catch (err) {
    log(`✗ admin bootstrap failed: ${err.message}`);
    return { bootstrapped: false };
  }
}

/**
 * Verify a login. Constant-time via bcrypt.compareSync; a missing email still
 * spends the bcrypt round so the response time doesn't leak which emails are
 * registered.
 *
 * Returns { ok: true, admin } on success, { ok: false } on any failure.
 */
function verifyCredentials(db, email, password) {
  const emailClean = String(email || '').trim().toLowerCase();
  const row = db.prepare(
    'SELECT id, email, password_hash, role, active FROM admin_users WHERE email = ?',
  ).get(emailClean);

  // Always spend a hash comparison, even on unknown email, so the failure
  // path takes similar time to the success path.
  const hashToCheck = (row && row.password_hash) || '$2b$12$fillfillfillfillfillfilluCkGmlrN2fq/nBK/w7pk7yOZgOzTGe';
  const match = bcrypt.compareSync(String(password || ''), hashToCheck);

  if (!row || !row.active || !match) return { ok: false };
  return { ok: true, admin: { id: row.id, email: row.email, role: row.role } };
}

/**
 * Append an audit row. Never throws — a broken audit write must not knock
 * over the underlying admin action; it logs to console and continues.
 *
 * `req` may be null (for bootstrap or CLI events). `opts.actor` is only used
 * when the actor is not an authenticated admin (e.g. a failed login, where
 * we want to log the attempted email rather than a session id).
 */
function logAdminAction(db, req, action, opts = {}) {
  try {
    const admin = (req && req.admin) || null;
    const actor_admin_id = admin && typeof admin.id === 'number' ? admin.id : null;
    const actor_label = opts.actor
      || (admin ? `${admin.email} (${admin.role})` : 'unknown');
    const target_type = opts.targetType || null;
    const target_id = opts.targetId != null ? String(opts.targetId) : null;
    const metadata = opts.metadata ? JSON.stringify(opts.metadata) : null;

    db.prepare(
      'INSERT INTO admin_audit (actor_admin_id, actor_label, action, target_type, target_id, metadata) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(actor_admin_id, actor_label, action, target_type, target_id, metadata);
  } catch (err) {
    // Never bubble an audit-log write failure — the underlying action stands.
    console.error('admin_audit write failed:', err && err.message ? err.message : err);
  }
}

/**
 * Update last_login_at. Called after a successful session establishment.
 * Silent on failure — timestamp is a nice-to-have, not a critical write.
 */
function markLogin(db, adminId) {
  try {
    db.prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?").run(adminId);
  } catch {}
}

module.exports = {
  ROLES,
  createAdmin,
  bootstrapFirstAdmin,
  verifyCredentials,
  logAdminAction,
  markLogin,
};
