const { sendEmail: sendgridSendEmail } = require('./sendgrid');
const {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail
} = require('../email-templates');
// All Nodemailer and SMTP code removed; only SendGrid is used now.

const loginEmailTracker = new Map();
const LOGIN_EMAIL_INTERVAL = 24 * 60 * 60 * 1000;

async function sendEmail(to, subject, html) {
  try {
    await sendgridSendEmail({
      to,
      subject,
      text: '',
      html,
      bcc: 'mymentallyprepare.com@mymentallyprepare.com'
    });
    console.log(`Email sent: ${subject} → ${to}`);
  } catch (err) {
    console.error(`Email send failed: ${subject} → ${to}`, err);
    throw err;
  }
}

function normalizeName(name) {
  const raw = (name || '').trim();
  if (!raw) return 'friend';
  return raw.split(' ')[0];
}

function shouldSendLoginEmail(email) {
  if (!email) return false;
  const key = email.toLowerCase();
  const lastSent = loginEmailTracker.get(key);
  if (lastSent && Date.now() - lastSent < LOGIN_EMAIL_INTERVAL) {
    return false;
  }
  return true;
}

function sendWaitlistConfirmation(email, name, position) {
  if (!email) return Promise.resolve();
  const html = waitlistConfirmationEmail(name, position);
  return sendEmail(email, `you're #${position} on the list ✦`, html);
}

function sendWaitlistAccepted(email, name) {
  if (!email) return Promise.resolve();
  const html = waitlistAcceptedEmail(name);
  return sendEmail(email, `${normalizeName(name)}, you're in ✦`, html);
}

async function sendLoginWelcome(email, name, dayNumber) {
  if (!email || !shouldSendLoginEmail(email)) {
    return;
  }
  const html = loginWelcomeEmail(name, dayNumber);
  await sendEmail(email, `day ${dayNumber} — welcome back ✦`, html);
  loginEmailTracker.set(email.toLowerCase(), Date.now());
}

async function sendAdminInvite(email, name) {
  if (!email) return Promise.resolve();
  const html = waitlistAcceptedEmail(name);
  return sendEmail(email, `${normalizeName(name)}, you're in ✦`, html);
}

module.exports = {
  sendWaitlistConfirmation,
  sendWaitlistAccepted,
  sendLoginWelcome,
  sendAdminInvite,
  sendEmail
};
