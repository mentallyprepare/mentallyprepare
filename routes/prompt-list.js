'use strict';

// One prompt a week — the blog's only capture point.
//
// The blog converts almost nobody: measured over 90 days, 21 of 400 sessions
// landed on a blog page and the whole blog produced one call-to-action click.
// A reader who is moved by an article at 11pm but not ready to be matched with
// a stranger currently has nothing to do, so they leave and are never seen
// again. This list is the one asset that survives that reader.
//
// Rules this module keeps:
//   * No enumeration. Every accepted or already-known address gets the same
//     response, so the endpoint cannot be used to test who is on the list.
//   * No email address in analytics, logs or error messages.
//   * Unsubscribe is a single click on a token that exists only for this.
//   * The admin view is behind requireAdmin like every other admin route.

const crypto = require('crypto');

const EMAIL_MAX = 254;
const SOURCE_MAX = 80;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normaliseSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return SOURCE_PATTERN.test(source) ? source : 'blog';
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>${escapeHtml(title)} | Mentally Prepare</title></head>
<body style="margin:0;background:#0B0614;color:#F4EFF8;font-family:Helvetica,Arial,sans-serif">
<main style="max-width:520px;margin:0 auto;padding:64px 24px">
<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#B9A7D6">Mentally Prepare</p>
<h1 style="font-size:24px;line-height:1.3;margin:12px 0 16px">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.6;color:#CFC3E0">${escapeHtml(message)}</p>
<p style="margin-top:32px"><a href="/blog" style="color:#E8B4C8">Back to the blog</a></p>
</main></body></html>`;
}

function registerPromptListRoutes(app, { db, requireAdmin, authLimiter, promptLimiter }) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO prompt_subscribers (email, source, token) VALUES (?, ?, ?)'
  );
  const byToken = db.prepare('SELECT id, email, unsubscribed_at FROM prompt_subscribers WHERE token = ?');
  const unsubscribe = db.prepare(
    "UPDATE prompt_subscribers SET unsubscribed_at = datetime('now') WHERE token = ? AND unsubscribed_at IS NULL"
  );

  app.post('/api/prompt-subscribe', promptLimiter, (req, res) => {
    const email = normaliseEmail(req.body && req.body.email);
    const source = normaliseSource(req.body && req.body.source);

    if (!email || email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'That email does not look right. Check it and try once more.' });
    }

    try {
      insert.run(email, source, newToken());
    } catch (error) {
      // Never echo the address or the driver message back to the client.
      console.error('Prompt list insert failed');
      return res.status(500).json({ error: 'Could not save that just now. Try again in a moment.' });
    }

    // Same answer whether the address was new or already known.
    return res.json({ ok: true });
  });

  app.get('/prompts/unsubscribe', (req, res) => {
    const token = String((req.query && req.query.token) || '').trim();
    if (!token || !/^[a-f0-9]{32,64}$/.test(token)) {
      return res.status(400).type('html').send(page('That link is not complete',
        'The unsubscribe link needs its full code. Copy it from the email again, or reply to the email and we will remove you.'));
    }
    const row = byToken.get(token);
    if (!row) {
      return res.status(404).type('html').send(page('That link has expired',
        'We could not find that subscription. If you are still getting emails, reply to one of them and we will remove you by hand.'));
    }
    unsubscribe.run(token);
    return res.type('html').send(page('You are off the list',
      'No more prompt emails. Your address is still on the record as unsubscribed, and nothing else changes.'));
  });

  app.get('/admin/prompt-list', authLimiter, requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(
        'SELECT id, email, source, created_at, unsubscribed_at FROM prompt_subscribers ORDER BY created_at DESC'
      ).all();
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: 'Failed to load the prompt list' });
    }
  });
}

module.exports = {
  registerPromptListRoutes,
  normaliseEmail,
  normaliseSource,
  EMAIL_PATTERN,
  SOURCE_PATTERN
};
