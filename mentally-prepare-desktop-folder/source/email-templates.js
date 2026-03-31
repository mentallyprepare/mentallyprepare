const SITE_URL = 'https://mentallyprepare.in';
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
  return raw.split(' ')[0];
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
      quietly held in <a href="${SITE_URL}" style="color:${BRAND.violet}; text-decoration:none;">mentallyprepare.in</a>
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
  const preheader = `You're #${position} on the Mentally Prepare waitlist ✦`;
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
    <p style="margin:8px 0 0; color:${BRAND.violet}; font-weight:600;">position #${position}</p>
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
    <p style="margin:16px 0 16px;">your spot just opened. we're matching you with one stranger within 24 hours, and you'll hear from us again as soon as the pairing lands in your inbox.</p>
    <p style="margin:0 0 16px;">keep an eye on your phone, keep your journal nearby, and let curiosity lead the first note.</p>
    <div style="text-align:center; margin:32px 0;">
      <a href="${SITE_URL}/signup" style="
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
        <li>day 14 unlock: option to ask to meet (or not)</li>
        <li>day 21 reveal if it's time to step forward</li>
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
    return 'you\'re building something real with your pen pal. keep showing up, even on the days that feel heavy.';
  }
  if (dayNumber <= 18) {
    return 'you\'ve been at this for a while now. look how far you\'ve come, and let that be permission to write honestly again.';
  }
  return 'you\'re almost at day 21. whatever happens next — you showed up, and that matters more than you know.';
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
      <a href="${SITE_URL}/journal" style="
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

module.exports = {
  waitlistConfirmationEmail,
  waitlistAcceptedEmail,
  loginWelcomeEmail
};
