# Mentally Prepare

Anonymous 21-day journaling webapp for college students, built with Node.js, Express, SQLite, and plain frontend assets.

## Stack
- Node.js 18+
- Express
- better-sqlite3
- express-session + connect-sqlite3
- Optional SMTP email
- Razorpay / Stripe
- Web Push + PWA assets

## Main folders
- `server.js` - app bootstrap, schema creation, middleware, scheduling
- `routes/` - auth, app, admin, payments, waitlist, static pages
- `public/` - landing page, app UI, waitlist page, admin page, CSS, JS, PWA files
- `lib/` - config and email helpers

## Local setup
1. Copy `.env.example` to `.env`
2. Fill in the required secrets
3. Run `npm install`
4. Run `npm start`
5. Open `http://localhost:8080`

## Railway deployment
- Deploys via `railway.toml` → Dockerfile (Node 20-slim + native deps)
- Set `SESSION_SECRET`, `ADMIN_PASSWORD`, Firebase vars, optional SMTP/payment keys
- Mount a persistent volume at `/data/db` and keep `DATA_DIR=/data/db`
- Do not set `PORT` — Railway injects it automatically
- Verify after deploy: `/api/ready`, `/api/health`

### Firebase / Google login
- Firebase Auth → Authorized domains must include `mentally-prepare.firebaseapp.com`, `mymentallyprepare.com`, and `mentallyprepare-production.up.railway.app`
- Google Cloud OAuth redirect URIs must include `https://mentally-prepare.firebaseapp.com/__/auth/handler` and `https://mymentallyprepare.com/__/auth/handler`
- Once the custom-domain redirect URI is approved, set `FIREBASE_USE_SAME_ORIGIN_AUTH_DOMAIN=true` in Railway

### Data persistence
- SQLite database: `DATA_DIR/mentally-prepare.db`
- Session secret fallback: `DATA_DIR/.session-secret`
- Daily backups run at 4am IST. Offsite uploads use an S3 compatible service and require `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, and `BACKUP_ENCRYPTION_KEY`. Generate the encryption key as 32 random bytes encoded in hex and store it outside the database and backup bucket. Uploaded `.db.enc` objects use AES-256-GCM; local snapshots remain plaintext on the Railway volume for seven days. A failed offsite upload reports failure.
- For Backblaze B2, use a private bucket, a bucket-scoped read/write application key, the region shown for that bucket (for example `us-west-004`), and its S3 endpoint (for example `https://s3.us-west-004.backblazeb2.com`). Keep the endpoint without a trailing slash.
- To restore, download a `.db.enc` object, set the same `BACKUP_ENCRYPTION_KEY` in a private local shell, and run `node scripts/restore-backup.js downloaded.db.enc restored.db`. The command refuses to overwrite a file and verifies SQLite integrity. Keep the encryption key safe: losing it makes offsite backups unreadable. Perform a restore drill before relying on this for recovery.
