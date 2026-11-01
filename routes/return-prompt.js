const path = require('path');
const crypto = require('crypto');
const { logAdminAction } = require('../lib/admin-auth');
const { returnPromptEmail } = require('../lib/email');

const MAX_RECIPIENTS = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function registerReturnPromptRoutes(app, { db, rootDir, requireAdmin, authLimiter, sendReturnPrompt, getReminderUnsubscribeUrl, emailServiceEnabled }) {
  const eligible = db.prepare(`
    SELECT u.id AS user_id, u.name, u.email
    FROM reauth_followup_deliveries f
    JOIN users u ON u.id = f.user_id
    WHERE f.status = 'sent' AND f.attempted_at <= datetime('now', '-7 days')
      AND COALESCE(u.account_status, 'active') != 'deleted'
      AND u.email_verified = 1
      AND CASE WHEN json_valid(u.push_preferences) THEN json_extract(u.push_preferences, '$.emailReminders') ELSE 0 END = 1
      AND u.archetype IS NULL
      AND (u.last_login_at IS NULL OR datetime(u.last_login_at) < datetime(u.auth_reset_at, 'unixepoch'))
      AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id AND e.event_name = 'login'
        AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch'))
      AND NOT EXISTS (SELECT 1 FROM return_prompt_deliveries d WHERE d.user_id = u.id)
    ORDER BY (SELECT COUNT(*) FROM entries e WHERE e.user_id = u.id) DESC,
      COALESCE(u.last_active_date, u.created_at) DESC, u.id ASC
  `);
  const stillEligible = db.prepare(`
    SELECT 1 FROM users u JOIN reauth_followup_deliveries f ON f.user_id = u.id
    WHERE u.id = ? AND lower(trim(u.email)) = lower(trim(?))
      AND f.status = 'sent' AND f.attempted_at <= datetime('now', '-7 days')
      AND COALESCE(u.account_status, 'active') != 'deleted' AND u.email_verified = 1
      AND CASE WHEN json_valid(u.push_preferences) THEN json_extract(u.push_preferences, '$.emailReminders') ELSE 0 END = 1
      AND u.archetype IS NULL
      AND (u.last_login_at IS NULL OR datetime(u.last_login_at) < datetime(u.auth_reset_at, 'unixepoch'))
      AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id AND e.event_name = 'login'
        AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch'))
  `);
  const recipientHash = rows => crypto.createHash('sha256').update(rows.map(row => `${row.user_id}:${row.email.toLowerCase()}`).join(',')).digest('hex');
  function recipientsNow() {
    const alreadyQueued = db.prepare('SELECT COUNT(*) AS count FROM return_prompt_deliveries').get().count;
    const remaining = Math.max(0, MAX_RECIPIENTS - alreadyQueued);
    if (!remaining) return [];
    const seen = new Set();
    return eligible.all().filter(row => {
      const email = String(row.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || seen.has(email)) return false;
      seen.add(email);
      return true;
    }).slice(0, remaining);
  }
  const utc = date => date.toISOString().replace('T', ' ').slice(0, 19);
  let sending = false;

  async function processNext() {
    if (sending || !emailServiceEnabled || typeof sendReturnPrompt !== 'function') return;
    db.prepare("UPDATE return_prompt_deliveries SET status = 'uncertain' WHERE status = 'sending' AND attempted_at <= datetime('now', '-10 minutes')").run();
    const row = db.prepare("SELECT * FROM return_prompt_deliveries WHERE status = 'pending' ORDER BY user_id LIMIT 1").get();
    if (!row || (row.next_attempt_at && row.next_attempt_at > utc(new Date()))) return;
    if (db.prepare("UPDATE return_prompt_deliveries SET status = 'sending', attempted_at = datetime('now') WHERE user_id = ? AND status = 'pending'").run(row.user_id).changes !== 1) return;
    sending = true;
    try {
      if (!stillEligible.get(row.user_id, row.email)) {
        db.prepare("UPDATE return_prompt_deliveries SET status = 'skipped' WHERE user_id = ?").run(row.user_id);
        return;
      }
      await sendReturnPrompt(row.email, row.name, getReminderUnsubscribeUrl(row.user_id));
      db.prepare("UPDATE return_prompt_deliveries SET status = 'sent' WHERE user_id = ?").run(row.user_id);
    } catch (error) {
      if (error.statusCode === 429) {
        const now = new Date();
        const code = String(error.providerCode || '').toLowerCase();
        let next = new Date(now.getTime() + Math.max(Number(error.retryAfter) || 300, 60) * 1000);
        if (code === 'daily_quota_exceeded') next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
        if (code === 'monthly_quota_exceeded') next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5));
        db.prepare("UPDATE return_prompt_deliveries SET status = 'pending', next_attempt_at = ? WHERE user_id = ?").run(utc(next), row.user_id);
      } else {
        db.prepare("UPDATE return_prompt_deliveries SET status = 'failed' WHERE user_id = ?").run(row.user_id);
        console.error('Return prompt delivery failed; review Founder dashboard.');
      }
    } finally {
      sending = false;
    }
  }

  const timer = setInterval(() => processNext().catch(error => console.error('Return prompt worker failed:', error)), 1800);
  if (timer.unref) timer.unref();

  app.get('/admin/return-prompt', (req, res) => res.sendFile(path.join(rootDir, 'public', 'admin-return-prompt.html')));
  app.get('/admin/return-prompt/preview', authLimiter, requireAdmin, (req, res) => {
    if (req.admin.role !== 'admin' || req.admin.legacy) return res.status(403).json({ error: 'A named founder admin is required' });
    const recipients = recipientsNow();
    const statuses = db.prepare('SELECT status, COUNT(*) AS count FROM return_prompt_deliveries GROUP BY status').all();
    const nextAttempt = db.prepare("SELECT next_attempt_at FROM return_prompt_deliveries WHERE status = 'pending' AND next_attempt_at IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1").get();
    res.json({ ok: true, eligible: recipients.length, maxRecipients: MAX_RECIPIENTS,
      recipients: recipients.map(row => ({ userId: row.user_id, email: row.email })), recipientHash: recipientHash(recipients),
      statuses, nextAttemptAt: nextAttempt?.next_attempt_at || null,
      canStart: recipients.length > 0 && !!emailServiceEnabled && typeof sendReturnPrompt === 'function',
      sample: returnPromptEmail('friend', '[personal unsubscribe link]') });
  });
  app.post('/admin/return-prompt/start', authLimiter, requireAdmin, (req, res) => {
    if (req.admin.role !== 'admin' || req.admin.legacy) return res.status(403).json({ error: 'A named founder admin is required' });
    if (!emailServiceEnabled || typeof sendReturnPrompt !== 'function') return res.status(503).json({ error: 'Email delivery is not configured' });
    if (req.body?.confirmation !== 'SEND RETURN PROMPT') return res.status(400).json({ error: 'Confirm SEND RETURN PROMPT' });
    const queued = db.transaction(() => {
      const recipients = recipientsNow();
      if (!recipients.length) return 0;
      if (req.body?.recipientHash !== recipientHash(recipients)) return -1;
      const insert = db.prepare('INSERT OR IGNORE INTO return_prompt_deliveries (user_id, email, name) VALUES (?, ?, ?)');
      return recipients.reduce((count, row) => count + insert.run(row.user_id, row.email, row.name || '').changes, 0);
    })();
    if (queued < 0) return res.status(409).json({ error: 'Recipient list changed. Review the preview again.' });
    if (!queued) return res.status(409).json({ error: 'No eligible past users remain' });
    logAdminAction(db, req, 'email.return_prompt_queued', { metadata: { queued } });
    res.status(202).json({ ok: true, queued });
    processNext().catch(error => console.error('Return prompt worker failed:', error));
  });
}

module.exports = { registerReturnPromptRoutes };
