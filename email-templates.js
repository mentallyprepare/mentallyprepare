const { BASE_URL } = require('./lib/config');
const SITE_URL = BASE_URL;
const BRAND = {
  background: '#08050F',
  card: '#0E0A18',
  rose: '#F7B7C8',
  roseDark: '#9B4F66',
  purple: '#896CB5',
  violet: '#C084FC',
  gold: '#ECC885',
  text: '#F8F2FF',
  muted: 'rgba(248,242,255,0.6)'
};

function firstName(name) {
  const raw = (name || '').trim();
  if (!raw) return 'friend';
  return escapeHtml(raw.split(' ')[0]);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function wordmarkHtml() {
  return `
    <div style="font-family:Georgia,serif; text-align:center; margin-bottom:24px;">
      <span style="color:${BRAND.text}; font-size:28px;">mentally</span>
      <span style="color:${BRAND.violet}; font-style:italic; font-size:28px;">prepare</span>
    </div>
  `;
}

function dividerHtml(start, end) {
  return `
    <div style="
      height:2px;
      border-radius:1px;
      width:100%;
      margin:24px 0;
      background: linear-gradient(90deg, ${start}, ${end});
    "></div>
  `;
}

function footerHtml() {
  return `
    <div style="
      margin-top:32px;
      padding-top:16px;
      border-top:1px solid rgba(255,255,255,0.1);
      color:${BRAND.muted};
      font-size:12px;
      text-align:center;
    ">
      <a href="${SITE_URL}" style="color:${BRAND.violet}; text-decoration:none;">mymentallyprepare.com</a>
    </div>
  `;
}

function buildTemplate({ preheader, content }) {
  const hiddenPreheader = preheader
    ? `<span style="display:none; font-size:1px; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">${preheader}</span>`
    : '';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>mentally prepare</title>
      </head>
      <body style="margin:0; padding:0; background:${BRAND.background}; font-family:'Inter', 'Helvetica Neue', Arial, sans-serif; color:${BRAND.text};">
        ${hiddenPreheader}
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:32px 16px;">
              <div style="width:100%; max-width:600px;">
                <div style="background:${BRAND.card}; border-radius:20px; padding:32px; box-shadow: 0 10px 40px rgba(0,0,0,0.5);">
                  ${wordmarkHtml()}
                  ${content}
                  ${footerHtml()}
                </div>
              </div>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

function waitlistConfirmationEmail(name, position) {
  const first = firstName(name);
  const safePosition = Number.isSafeInteger(Number(position)) && Number(position) > 0 ? Number(position) : '';
  const preheader = `You're #${safePosition} on the Mentally Prepare waitlist ✦`;
  const highlight = `
    <div style="
      margin:24px 0;
      padding:16px;
      border-radius:14px;
      background: rgba(137, 108, 181, 0.15);
      border:1px solid rgba(248,242,255,0.15);
    ">
      <p style="margin:0; font-style:italic; color:${BRAND.text}; line-height:1.4;">the moon doesn't rush its phases</p>
      <p style="margin:10px 0 0; color:${BRAND.muted}; line-height:1.4;">we'll email you when your spot opens up</p>
    </div>
  `;

  const body = `
    <div style="text-align:center; font-size:40px; line-height:1; margin-bottom:12px;">🌙</div>
    <h1 style="margin:0; font-size:32px; text-transform:none;">you're on the list, ${first}</h1>
    <p style="margin:8px 0 0; color:${BRAND.violet}; font-weight:600;">position #${safePosition}</p>
    ${dividerHtml(BRAND.rose, BRAND.roseDark)}
    <p style="margin:0 0 12px;">hey ${first}, thank you for raising your hand for mentally prepare. this is a 21-day dip into anonymous letters with just one stranger – no names, no socials, just honest writing when your head is too loud.</p>
    <p style="margin:0 0 12px;">we hold the space, pair you slowly, and only reach back when a slot opens. until then, keep breathing and know we're saving a quiet corner for you.</p>
    ${highlight}
    <p style="margin:0; color:${BRAND.muted}; line-height:1.6;">talk soon, — <span style="color:${BRAND.rose};">the mentally prepare team</span></p>
  `;

  return buildTemplate({ preheader, content: body });
}

function waitlistAcceptedEmail(name) {
  const first = firstName(name);
  const body = `
    <div style="text-align:center; font-size:22px; letter-spacing:6px; margin-bottom:14px;">🌑🌒🌓🌔🌕</div>
    <h1 style="margin:0; font-size:34px; text-transform:none;">you're in, ${first}</h1>
    <p style="margin:8px 0 0; color:${BRAND.gold}; font-weight:600;">✦ your 21 days begin now ✦</p>
    ${dividerHtml(BRAND.gold, '#F7B7C8')}
    <p style="margin:16px 0 16px;">your spot is open. you can set up your account now, and we'll let you know when a connection is ready.</p>
    <p style="margin:0 0 16px;">keep an eye on your phone, keep your journal nearby, and let curiosity lead the first note.</p>
    <div style="text-align:center; margin:32px 0;">
      <a href="${SITE_URL}/app?screen=s-signup" style="
        display:inline-block;
        padding:14px 36px;
        border-radius:999px;
        background: linear-gradient(135deg, ${BRAND.roseDark}, ${BRAND.purple});
        color:${BRAND.text};
        font-weight:600;
        text-decoration:none;
      ">✦ Start your journey</a>
    </div>
    <div style="
      border-radius:14px;
      padding:16px;
      background: rgba(236, 200, 133, 0.12);
      border:1px solid rgba(236, 200, 133, 0.5);
      color:${BRAND.text};
    ">
      <p style="margin:0 0 6px; font-weight:600; color:${BRAND.gold};">WHAT HAPPENS NEXT</p>
      <ul style="margin:0; padding-left:18px; line-height:1.6;">
        <li>create your profile and set your writing rhythm</li>
        <li>we match you with one person, no scouting</li>
        <li>write your first letter, keep it honest</li>
        <li>write at your own pace</li>
        <li>on day 21, both people can choose whether to reveal themselves</li>
      </ul>
    </div>
    <p style="margin:24px 0 0; color:${BRAND.muted}; line-height:1.6;">rooting for you, — <span style="color:${BRAND.rose};">the mentally prepare team</span></p>
  `;

  return buildTemplate({ content: body });
}

function getMoonForDay(dayNumber) {
  if (dayNumber >= 18) return '🌕';
  if (dayNumber >= 13) return '🌔';
  if (dayNumber >= 9) return '🌓';
  if (dayNumber >= 5) return '🌒';
  return '🌑';
}

function loginMessage(dayNumber) {
  if (dayNumber <= 3) {
    return 'you\'re just getting started. take your time, write what feels true, and don\'t rush the silence.';
  }
  if (dayNumber <= 10) {
    return 'you can return to your private writing space whenever it feels useful.';
  }
  if (dayNumber <= 18) {
    return 'your pace is yours. write what feels useful today.';
  }
  return 'day 21 is close. you can choose what to share and what to keep private.';
}

function loginWelcomeEmail(name, dayNumber) {
  const first = firstName(name);
  const emoji = getMoonForDay(dayNumber);
  const message = loginMessage(dayNumber);

  const body = `
    <div style="text-align:center; font-size:40px; line-height:1; margin-bottom:12px;">${emoji}</div>
    <h1 style="margin:0; font-size:32px; text-transform:none;">welcome back, ${first}</h1>
    <p style="margin:8px 0 0; color:${BRAND.violet}; font-weight:600;">day ${dayNumber} of 21</p>
    ${dividerHtml(BRAND.purple, BRAND.violet)}
    <p style="margin:16px 0 16px;">${message}</p>
    <div style="text-align:center; margin:24px 0;">
      <a href="${SITE_URL}/app" style="
        display:inline-block;
        padding:10px 28px;
        border-radius:999px;
        border:1px solid ${BRAND.purple};
        color:${BRAND.text};
        font-weight:600;
        text-decoration:none;
      ">open your journal →</a>
    </div>
    <p style="margin:24px 0 0; color:${BRAND.muted}; font-size:13px;">if this wasn't you, you can ignore this email.</p>
  `;

  return buildTemplate({ content: body });
}

function matchFoundEmail(name, partnerArchetype) {
  const first = firstName(name);
  const body = `
    <div style="text-align:center; font-size:40px; line-height:1; margin-bottom:12px;">🌟</div>
    <h1 style="margin:0; font-size:32px; text-transform:none;">your journey begins, ${first}</h1>
    <p style="margin:8px 0 0; color:${BRAND.gold}; font-weight:600;">✦ we found your partner ✦</p>
    ${dividerHtml(BRAND.gold, BRAND.violet)}
    <p style="margin:16px 0 16px;">a connection is ready in your private space.</p>
    <p style="margin:0 0 16px;">when you have a moment, open the app to see what comes next.</p>
    <div style="text-align:center; margin:32px 0;">
      <a href="${SITE_URL}/app" style="
        display:inline-block;
        padding:14px 36px;
        border-radius:999px;
        background: linear-gradient(135deg, ${BRAND.roseDark}, ${BRAND.purple});
        color:${BRAND.text};
        font-weight:600;
        text-decoration:none;
      ">✦ Open your journal</a>
    </div>
  `;
  return buildTemplate({ content: body });
}

function dailyPromptReminderEmail(name, dayNumber) {
  const first = firstName(name);
  const emoji = getMoonForDay(dayNumber);
  const body = `
    <div style="text-align:center; font-size:40px; line-height:1; margin-bottom:12px;">${emoji}</div>
    <h1 style="margin:0; font-size:32px; text-transform:none;">a quiet minute for yourself</h1>
    <p style="margin:8px 0 0; color:${BRAND.violet}; font-weight:600;">day ${dayNumber} of 21</p>
    ${dividerHtml(BRAND.purple, BRAND.violet)}
    <p style="margin:16px 0 16px;">${first}, if today has been full, you can pause here. Tonight's prompt is ready whenever you want to write.</p>
    <div style="text-align:center; margin:24px 0;">
      <a href="${SITE_URL}/app" style="
        display:inline-block;
        padding:10px 28px;
        border-radius:999px;
        border:1px solid ${BRAND.purple};
        color:${BRAND.text};
        font-weight:600;
        text-decoration:none;
      ">View tonight's prompt →</a>
    </div>
  `;
  return buildTemplate({ content: body });
}

function partnerWroteEmail(name, partnerName, dayNumber) {
  const first = firstName(name);
  const emoji = getMoonForDay(dayNumber);
  const body = `
    <div style="text-align:center; font-size:40px; line-height:1; margin-bottom:12px;">${emoji}</div>
    <h1 style="margin:0; font-size:32px; text-transform:none;">a note is ready in your space</h1>
    <p style="margin:8px 0 0; color:${BRAND.violet}; font-weight:600;">day ${dayNumber} of 21</p>
    ${dividerHtml(BRAND.purple, BRAND.violet)}
    <p style="margin:16px 0 16px;">${first}, there's something new to see when you're ready. You can write whenever it feels right for you.</p>
    <div style="text-align:center; margin:24px 0;">
      <a href="${SITE_URL}/app" style="
        display:inline-block;
        padding:10px 28px;
        border-radius:999px;
        border:1px solid ${BRAND.purple};
        color:${BRAND.text};
        font-weight:600;
        text-decoration:none;
      ">Write your entry →</a>
    </div>
  `;
  return buildTemplate({ content: body });
}

function partnerStillWritingEmail(name) {
  const first = firstName(name);
  const body = `
    <h1 style="margin:0; font-size:32px; text-transform:none;">your space is here when you need it</h1>
    ${dividerHtml(BRAND.purple, BRAND.violet)}
    <p style="margin:16px 0 8px;">${first}, you can come back to your private writing space whenever you like.</p>
    <p style="margin:0 0 16px;">There's nothing to catch up on. A single line is enough if that's what you have today.</p>
    <div style="text-align:center; margin:24px 0;">
      <a href="${SITE_URL}/app" style="
        display:inline-block;
        padding:10px 28px;
        border-radius:999px;
        border:1px solid ${BRAND.purple};
        color:${BRAND.text};
        font-weight:600;
        text-decoration:none;
      ">Open the app &rarr;</a>
    </div>
  `;
  return buildTemplate({ preheader: 'Your private writing space is here when you want it.', content: body });
}

module.exports = {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail,
  matchFoundEmail,
  dailyPromptReminderEmail,
  partnerWroteEmail,
  partnerStillWritingEmail
};
