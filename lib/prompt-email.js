'use strict';

// The weekly prompt email.
//
// One question, one short paragraph, one link. No images, no tracking pixel,
// no analytics parameters — the only way we know someone opened it is if they
// tell us. That is deliberate: these addresses were given for a prompt, not
// for a funnel.
//
// The voice is the app's voice: second person, plain, no system speaking in the
// first person, nothing that reads as a machine. See the governing rule in the
// mobile directive.

const PROMPTS = [
  'What is one thing you wish someone would just ask you about?',
  'What did you hide today because it felt too small to explain?',
  'When do you become distant, even when you want closeness?',
  'What are you tired of carrying alone?',
  'What did you almost say out loud this week, and then didn\u2019t?',
  'Who did you feel most like yourself around this month?',
  'What are you still waiting for permission to want?',
  'What would you tell the version of you who started this term?',
  'What has been quietly taking up room in your head?',
  'What do you miss that you have not admitted missing?'
];

// A stable pick per calendar week, so two runs in the same week send the same
// prompt rather than surprising people with a second one.
function promptForWeek(date) {
  const d = date instanceof Date ? date : new Date();
  // Weeks run Monday to Sunday, counted from a known Monday (5 Jan 1970), so
  // two runs in the same calendar week always pick the same prompt.
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const week = Math.floor((day - Date.UTC(1970, 0, 5)) / 604800000);
  return PROMPTS[((week % PROMPTS.length) + PROMPTS.length) % PROMPTS.length];
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPromptEmail({ prompt, unsubscribeUrl, baseUrl }) {
  const site = String(baseUrl || 'https://mymentallyprepare.com').replace(/\/$/, '');
  const subject = 'one question for this week';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#0B0614;color:#F4EFF8;font-family:Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0614">
<tr><td style="padding:40px 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">
<tr><td>
<p style="margin:0 0 24px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#B9A7D6">Mentally Prepare</p>
<p style="margin:0 0 28px;font-size:20px;line-height:1.45;color:#F4EFF8">${escapeHtml(prompt)}</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#CFC3E0">Answer it in a notebook, in your notes app, or in a message to someone. One honest line is enough. You do not have to send it anywhere.</p>
<p style="margin:0 0 32px;font-size:15px;line-height:1.65;color:#CFC3E0">If writing is not helping tonight, put it down. If what you are sitting with feels heavier than a page can hold, talking to someone you trust is worth more than another prompt.</p>
<p style="margin:0 0 36px"><a href="${escapeHtml(site)}/app" style="display:inline-block;padding:13px 22px;border-radius:14px;background:#E8B4C8;color:#1A0F22;font-size:14px;font-weight:bold;text-decoration:none">If you want to write to someone &rarr;</a></p>
<p style="margin:0;font-size:12px;line-height:1.7;color:#8C7FA6">For adults 18+. One email a week. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#8C7FA6">Unsubscribe in one click</a>.</p>
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    prompt,
    '',
    'Answer it in a notebook, in your notes app, or in a message to someone. One honest line is enough. You do not have to send it anywhere.',
    '',
    'If writing is not helping tonight, put it down. If what you are sitting with feels heavier than a page can hold, talking to someone you trust is worth more than another prompt.',
    '',
    'If you want to write to someone: ' + site + '/app',
    '',
    'For adults 18+. One email a week. Unsubscribe: ' + unsubscribeUrl
  ].join('\n');

  return { subject, html, text };
}

function unsubscribeUrlFor(token, baseUrl) {
  const site = String(baseUrl || 'https://mymentallyprepare.com').replace(/\/$/, '');
  return `${site}/prompts/unsubscribe?token=${encodeURIComponent(token)}`;
}

module.exports = { PROMPTS, promptForWeek, buildPromptEmail, unsubscribeUrlFor };
