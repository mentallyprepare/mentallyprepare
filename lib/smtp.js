const nodemailer = require('nodemailer');

// ── Resend (preferred) ──
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM = (process.env.RESEND_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || '').trim();
const RESEND_FROM_NAME = (process.env.RESEND_FROM_NAME || process.env.SMTP_FROM_NAME || 'Mentally Prepare').trim();
const resendEnabled = !!RESEND_API_KEY && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(RESEND_FROM);

// ── SMTP (fallback) ──
const {
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  GMAIL_FROM_NAME,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_FAMILY,
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
const smtpFamily = Number(SMTP_FAMILY || 0);
const fromEmail = clean(SMTP_FROM_EMAIL || smtpUser);
const fromName = clean(SMTP_FROM_NAME || GMAIL_FROM_NAME || 'Mentally Prepare');

const smtpEnabled = !resendEnabled && !!smtpHost && !!smtpUser && !!smtpPass && emailRegex.test(fromEmail);

let transporter = null;

// ── Boot diagnostics ──
if (resendEnabled) {
  console.log('Email provider: Resend (API)');
} else if (smtpEnabled) {
  console.log('Email provider: SMTP (' + smtpHost + ':' + smtpPort + ')');
} else {
  const missing = [];
  if (!RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!smtpHost) missing.push('SMTP_HOST');
  if (!smtpUser) missing.push('GMAIL_USER/SMTP_USER/EMAIL_USER');
  if (!smtpPass) missing.push('GMAIL_APP_PASSWORD/SMTP_PASS/EMAIL_PASS');
  if (process.env.EMAIL_WARN_IF_DISABLED === '1') {
    console.warn('Email disabled — missing:', missing.join('; '));
  }
}

// ── Resend sender ──
async function resendSend({ to, subject, text, html, bcc }) {
  const from = RESEND_FROM_NAME ? `${RESEND_FROM_NAME} <${RESEND_FROM}>` : RESEND_FROM;
  const body = { from, to: Array.isArray(to) ? to : [to], subject };
  if (html) body.html = html;
  if (text) body.text = text;
  if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── SMTP sender ──
function getTransporter() {
  if (!smtpEnabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      ...(smtpFamily === 4 || smtpFamily === 6 ? { family: smtpFamily } : {}),
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: { user: smtpUser, pass: smtpPass }
    });
  }
  return transporter;
}

// ── Unified sendEmail ──
async function sendEmail({ to, subject, text, html, bcc }) {
  if (resendEnabled) {
    return resendSend({ to, subject, text, html, bcc });
  }

  const mailer = getTransporter();
  if (!mailer) {
    return Promise.reject(new Error('Email service is not configured — set RESEND_API_KEY or SMTP credentials'));
  }

  if (!text && !html) {
    throw new Error('Email requires a text or html body');
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
  smtpEnabled: resendEnabled || smtpEnabled
};
