const { sendEmail: sendgridSendEmail } = require('./sendgrid');
const {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail,
  matchFoundEmail,
  dailyPromptReminderEmail,
  partnerWroteEmail
} = require('../email-templates');
// All Nodemailer and SMTP code removed; only SendGrid is used now.

// Login email rate limiting is now handled via DB

async function sendEmail(to, subject, html) {
  try {
    await sendgridSendEmail({
      to,
      subject,
      text: '',
      html
    });
    console.log(`Email sent: ${subject} → ${to}`);
  } catch (err) {
    console.error(`Email send failed: ${subject} → ${to}`);
    if (err.response && err.response.body && err.response.body.errors) {
      console.error('SendGrid errors:', err.response.body.errors);
    } else {
      console.error(err);
    }
    throw err;
  }
}

function normalizeName(name) {
  const raw = (name || '').trim();
  if (!raw) return 'friend';
  return raw.split(' ')[0];
}

// shouldSendLoginEmail removed (handled in auth.js)

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
  if (!email) return;
  const html = loginWelcomeEmail(name, dayNumber);
  await sendEmail(email, `day ${dayNumber} — welcome back ✦`, html);
}

async function sendAdminInvite(email, name) {
  if (!email) return Promise.resolve();
  const html = waitlistAcceptedEmail(name);
  return sendEmail(email, `${normalizeName(name)}, you're in ✦`, html);
}

function sendMatchFoundNotification(email, name, partnerArchetype) {
  if (!email) return Promise.resolve();
  const html = matchFoundEmail(name, partnerArchetype);
  return sendEmail(email, `your partner has been found ✦`, html);
}

function sendDailyPromptReminder(email, name, dayNumber) {
  if (!email) return Promise.resolve();
  const html = dailyPromptReminderEmail(name, dayNumber);
  return sendEmail(email, `day ${dayNumber} — tonight's prompt is waiting`, html);
}

function sendPartnerWroteReminder(email, name, partnerName, dayNumber) {
  if (!email) return Promise.resolve();
  const pName = partnerName ? normalizeName(partnerName) : 'your partner';
  const html = partnerWroteEmail(name, partnerName, dayNumber);
  return sendEmail(email, `${pName} wrote today. don't leave them waiting.`, html);
}

module.exports = {
  sendWaitlistConfirmation,
  sendWaitlistAccepted,
  sendLoginWelcome,
  sendAdminInvite,
  sendMatchFoundNotification,
  sendDailyPromptReminder,
  sendPartnerWroteReminder,
  sendEmail
};
