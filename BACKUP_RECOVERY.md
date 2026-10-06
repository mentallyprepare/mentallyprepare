# Encrypted backup operations

## Current schedule and evidence

- A local SQLite snapshot is made daily at 04:00 IST. Local `.db` snapshots are kept for seven days on the Railway volume; they are plaintext and disappear with that volume.
- When offsite settings are complete, the snapshot is encrypted with AES-256-GCM and uploaded to the private S3-compatible bucket. The last successful object key and timestamps are recorded in `backup-status.json` beside the database. This metadata file contains no credential or user writing and is mode `0600`.
- Every Monday at 05:00 IST, the app downloads the latest recorded encrypted object, decrypts it to a private temporary directory, checks SQLite integrity and the `users` table, and removes the temporary files. This is a restore check, not a full application boot or login rehearsal.
- At 05:30 IST daily, the app checks the record. It reports failure if the last offsite upload is over 25 hours old, the last restore check is over eight days old, or the latest attempt failed. Failures go to Railway logs and to Sentry **only if `SENTRY_DSN` is configured and alert routing is enabled**. Verify that routing before relying on notifications. The status file lives on the Railway volume, so an external uptime/deployment monitor is still required to detect a stopped service or lost volume.

## Operator checks

From a private Railway service shell, run `npm run backup:health`. Exit code 0 means the recorded upload and restore check are current; exit code 1 means investigate. `npm run backup:verify` immediately downloads and checks the latest recorded offsite object. It never overwrites the running database.

To test actual application recovery, use `node scripts/restore-backup.js downloaded.db.enc restored.db` in an isolated environment with the matching `BACKUP_ENCRYPTION_KEY`, then start a separate app with `DB_PATH` pointing to `restored.db`. Verify `/api/ready` and a synthetic login in that isolated copy. Do not boot the restored database as the live service until the recovery decision is approved.

## Retention and recovery targets to approve

- Proposed offsite retention: **30 days** in the B2 bucket, scoped to the backup object prefix. Configure and inspect bucket lifecycle rules in Backblaze after Rashmi approves permanent expiration. Confirm how current and prior object versions are handled before enabling deletion. No remote object deletion is performed by this code.
- Proposed recovery point objective: **24 hours**, matching the daily schedule. This is a target, not a guarantee; a failed or missed daily upload increases data loss exposure. The 25-hour health threshold is intended to detect that condition at the next 05:30 IST check.
- Proposed recovery time objective: **4 hours** after an incident is declared. This has not been measured in a full replacement-service recovery and must remain unverified until a timed drill covers bucket access, key retrieval, restore, deployment, DNS and login.
- Keep the encryption key outside both the database volume and backup bucket. Losing it makes offsite objects unreadable. Restrict bucket read/write access and rotate exposed keys through a reviewed recovery plan.

## Release checks

Before deploying this change, confirm `SENTRY_DSN` and alert routing on the live service, and run the full local suite. After approval and deployment, run one manual backup, `npm run backup:verify`, and `npm run backup:health` in Railway. Check the expected status without printing credentials, tokens or private rows. A separate copy must still be booted and logged into after material schema or authentication changes.
