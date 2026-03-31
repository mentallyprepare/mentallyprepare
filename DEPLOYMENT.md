# Deployment Checklist for Mentally Prepare App

## Required files in the deploy
- `server.js`
- `routes/`
- `public/`
- `lib/`
- `email-service.js`
- `email-templates.js`
- `send-daily-reminders.js`
- `package.json`
- `package-lock.json`

## Railway production checklist
- Railway can deploy this service with the repo-root `Dockerfile`
- Set `SESSION_SECRET` as a permanent Railway variable
- Set `ADMIN_PASSWORD`, `SENDGRID_API_KEY`, `SENDGRID_FROM`, and any payment keys you need
- Mount a Railway persistent volume and point it at `/data/db`
- Leave `DATA_DIR=/data/db`
- Do not hardcode `PORT` in Railway variables; Railway injects it automatically at runtime
- Confirm `/api/ready` reports the expected `dataDir`

## Data persistence notes
- SQLite database lives in `DATA_DIR/mentally-prepare.db`
- Session secret fallback file lives in `DATA_DIR/.session-secret`
- Daily reminder signups are stored in SQLite, not a flat file

## Deploy
1. Push the repo to GitHub
2. Connect the repo to Railway
3. Add the environment variables
4. Attach the persistent volume
5. Deploy and verify `/api/health` and `/api/ready`
