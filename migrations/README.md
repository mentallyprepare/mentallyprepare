# Migrations

Versioned tracked SQL migrations. The runner is `lib/migrations.js`. The CLI is `scripts/migrate.js`. The server calls the runner automatically at boot; the CLI is for local inspection and for the rare case where you want to apply migrations without booting the app.

## Naming

`NNNN_slug.sql` — four-digit zero-padded prefix, lower-case slug (underscores or hyphens fine).

- `0001_add_admin_users.sql`
- `0002_index_entries_by_user_day.sql`

Discovery is filename-sorted, so ordering is lexicographic on the prefix.

## Writing a migration

- Plain SQL. Multi-statement files are fine; the whole file runs inside a single transaction.
- Prefer additive changes (`ADD COLUMN`, new tables, new indexes). SQLite makes `DROP COLUMN` painful and `ALTER TABLE ... ALTER COLUMN` unavailable; a rewrite-table-and-copy dance is usually what those look like.
- Keep migrations idempotent-friendly where the SQL supports it (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) — the runner also refuses to re-apply, but the belt+braces makes rerunning against a partially-applied DB safer.
- Comments are welcome. `--` and `/* */` are both fine.

## Once applied, migrations are immutable

The runner stores a sha256 checksum of each file when it applies. Editing an applied migration file changes the checksum, and the runner refuses to boot on the drift with a hard error. If you need to fix something an old migration got wrong, land a new migration on top instead of editing history.

## Not this system

The `ensureColumn(...)` calls in `server.js:673` are the pre-runner pattern — they add columns idempotently by swallowing "duplicate column" errors. They stay put; the runner is for **new** schema changes. Don't port existing ensureColumn calls into migrations — you would be creating a checksum for a change that already applied to production and risking a false drift alarm.

## Local usage

```bash
# See what's applied, what's pending
node scripts/migrate.js
node scripts/migrate.js status

# Just the pending ones
node scripts/migrate.js pending

# Apply pending migrations
node scripts/migrate.js apply

# Dry-run (list what would apply)
node scripts/migrate.js apply --dry-run
```

Production: the server runs the migration set at boot automatically. Manual `apply` in production requires `--yes` to prevent accidental schema changes.
