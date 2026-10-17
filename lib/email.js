const { sendEmail: smtpSendEmail, smtpEnabled } = require('./smtp');
const { BASE_URL } = require('./config');
const {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail,
  matchFoundEmail,
  dailyPromptReminderEmail,
  partnerWroteEmail,
  partnerStillWritingEmail,
  signInAgainEmail
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

function sendDailyPromptReminder(email, name, dayNumber, unsubscribeUrl) {
  if (!email) return Promise.resolve();
  const html = dailyPromptReminderEmail(name, dayNumber, unsubscribeUrl);
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

function sendSignInAgain(email, name) {
  if (!email) return Promise.resolve();
  const first = String(name || 'friend').trim().split(/\s+/)[0].replace(/[\r\n\x00-\x1f]/g, '') || 'friend';
  const base = BASE_URL.replace(/\/$/, '');
  const text = `Hi ${first},\n\nWe are starting a new 21-day journey. Please sign in again with your usual email and password or Google account. You can retake the scan, and when someone new is available, begin with a new anonymous match. Earlier writing stays in your private archive.\n\nIn Mentally Prepare, you can write privately with a gentle prompt, take a night off, and choose what to reveal at the end. When your next journey is active, we will send a gentle daily email. You can turn it off from any reminder or in notification settings. Return at your own pace.\n\nSign in: ${base}/app?screen=s-login\nForgot your password? ${base}/app?screen=s-forgot\n\nIf you did not expect this email, reply to hello@mymentallyprepare.com. This one-time account notice includes no private journal content.`;
  return smtpSendEmail({ to: email, subject: 'A new Mentally Prepare journey is ready', html: signInAgainEmail(name), text });
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
  sendEmail,
  sendSignInAgain
};
