# Node.js Web App: Daily Reminder Service

## Overview
This project is a Node.js web application designed to send daily reminders to users. It features a clean, modern UI, robust backend, and is ready for deployment on cloud platforms like Railway and Azure. The app is fully branded, accessible, and follows best practices for maintainability and scalability.

## Features
- **Daily Reminders:** Automatically sends daily notifications to users.
- **Modern UI:** Responsive, accessible, and branded interface.
- **Cloud Ready:** Includes deployment files for Railway, Azure, and Docker.
- **Manifest & PWA:** Supports web app manifest and service worker for installability.
- **Easy Configuration:** All settings managed via environment variables and config files.

## Project Structure
- `server.js` — Main Express server.
- `send-daily-reminders.js` — Script for sending reminders.
- `public/` — Static frontend assets (HTML, CSS, JS, logo, manifest, etc.).
- `package.json` — Project dependencies and scripts.
- `webapp-files.txt` — Deployment manifest listing all source files.

## Deployment
The app is ready for deployment on platforms like Railway, Azure, or any Docker-compatible service. See the deployment files (`Dockerfile`, `railway.toml`, etc.) and the manifest for details.

## Configuration
Before launching the server, set `SENDGRID_API_KEY` and `SENDGRID_FROM` (or `EMAIL_USER` if you still use SMTP). SendGrid requires that the `FROM` address is verified on your account.

## Getting Started
1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Start the server with `node server.js` or `npm start`.
4. Access the app at `http://localhost:3000` (default).

## License
MIT License. See LICENSE file for details.
