const nodemailer = require('nodemailer');
const {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail
} = require('../email-templates');

const AUTH_USER = process.env.EMAIL_USER;
const AUTH_PASS = process.env.EMAIL_PASS;
const loginEmailTracker = new Map();
const LOGIN_EMAIL_INTERVAL = 24 * 60 * 60 * 1000;

let transporter = null;
if (AUTH_USER && AUTH_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
      user: AUTH_USER,
      pass: AUTH_PASS
    }
  });

  transporter.verify()
    .then(() => console.log('✦ Email service ready.'))
    .catch((err) => console.error('Email service verify failed:', err));
} else {
  console.warn('Email service disabled: EMAIL_USER or EMAIL_PASS is missing');
}

async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.warn(`Email not sent (transporter missing): ${subject} → ${to}`);
    return;
  }
  try {
    await transporter.sendMail({
      from: AUTH_USER,
      to,
      subject,
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
