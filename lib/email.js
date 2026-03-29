'use strict';

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || 'mymentallyprepare@gmail.com';
const GMAIL_PASS = process.env.GMAIL_PASS || process.env.EMAIL_PASS;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS
  }
});

// Verify connection at startup
transporter.verify((err) => {
  if (err) {
    console.error('  ✗ Email service failed to connect:', err.message);
  } else {
    console.log('  ✦ Email service ready.');
  }
});

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------
const BASE_STYLE = `
  font-family: 'Georgia', serif;
  background-color: #0d0d0d;
  color: #e8e0d5;
  max-width: 560px;
  margin: 0 auto;
  padding: 40px 32px;
  border-radius: 8px;
`;

const HEADING_STYLE = `
  font-size: 22px;
  font-weight: normal;
  letter-spacing: 0.04em;
  color: #f5f0ea;
  margin: 0 0 24px;
`;

const BODY_STYLE = `
  font-size: 15px;
  line-height: 1.75;
  color: #c8bfb5;
  margin: 0 0 20px;
`;

const FOOTER_STYLE = `
  font-size: 12px;
  color: #5a5550;
  margin-top: 40px;
  border-top: 1px solid #1e1e1e;
  padding-top: 20px;
`;

function wrap(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;background:#0d0d0d;">
  <div style="${BASE_STYLE}">
    ${body}
    <div style="${FOOTER_STYLE}">
      Mentally Prepare &nbsp;·&nbsp; mymentallyprepare.com<br>
      You're receiving this because you signed up or were invited.
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// sendWaitlistConfirmation
// ---------------------------------------------------------------------------
async function sendWaitlistConfirmation(name, email) {
  const firstName = (name || 'there').split(' ')[0];
  const html = wrap(`
    <h1 style="${HEADING_STYLE}">You're on the list.</h1>
    <p style="${BODY_STYLE}">
      Hey ${firstName},<br><br>
      We've saved your spot on the Mentally Prepare waitlist.
      When we open access, you'll be among the first to know.
    </p>
    <p style="${BODY_STYLE}">
      Mentally Prepare is a 21-day anonymous journaling experience
      where you write alongside one other person — someone you'll never
      meet, until maybe you do.
    </p>
    <p style="${BODY_STYLE}">
      Sit tight. We'll be in touch.
    </p>
    <p style="font-size:13px;color:#7a7068;margin:0;">— The Mentally Prepare team</p>
  `);

  await transporter.sendMail({
    from: `"Mentally Prepare" <${GMAIL_USER}>`,
    to: email,
    subject: 'You're on the waitlist ✦',
    html,
    text: `Hey ${firstName},\n\nYou're on the Mentally Prepare waitlist. We'll reach out when access opens.\n\n— The Mentally Prepare team\nhttps://mymentallyprepare.com`
  });

  console.log(`  ✦ Waitlist confirmation sent → ${email}`);
}

// ---------------------------------------------------------------------------
// sendLoginWelcome
// ---------------------------------------------------------------------------
async function sendLoginWelcome(name, email, dayNumber) {
  const firstName = (name || 'there').split(' ')[0];
  const day = dayNumber || 1;
  const html = wrap(`
    <h1 style="${HEADING_STYLE}">Welcome back, ${firstName}.</h1>
    <p style="${BODY_STYLE}">
      You're on Day ${day} of 21. That's not nothing.
    </p>
    <p style="${BODY_STYLE}">
      Every time you open this and write something honest,
      you're doing something most people never do.
      Keep going.
    </p>
    <p style="${BODY_STYLE}">
      Your prompt is waiting.
    </p>
    <p style="margin:32px 0;">
      <a href="https://mymentallyprepare.com/app"
         style="background:#f5f0ea;color:#0d0d0d;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;letter-spacing:0.05em;">
        Open the app →
      </a>
    </p>
    <p style="font-size:13px;color:#7a7068;margin:0;">— The Mentally Prepare team</p>
  `);

  await transporter.sendMail({
    from: `"Mentally Prepare" <${GMAIL_USER}>`,
    to: email,
    subject: `Day ${day} of 21 — your prompt is waiting`,
    html,
    text: `Hey ${firstName},\n\nYou're on Day ${day} of 21. Your prompt is waiting at https://mymentallyprepare.com/app\n\n— The Mentally Prepare team`
  });

  console.log(`  ✦ Login welcome (Day ${day}) sent → ${email}`);
}

// ---------------------------------------------------------------------------
// sendAdminInvite
// ---------------------------------------------------------------------------
async function sendAdminInvite(name, email) {
  const firstName = (name || 'there').split(' ')[0];
  const html = wrap(`
    <h1 style="${HEADING_STYLE}">You're in, ${firstName}.</h1>
    <p style="${BODY_STYLE}">
      Your spot on Mentally Prepare is ready.
      We've been holding it for you.
    </p>
    <p style="${BODY_STYLE}">
      Mentally Prepare is a 21-day anonymous journaling experience.
      You'll write alongside one other person — someone from a different
      college, someone you've never met. No names. No profiles.
      Just honest words.
    </p>
    <p style="${BODY_STYLE}">
      Create your account and start whenever you're ready.
    </p>
    <p style="margin:32px 0;">
      <a href="https://mymentallyprepare.com"
         style="background:#f5f0ea;color:#0d0d0d;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;letter-spacing:0.05em;">
        Get started →
      </a>
    </p>
    <p style="font-size:13px;color:#7a7068;margin:0;">— The Mentally Prepare team</p>
  `);

  await transporter.sendMail({
    from: `"Mentally Prepare" <${GMAIL_USER}>`,
    to: email,
    subject: 'Your invite to Mentally Prepare ✦',
    html,
    text: `Hey ${firstName},\n\nYour invite to Mentally Prepare is ready. Create your account at https://mymentallyprepare.com\n\n— The Mentally Prepare team`
  });

  console.log(`  ✦ Admin invite sent → ${email}`);
}

module.exports = {
  sendWaitlistConfirmation,
  sendLoginWelcome,
  sendAdminInvite
};
