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
  const text = `Hi ${first},\n\nMentally Prepare is a private space for students aged 18 and over to write honestly and connect beyond profiles, likes, or followers. A short reflection scan helps us find one anonymous partner for a 21-day journey when a match is available.\n\nWe are starting a new journey. Please sign in again with your usual email and password or Google account, then take the scan again. Your earlier writing stays in your private archive, and your next partner and journal begin fresh.\n\nYou can write in your private room with a gentle daily prompt, share a 21-day journey with one anonymous partner when matched, leave a line in the Silent Room without expecting a reply, take a night off when you need to, and choose what to reveal on Day 21.\n\nWhen your next journey is active, we will send a gentle daily email. You can turn it off from any reminder or in notification settings. Return at your own pace.\n\nSign in: ${base}/app?screen=s-login\nForgot your password? ${base}/app?screen=s-forgot\n\nIf you did not expect this email, reply to hello@mymentallyprepare.com. This one-time account notice includes no private journal content.`;
  return smtpSendEmail({ to: email, subject: 'A new Mentally Prepare journey is ready', html: signInAgainEmail(name), text });
}

function sendSignInFollowUp(email, name) {
  if (!email) return Promise.resolve();
  const first = String(name || 'friend').trim().split(/\s+/)[0].replace(/[\r\n\x00-\x1f]/g, '') || 'friend';
  const safeName = first.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const base = BASE_URL.replace(/\/$/, '');
  const signIn = `${base}/app?screen=s-login`;
  const forgot = `${base}/app?screen=s-forgot`;
  const text = `Hi ${first},\n\nA few days ago we invited you to begin a fresh Mentally Prepare journey. If you would like to return, sign in with your usual email and password or Google account and take the reflection scan again.\n\nYour earlier writing remains private in your archive. Your next journal begins fresh, and an anonymous partner is available when a match can be found.\n\nSign in: ${signIn}\nForgot your password? ${forgot}\n\nIf you do not want further reminders, reply to hello@mymentallyprepare.com or change your notification settings after signing in.\n\nAnushka\nMentally Prepare`;
  const html = `<div style="background:#0d0920;padding:32px 16px;color:#f8f2ff;font-family:Arial,sans-serif"><div style="max-width:540px;margin:auto;background:#171127;border:1px solid #594271;padding:32px"><div style="font-family:Georgia,serif;font-size:25px;margin-bottom:28px">mentally <i style="color:#ecb4c9">prepare</i></div><p>Hi ${safeName},</p><p>A few days ago we invited you to begin a fresh Mentally Prepare journey. If you would like to return, sign in with your usual email and password or Google account and take the reflection scan again.</p><p>Your earlier writing remains private in your archive. Your next journal begins fresh, and an anonymous partner is available when a match can be found.</p><p style="margin:30px 0"><a href="${signIn}" style="display:inline-block;background:#aa739c;color:#fff;padding:13px 22px;text-decoration:none">Sign in to your space</a></p><p><a href="${forgot}" style="color:#ecb4c9">Forgot your password?</a></p><p style="font-size:12px;color:#c4b6cf;border-top:1px solid #594271;padding-top:20px">If you do not want further reminders, reply to <a href="mailto:hello@mymentallyprepare.com" style="color:#ecb4c9">hello@mymentallyprepare.com</a> or change your notification settings after signing in.</p><p>Anushka<br>Mentally Prepare</p></div></div>`;
  return smtpSendEmail({ to: email, subject: 'Your Mentally Prepare space is here', html, text });
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
  sendSignInAgain,
  sendSignInFollowUp
};
