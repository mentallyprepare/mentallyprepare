// send-daily-reminders.js
// Sends daily reminder emails to all signed-up users

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { sendEmail } = require('./lib/sendgrid');

const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (IS_PROD ? '/data/db' : __dirname);
const DB_PATH = path.join(DATA_DIR, 'mentally-prepare.db');
const LEGACY_EMAILS_PATH = path.join(__dirname, 'daily-reminder-emails.txt');

const subject = 'Mentally Prepare: Daily Reminder';
const text = 'Take 5 minutes today to write your journal entry. Your prompt is waiting!';

function loadReminderEmails() {
  if (fs.existsSync(DB_PATH)) {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const hasTable = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'reminder_signups'
      `).get();
      if (hasTable) {
        return db.prepare('SELECT email FROM reminder_signups ORDER BY created_at ASC')
          .all()
          .map(row => row.email)
          .filter(Boolean);
      }
    } finally {
      db.close();
    }
  }

  if (!fs.existsSync(LEGACY_EMAILS_PATH)) return [];
  return fs.readFileSync(LEGACY_EMAILS_PATH, 'utf8')
    .split(/\r?\n/)
    .map(email => email.trim())
    .filter(Boolean);
}

function sendReminders() {
  const emails = loadReminderEmails();
  if (!emails.length) return;
  emails.forEach(email => {
    sendEmail({
      to: email,
      subject,
      text,
      bcc: 'mymentallyprepare.com@mymentallyprepare.com'
    })
      .then(() => {
        console.log('Sent reminder to', email);
      })
      .catch((err) => {
        console.error('Failed to send to', email, err);
      });
  });
}

// Run this script once per day (e.g., via cron)
sendReminders();
