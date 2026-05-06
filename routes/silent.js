const crypto = require('crypto');

// ─── Silent Room API Routes ───────────────────────────────────────────────────
function registerSilentRoutes(app, deps) {
  const { apiLimiter, requireAuth, db, scanForSafety, HELPLINES } = deps;

  const sl = {
    getRateCount: db.prepare(`
      SELECT COUNT(*) as c FROM silent_lines
      WHERE user_id = ?
        AND created_at >= datetime('now', 'start of day')
        AND status IN ('pending', 'approved')
    `),
    insertApproved: db.prepare(`
      INSERT INTO silent_lines (id, user_id, content, status, approved_at, expires_at)
      VALUES (?, ?, ?, 'approved', datetime('now'), datetime('now', '+7 days'))
    `),
    insertPending: db.prepare(`
      INSERT INTO silent_lines (id, user_id, content, status, expires_at)
      VALUES (?, ?, ?, 'pending', datetime('now', '+7 days'))
    `),
    setFlag: db.prepare(`UPDATE silent_lines SET moderation_flag = ? WHERE id = ?`),
    getFeed: db.prepare(`
      SELECT rowid, id, content FROM silent_lines
      WHERE status = 'approved'
        AND expires_at > datetime('now')
        AND deleted_at IS NULL
      ORDER BY rowid DESC
      LIMIT ?
    `),
    getFeedAfter: db.prepare(`
      SELECT rowid, id, content FROM silent_lines
      WHERE status = 'approved'
        AND expires_at > datetime('now')
        AND deleted_at IS NULL
        AND rowid < ?
      ORDER BY rowid DESC
      LIMIT ?
    `),
    getMine: db.prepare(`
      SELECT id, content, status, created_at, expires_at FROM silent_lines
      WHERE user_id = ?
        AND status IN ('pending', 'approved')
        AND deleted_at IS NULL
      ORDER BY created_at DESC
    `),
    getById: db.prepare(`
      SELECT id, user_id FROM silent_lines WHERE id = ? AND deleted_at IS NULL
    `),
    softDelete: db.prepare(`
      UPDATE silent_lines
      SET status = 'deleted', deleted_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status != 'deleted'
    `),
    logCrisis: db.prepare(`INSERT INTO crisis_review (user_id, content) VALUES (?, ?)`),
  };

  // POST /api/silent — submit a line
  app.post('/api/silent', apiLimiter, requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;

      // Rate limit: 3 per day
      if (sl.getRateCount.get(userId).c >= 3) {
        const tomorrow = new Date();
        tomorrow.setUTCHours(24, 0, 0, 0);
        return res.status(429).json({
          error: 'rate_limit',
          message: 'You have shared three lines today. Come back tomorrow.',
          retry_after: tomorrow.toISOString()
        });
      }

      // Validate
      const raw = req.body.content;
      if (!raw || typeof raw !== 'string') {
        return res.status(400).json({ error: 'Write something. The room is here when you\'re ready.' });
      }
      const content = raw.trim();
      if (!content) return res.status(400).json({ error: 'Write something. The room is here when you\'re ready.' });
      if (content.length > 200) return res.status(400).json({ error: 'Keep it to one line. The Silent Room is for what you can\'t fit in a longer post.' });
      if (!/\p{L}/u.test(content)) return res.status(400).json({ error: 'Use words.' });
      if (/https?:\/\/|www\./i.test(content)) return res.status(400).json({ error: 'No links here. Just words.' });

      // Crisis & PII (reuse existing scanner)
      const safety = scanForSafety(content);
      if (safety.crisis) {
        sl.logCrisis.run(userId, content);
        return res.status(200).json({
          id: null,
          status: 'crisis_intercepted',
          show_resources: true,
          message: `What you wrote matters. Before we publish, please call iCall: ${HELPLINES.iCall}. We are here. They are too.`,
          helplines: HELPLINES
        });
      }
      if (safety.pii) {
        return res.status(422).json({
          error: 'Take out anything that identifies you. The Silent Room is for what you feel, not who you are.'
        });
      }

      // OpenAI moderation (optional — only runs when OPENAI_API_KEY is set)
      let status = 'approved';
      let flag = null;
      if (process.env.OPENAI_API_KEY) {
        try {
          const mod = await callOpenAIModeration(content);
          if (mod.blocked) {
            return res.status(422).json({ error: 'The Silent Room is not for harm. Try writing what you actually feel underneath.' });
          }
          if (mod.pending) { status = 'pending'; flag = mod.flag; }
        } catch (e) {
          console.error('OpenAI moderation error, queuing for review:', e.message);
          status = 'pending';
        }
      }

      const id = 'sl_' + crypto.randomBytes(8).toString('hex');
      if (status === 'approved') {
        sl.insertApproved.run(id, userId, content);
      } else {
        sl.insertPending.run(id, userId, content, status);
        if (flag) sl.setFlag.run(flag, id);
      }

      res.status(201).json({
        id,
        status,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });
    } catch (e) {
      console.error('Silent create error:', e);
      res.status(500).json({ error: 'Failed to create line' });
    }
  });

  // GET /api/silent/feed — read the room
  app.get('/api/silent/feed', apiLimiter, requireAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 50);
      const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;
      const rows = cursor
        ? sl.getFeedAfter.all(cursor, limit)
        : sl.getFeed.all(limit);
      // Strip rowid before sending to client; use it only as the pagination cursor
      const lines = rows.map(({ id, content }) => ({ id, content }));
      const next_cursor = rows.length === limit ? rows[rows.length - 1].rowid : null;
      res.json({ lines, next_cursor });
    } catch (e) {
      console.error('Silent feed error:', e);
      res.status(500).json({ error: 'Failed to load feed' });
    }
  });

  // GET /api/silent/mine — user's own lines
  app.get('/api/silent/mine', apiLimiter, requireAuth, (req, res) => {
    try {
      res.json({ lines: sl.getMine.all(req.session.userId) });
    } catch (e) {
      console.error('Silent mine error:', e);
      res.status(500).json({ error: 'Failed to load your lines' });
    }
  });

  // DELETE /api/silent/:id — soft-delete own line
  app.delete('/api/silent/:id', apiLimiter, requireAuth, (req, res) => {
    try {
      const line = sl.getById.get(req.params.id);
      if (!line || line.user_id !== req.session.userId) {
        return res.status(404).json({ error: 'Not found' });
      }
      sl.softDelete.run(req.params.id, req.session.userId);
      res.status(204).end();
    } catch (e) {
      console.error('Silent delete error:', e);
      res.status(500).json({ error: 'Failed to delete line' });
    }
  });
}

