-- First real migration through the runner.
-- Adds the admin_users + admin_audit tables §3 (RBAC + audit trail) will use.
-- Intentionally small so it also serves as the runner's smoke test in prod.

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'moderator' CHECK(role IN ('admin', 'moderator', 'support')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_users_email_active
  ON admin_users(email, active);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_admin_id INTEGER REFERENCES admin_users(id),
  actor_label TEXT NOT NULL,           -- human-readable actor identity, snapshot at write time
  action TEXT NOT NULL,                -- e.g. 'user.suspend', 'report.resolve'
  target_type TEXT,                    -- e.g. 'user', 'report', 'match'
  target_id TEXT,                      -- string so it can hold non-integer ids too
  metadata TEXT,                       -- JSON blob for action-specific context
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor
  ON admin_audit(actor_admin_id, created_at DESC);
