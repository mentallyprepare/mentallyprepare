const { sendEmail: sendgridSendEmail } = require('./sendgrid');
const {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail
} = require('../email-templates');

const nodemailer = require('nodemailer');
const {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail
} = require('../email-templates');

if (AUTH_USER && AUTH_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
// Nodemailer code removed

}
      html
    });
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