// ─── OpenAI moderation helper ─────────────────────────────────────────────────
async function callOpenAIModeration(content) {
  const res = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: content })
  });
  if (!res.ok) throw new Error(`OpenAI API returned ${res.status}`);
  const data = await res.json();
  const c = data.results[0].categories;
  if (c.hate || c.harassment || c.sexual || c['self-harm/instructions'] || c.violence) {
    return { blocked: true };
  }
  if (c['self-harm/intent']) return { pending: true, flag: 'self_harm_review' };
  return { blocked: false, pending: false };
}

// ─── Silent Room admin routes ─────────────────────────────────────────────────
function registerSilentAdminRoutes(app, deps) {
  const { requireAdmin, db } = deps;

  // Pending moderation queue
  app.get('/admin/silent-pending', requireAdmin, (req, res) => {
    try {
      res.json(db.prepare(`
        SELECT id, content, created_at, moderation_flag, user_id
        FROM silent_lines
        WHERE status = 'pending' AND deleted_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at ASC LIMIT 50
      `).all());
    } catch (e) { res.status(500).json({ error: 'Failed to load pending lines' }); }
  });

  app.post('/admin/silent/approve/:id', requireAdmin, (req, res) => {
    try {
      const r = db.prepare(
        `UPDATE silent_lines SET status='approved', approved_at=datetime('now') WHERE id=? AND status='pending'`
      ).run(req.params.id);
      if (!r.changes) return res.status(404).json({ error: 'Not found or already processed' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to approve' }); }
  });

  app.post('/admin/silent/reject/:id', requireAdmin, (req, res) => {
    try {
      const r = db.prepare(
        `UPDATE silent_lines SET status='rejected' WHERE id=? AND status='pending'`
      ).run(req.params.id);
      if (!r.changes) return res.status(404).json({ error: 'Not found or already processed' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to reject' }); }
  });

  // Crisis intercepts log
  app.get('/admin/silent-flagged', requireAdmin, (req, res) => {
    try {
      res.json(db.prepare(
        `SELECT id, user_id, content, created_at FROM crisis_review ORDER BY created_at DESC LIMIT 50`
      ).all());
    } catch (e) { res.status(500).json({ error: 'Failed to load flagged content' }); }
  });

  // Manual cleanup trigger (Railway cron also calls this)
  app.post('/admin/silent/cleanup', requireAdmin, (req, res) => {
    try {
      const r = db.prepare(`
        DELETE FROM silent_lines
        WHERE expires_at < datetime('now')
           OR (deleted_at IS NOT NULL AND deleted_at < datetime('now', '-1 day'))
      `).run();
      res.json({ ok: true, deleted: r.changes });
    } catch (e) { res.status(500).json({ error: 'Cleanup failed' }); }
  });
}

module.exports = { registerSilentRoutes, registerSilentAdminRoutes };
