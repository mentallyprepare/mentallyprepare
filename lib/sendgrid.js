// Install with: npm install @sendgrid/mail
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

function sendEmail({ to, subject, text, bcc }) {
  const msg = {
    to,
    from: process.env.EMAIL_USER, // Must be verified in SendGrid
    subject,
    text,
    bcc,
  };
  return sgMail.send(msg);
}

module.exports = { sendEmail };