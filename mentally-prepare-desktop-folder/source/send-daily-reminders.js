// send-daily-reminders.js
// Sends daily reminder emails to all signed-up users

const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./lib/sendgrid');

const EMAILS_PATH = path.join(__dirname, 'daily-reminder-emails.txt');



const subject = 'Mentally Prepare: Daily Reminder';
const text = 'Take 5 minutes today to write your journal entry. Your prompt is waiting!';

function sendReminders() {
  if (!fs.existsSync(EMAILS_PATH)) return;
  const emails = fs.readFileSync(EMAILS_PATH, 'utf8').split('\n').map(e => e.trim()).filter(Boolean);
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
