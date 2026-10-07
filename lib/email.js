const { sendEmail: smtpSendEmail, smtpEnabled } = require('./smtp');
const {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail,
  matchFoundEmail,
  dailyPromptReminderEmail,
  partnerWroteEmail,
  partnerStillWritingEmail
} = require('../email-templates');

async function sendEmail(to, subject, html) {
  const text = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|rarr);/g, entity => ({
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rarr;': '→'
    })[entity] || entity)
    .replace(/\s+/g, ' ').trim();
  const payload = { to, subject, text, html };

  if (!smtpEnabled) {
    throw new Error('Email service is not configured');
  }

  try {
    await smtpSendEmail(payload);
    console.log(`Email sent: ${subject}`);
  } catch (err) {
    console.error(`Email failed: ${subject}`);
    console.error(err.message || err);
    throw err;
  }
}

function sendWaitlistConfirmation(email, name, position) {
  if (!email) return Promise.resolve();
  const html = waitlistConfirmationEmail(name, position);
  return sendEmail(email, `you're #${position} on the list`, html);
}

function sendWaitlistAccepted(email, name) {
  if (!email) return Promise.resolve();
  const html = waitlistAcceptedEmail(name);
  return sendEmail(email, 'Your place is open at Mentally Prepare', html);
}

async function sendLoginWelcome(email, name, dayNumber) {
  if (!email) return;
  const html = loginWelcomeEmail(name, dayNumber);
  await sendEmail(email, 'Your private space is ready', html);
}

async function sendAdminInvite(email, name) {
  if (!email) return Promise.resolve();
  const html = waitlistAcceptedEmail(name);
  return sendEmail(email, 'Your place is open at Mentally Prepare', html);
}

function sendMatchFoundNotification(email, name, partnerArchetype) {
  if (!email) return Promise.resolve();
  const html = matchFoundEmail(name, partnerArchetype);
  return sendEmail(email, 'A connection is ready in your space', html);
}

function sendDailyPromptReminder(email, name, dayNumber) {
  if (!email) return Promise.resolve();
  const html = dailyPromptReminderEmail(name, dayNumber);
  return sendEmail(email, 'A quiet minute for yourself', html);
}

function sendPartnerWroteReminder(email, name, partnerName, dayNumber) {
  if (!email) return Promise.resolve();
  const html = partnerWroteEmail(name, partnerName, dayNumber);
  return sendEmail(email, 'A note is ready in your space', html);
}

function sendPartnerStillWriting(email, name) {
  if (!email) return Promise.resolve();
  const html = partnerStillWritingEmail(name);
  return sendEmail(email, 'Your space is here when you need it', html);
}

module.exports = {
  sendWaitlistConfirmation,
  sendWaitlistAccepted,
  sendLoginWelcome,
  sendAdminInvite,
  sendMatchFoundNotification,
  sendDailyPromptReminder,
  sendPartnerWroteReminder,
  sendPartnerStillWriting,
  sendEmail
};
