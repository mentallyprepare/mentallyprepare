// Install with: npm install @sendgrid/mail
const sgMail = require('@sendgrid/mail');

const {
  SENDGRID_API_KEY,
  SENDGRID_FROM,
  EMAIL_USER
} = process.env;

if (!SENDGRID_API_KEY) {
  throw new Error('SENDGRID_API_KEY is required to send emails');
}

const fromEmail = SENDGRID_FROM || EMAIL_USER;
if (!fromEmail) {
  throw new Error('SENDGRID_FROM or EMAIL_USER must be set for SendGrid to use as the sender');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
  throw new Error('SENDGRID_FROM/EMAIL_USER must be a valid email address');
}

sgMail.setApiKey(SENDGRID_API_KEY);

function sendEmail({ to, subject, text, html, bcc }) {
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
