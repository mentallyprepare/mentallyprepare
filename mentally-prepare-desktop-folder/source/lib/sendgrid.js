// Install with: npm install @sendgrid/mail
const sgMail = require('@sendgrid/mail');

const {
  SENDGRID_API_KEY,
  SENDGRID_FROM,
  EMAIL_USER,
  CONTACT_EMAIL
} = process.env;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fromCandidates = [SENDGRID_FROM, EMAIL_USER, CONTACT_EMAIL]
  .filter(Boolean);
const fromEmail = fromCandidates.find(candidate => emailRegex.test(candidate));

const missingApiKey = !SENDGRID_API_KEY;
const missingFromEmail = !fromEmail;
const sendgridEnabled = !missingApiKey && !missingFromEmail;

if (!sendgridEnabled) {
  const reasons = [];
  if (missingApiKey) reasons.push('SENDGRID_API_KEY is missing');
  if (missingFromEmail) reasons.push('SENDGRID_FROM/EMAIL_USER/CONTACT_EMAIL is missing or invalid');
  console.warn('SendGrid disabled:', reasons.join('; '));
}

if (sendgridEnabled) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

function sendEmail({ to, subject, text, html, bcc }) {
  if (!sendgridEnabled) {
    const reasons = [];
    if (missingApiKey) reasons.push('missing SENDGRID_API_KEY');
    if (missingFromEmail) reasons.push('invalid from address');
    return Promise.reject(new Error('SendGrid is not configured: ' + reasons.join(', ')));
  }

  const msg = {
    to,
    from: fromEmail,
    subject
  };

  if (text) {
    msg.text = text;
  }
  if (html) {
    msg.html = html;
  }
  if (bcc) {
    msg.bcc = bcc;
  }

  if (!msg.text && !msg.html) {
    throw new Error('SendGrid email requires a text or html body');
  }

  return sgMail.send(msg);
}

module.exports = { sendEmail };
