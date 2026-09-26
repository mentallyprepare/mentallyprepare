# Security

The Mentally Prepare backend serves live users who write private material into their journals. Access control, encryption at rest, and audit trails are treated as first-class product features, not bolt-ons.

## Reporting a vulnerability

Email **hello@mymentallyprepare.com** with the word *SECURITY* in the subject line. Include reproduction steps and, if possible, a proof-of-concept request. We aim to acknowledge within 3 business days and to coordinate disclosure with the reporter before a fix is discussed publicly.

Please do not open a public issue for suspected vulnerabilities.

## What we protect

- **Journal entries + drafts + tonight's question + crisis-review evidence + partner comments** — AES-256-GCM at rest via `lib/entry-crypto.js`. Key required in production; the app refuses to boot without it. Reads and writes are wrapped at every callsite; the migration script `scripts/encrypt-existing-entries.js` covers backfill.
- **Admin surface** — named admin accounts in `admin_users`, session-backed `requireAdmin`, append-only `admin_audit` trail (`lib/admin-auth.js`). The legacy shared `ADMIN_PASSWORD` header is being deprecated with a grace-period fallback and a one-shot boot warning on use.
- **User-controlled ids** — every user-space route is session-scoped (`req.session.userId`); a regression test at `test/idor.test.js` fails smoke if a non-admin route ever accepts a target user id in the request body. Full audit at [`security/idor-audit-2026-09-22.md`](security/idor-audit-2026-09-22.md).
- **Schema evolution** — versioned tracked migrations (`lib/migrations.js`) with sha256 checksum drift detection. An applied migration file is immutable; edits are rejected at boot.
- **Session integrity** — `SESSION_SECRET` required in production (no volatile file fallback); session id regenerated on privilege change (login, admin login).
- **Secrets in git** — `.env`, `.session-secret`, `.vapid-keys.json`, `sendgrid.env` are all git-ignored; only `.env.example` is tracked.

## Threat model, briefly

- **Volume theft** (backup exfiltration, provider incident, dev-laptop compromise) → entries protected by encryption at rest; **the key must not live on the DB volume** — store it in Railway's secret manager separately, or the encryption is theatre.
- **Admin credential leak** → moving from a shared password to named accounts with audit means a compromised operator can be revoked and their actions inspected without rotating everyone.
- **IDOR + cross-user access** → session-scoped everywhere; regression fence blocks the classic body-id-swap.
- **Silent schema drift from parallel workstreams** → CODEOWNERS + branch protection require review on `/migrations/`, `/lib/`, `/routes/`, `/server.js`.

## What we do not protect against (yet)

- **End-to-end encryption** — journal text is decrypted in memory during the request. Server operators with process-level access can read plaintext.
- **Compelled disclosure** — an operator with lawful process against the app can be forced to disclose decrypted content. We collect the minimum information that lets the product work.
- **Adversarial insiders** — the `admin_audit` trail is append-only via the runtime API but not tamper-evident against direct DB writes. A malicious admin with DB write access can rewrite history.

## Audit trail

Security-relevant events are recorded to the `admin_audit` table:

- `admin.login`, `admin.login_failed`, `admin.logout` (via `lib/admin-auth.js`)
- Additional mutating admin actions to be wired incrementally — see [ladder §3 follow-ups](https://github.com/mentallyprepare/mentallyprepare/pull/45).

## Repository governance

- `main` requires PR review via branch protection.
- `.github/CODEOWNERS` requires Anushka's review on any change to `server.js`, `lib/`, `routes/`, `migrations/`, `test/`, `security/`, `scripts/`, deploy config, `package.json`, and `.github/` itself.
- The launch ladder tracked in the maintainer's memory captures the current P0/P1/P2/P3 order-of-work and its status.
