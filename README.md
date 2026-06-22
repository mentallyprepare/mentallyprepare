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
- Daily backups run at 4am IST; S3 backup optional (set `BACKUP_S3_*` vars)
