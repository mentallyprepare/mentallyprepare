# Mentally Prepare

Anonymous 21-day journaling webapp for college students, built with Node.js, Express, SQLite, and plain frontend assets.

## Stack
- Node.js 18+
- Express
- better-sqlite3
- express-session + connect-sqlite3
- SendGrid
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

## Railway notes
- Let Railway deploy this service as a normal Node.js app instead of using a custom Dockerfile
- Set `SESSION_SECRET` as a permanent Railway variable
- Mount a persistent volume at `/data/db`
- Keep `DATA_DIR=/data/db`
- Do not set `PORT` manually in Railway; Railway provides it automatically
- Verify `/api/ready` after deploy

## Deployment manifest
If you deploy from a curated file list, make sure `routes/`, `lib/`, `email-service.js`, and `email-templates.js` are included. See `webapp-files.txt`.
