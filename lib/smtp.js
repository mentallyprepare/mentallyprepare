const nodemailer = require('nodemailer');

const {
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  GMAIL_FROM_NAME,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM_EMAIL,
  SMTP_FROM_NAME,
  EMAIL_USER,
  EMAIL_PASS
} = process.env;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value) {
  return String(value || '').trim();
}

const gmailUser = clean(GMAIL_USER || EMAIL_USER);
const gmailPass = clean(GMAIL_APP_PASSWORD || EMAIL_PASS);
const smtpUser = clean(SMTP_USER || gmailUser);
const smtpPass = clean(SMTP_PASS || gmailPass);
const smtpHost = clean(SMTP_HOST) || (gmailUser ? 'smtp.gmail.com' : '');
const smtpPort = Number(SMTP_PORT || (smtpHost === 'smtp.gmail.com' ? 465 : 587));
const smtpSecure = SMTP_SECURE
  ? String(SMTP_SECURE).toLowerCase() === 'true'
  : smtpPort === 465;
const fromEmail = clean(SMTP_FROM_EMAIL || smtpUser);
const fromName = clean(SMTP_FROM_NAME || GMAIL_FROM_NAME || 'Mentally Prepare');

const smtpEnabled = !!smtpHost && !!smtpUser && !!smtpPass && emailRegex.test(fromEmail);

let transporter = null;

if (!smtpEnabled) {
  const missing = [];
  if (!smtpHost) missing.push('SMTP_HOST');
  if (!smtpUser) missing.push('GMAIL_USER/SMTP_USER/EMAIL_USER');
  if (!smtpPass) missing.push('GMAIL_APP_PASSWORD/SMTP_PASS/EMAIL_PASS');
  if (!emailRegex.test(fromEmail)) missing.push('valid SMTP_FROM_EMAIL/from email');
  console.warn('SMTP email disabled:', missing.join('; '));
}

function getTransporter() {
  if (!smtpEnabled) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, text, html, bcc }) {
  const mailer = getTransporter();
  if (!mailer) {
    return Promise.reject(new Error('SMTP email is not configured'));
  }

  if (!text && !html) {
    throw new Error('SMTP email requires a text or html body');
  }

  return mailer.sendMail({
    to,
    from: fromName ? { name: fromName, address: fromEmail } : fromEmail,
    subject,
    text,
    html,
    bcc
  });
}

module.exports = {
  sendEmail,
  smtpEnabled
};
