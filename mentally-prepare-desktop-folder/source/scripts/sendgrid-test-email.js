// Lightweight helper to exercise the SendGrid client for verification.
// Usage: set SENDGRID_API_KEY and EMAIL_USER in your env (use shared Railway vars or .env).
// Optionally set SENDGRID_TEST_TO to override the recipient (defaults to EMAIL_USER).

const sgMail = require('@sendgrid/mail');

const {
  SENDGRID_API_KEY,
  EMAIL_USER,
  SENDGRID_TEST_TO,
  SENDGRID_EU_RESIDENCY
} = process.env;

if (!SENDGRID_API_KEY || !SENDGRID_API_KEY.startsWith('SG.')) {
  throw new Error('SENDGRID_API_KEY must be defined and begin with "SG."');
}
if (!EMAIL_USER) {
  throw new Error('EMAIL_USER (a verified sender) is required');
}

sgMail.setApiKey(SENDGRID_API_KEY);

const msg = {
  to: SENDGRID_TEST_TO || EMAIL_USER,
  from: EMAIL_USER,
  subject: 'Mentally Prepare — SendGrid test email',
  text: 'This email proves that the SendGrid API key and sender are live.',
  html: '<strong>This email proves that the SendGrid API key and sender are live.</strong>'
};

if (SENDGRID_EU_RESIDENCY) {
  msg.setDataResidency = { country: SENDGRID_EU_RESIDENCY };
}

sgMail
  .send(msg)
  .then(() => {
    console.log('Email sent successfully to', msg.to);
  })
  .catch((err) => {
    console.error('Failed to send email:', err.response ? err.response.body : err.message);
    process.exit(1);
  });
