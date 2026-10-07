// scripts/broadcast.js
// One-off admin push broadcast. Sends two messages 15 minutes apart to every
// saved push subscription. Mirrors the broadcastPush() pattern in server.js:
// same getAllPushUsers query, same invalid-JSON / 404 / 410 dead-sub cleanup.
//
// IMPORTANT: this reads the SAME DB + VAPID keys the app uses, resolved the
// same way as server.js. Run it where the production data lives:
//   - Locally  -> hits app/mentally-prepare.db + app/.vapid-keys.json
//   - Railway  -> set DATA_DIR/RAILWAY_VOLUME_MOUNT_PATH (=/data/db) to hit prod
//
// Usage: node scripts/broadcast.js

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const webpush = require('web-push');

const IS_PROD = process.env.NODE_ENV === 'production';
const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (IS_PROD ? '/data/db' : APP_ROOT);

const DB_PATH = path.join(DATA_DIR, 'mentally-prepare.db');
const VAPID_PATH = path.join(DATA_DIR, '.vapid-keys.json');

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const MESSAGE_ONE = "your match doesn't know your name. but they've been showing up. have you?";
const MESSAGE_TWO = "you signed up because something needed to be said. it still does.";

// --- DB ---
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const getAllPushUsers = db.prepare('SELECT id, push_subscription, push_preferences, last_active_date, created_at, push_last_sent_at, push_last_sent_type FROM users WHERE push_subscription IS NOT NULL');
const updatePushSub = db.prepare("UPDATE users SET push_subscription = ?, push_subscription_updated_at = datetime('now') WHERE id = ?");

// --- VAPID (same loading as server.js) ---
let vapidKeys;
if (fs.existsSync(VAPID_PATH)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2));
  console.log('Generated VAPID keys at', VAPID_PATH);
}
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  console.error('VAPID keys missing public/private key');
  process.exit(1);
}
webpush.setVapidDetails(
  'mailto:' + (process.env.CONTACT_EMAIL || 'hello@mymentallyprepare.com'),
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// --- broadcast (mirrors broadcastPush in server.js) ---
async function broadcastPush(message) {
  const rows = getAllPushUsers.all();
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    let subscription;
    try {
      subscription = JSON.parse(row.push_subscription);
    } catch (e) {
      updatePushSub.run(null, row.id);
      console.warn('Push subscription invalid, cleared for user', row.id);
      failed++;
      continue;
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: 'Mentally Prepare',
        body: message,
        url: '/app',
        tag: 'mp-broadcast'
      }));
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        updatePushSub.run(null, row.id);
        console.warn('Push subscription expired, cleared for user', row.id);
      } else {
        console.error('Broadcast push failed', { userId: row.id, reason: e && e.message ? e.message : e });
      }
      failed++;
    }
  }
  return { sent, failed, total: rows.length };
}

(async function run() {
  console.log('DB:', DB_PATH);
  console.log('Sending broadcast #1...');
  const first = await broadcastPush(MESSAGE_ONE);
  console.log('Broadcast #1 result:', first);

  console.log('Waiting 15 minutes before broadcast #2...');
  setTimeout(async () => {
    console.log('Sending broadcast #2...');
    const second = await broadcastPush(MESSAGE_TWO);
    console.log('Broadcast #2 result:', second);
    db.close();
    console.log('Done.');
    process.exit(0);
  }, FIFTEEN_MINUTES);
})();
