// ─── Rooms — Routes ───
// Anonymous topic walls: support-need selector, reactions, and free-text peer
// comments under a moderation floor. Crisis detection runs on both cards and
// comments. No endpoint ever returns author_id to the client.

const CARD_TTL_HOURS = 12;
const NEEDS = ['listen', 'think', 'share', 'encourage', 'quiet'];
const REACTIONS = ['relate', 'listening', 'notalone', 'support'];
const CARD_MAX = 400;
const COMMENT_MAX = 280;
const MAX_CARDS_PER_HOUR = 1;
const MAX_COMMENTS_PER_10MIN = 5;
const AUTO_HIDE_REPORTS = 2; // hide a comment after N distinct reports

function registerRoomsRoutes(app, deps) {
  const { apiLimiter, requireAuth, db, scanForSafety, getCrisisPayload, trackEvent } = deps;

  const stmts = {
    roomBySlug: db.prepare('SELECT * FROM rooms WHERE slug = ? AND is_active = 1'),
    activeRooms: db.prepare('SELECT slug, name, subtitle, is_frozen FROM rooms WHERE is_active = 1 ORDER BY id ASC'),
    cardsForRoom: db.prepare(`
      SELECT id, support_need, body, created_at, expires_at
      FROM room_cards
      WHERE room_id = ? AND is_held = 0 AND expires_at > datetime('now')
      ORDER BY created_at DESC
    `),
    insertCard: db.prepare(`
      INSERT INTO room_cards (room_id, author_id, support_need, body, is_held, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+${CARD_TTL_HOURS} hours'))
    `),
    cardById: db.prepare("SELECT * FROM room_cards WHERE id = ? AND expires_at > datetime('now')"),
    roomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    cardCountLastHour: db.prepare(`
      SELECT COUNT(*) as count FROM room_cards
      WHERE author_id = ? AND is_seed = 0 AND created_at > datetime('now', '-1 hour')
    `),
    commentsForCard: db.prepare(`
      SELECT id, body, created_at FROM room_comments
      WHERE card_id = ? AND is_held = 0 ORDER BY created_at ASC
    `),
    commentCountForCard: db.prepare(
      'SELECT COUNT(*) as count FROM room_comments WHERE card_id = ? AND is_held = 0'
    ),
    insertComment: db.prepare(
      'INSERT INTO room_comments (card_id, author_id, body, is_held) VALUES (?, ?, ?, ?)'
    ),
    commentCountLast10Min: db.prepare(`
      SELECT COUNT(*) as count FROM room_comments
      WHERE author_id = ? AND created_at > datetime('now', '-10 minutes')
    `),
    reactCounts: db.prepare(
      'SELECT kind, COUNT(*) as n FROM room_reactions WHERE card_id = ? GROUP BY kind'
    ),
    myReactions: db.prepare(
      'SELECT kind FROM room_reactions WHERE card_id = ? AND user_id = ?'
    ),
    reactIn: db.prepare(
      'INSERT OR IGNORE INTO room_reactions (card_id, user_id, kind) VALUES (?, ?, ?)'
    ),
    reactOut: db.prepare(
      'DELETE FROM room_reactions WHERE card_id = ? AND user_id = ? AND kind = ?'
    ),
    commentById: db.prepare('SELECT * FROM room_comments WHERE id = ?'),
    addReport: db.prepare(
      'INSERT OR IGNORE INTO room_reports (comment_id, reporter_id) VALUES (?, ?)'
    ),
    bumpReport: db.prepare(
      'UPDATE room_comments SET report_count = report_count + 1 WHERE id = ?'
    ),
    holdComment: db.prepare('UPDATE room_comments SET is_held = 1 WHERE id = ?'),
    logCrisis: db.prepare('INSERT INTO crisis_review (user_id, content) VALUES (?, ?)'),
  };

  function countsObj(cardId) {
    const out = { relate: 0, listening: 0, notalone: 0, support: 0 };
    for (const row of stmts.reactCounts.all(cardId)) out[row.kind] = row.n;
    return out;
  }

  // GET /api/rooms — list active rooms
  app.get('/api/rooms', apiLimiter, requireAuth, (req, res) => {
    try {
      const rooms = stmts.activeRooms.all().map(r => ({
        slug: r.slug, name: r.name, subtitle: r.subtitle, frozen: !!r.is_frozen,
      }));
      res.json({ rooms });
    } catch (e) {
      console.error('Rooms list error:', e);
      res.status(500).json({ error: 'Failed to load rooms' });
    }
  });

  // GET /api/rooms/:slug/cards — the wall (anonymous; never returns author_id)
  app.get('/api/rooms/:slug/cards', apiLimiter, requireAuth, (req, res) => {
    try {
      const room = stmts.roomBySlug.get(req.params.slug);
      if (!room) return res.status(404).json({ error: 'No such room' });

      const cards = stmts.cardsForRoom.all(room.id).map(c => ({
        id: c.id,
        support_need: c.support_need,
        body: c.body,
        created_at: c.created_at,
        expires_at: c.expires_at,
        reactions: countsObj(c.id),
        comment_count: stmts.commentCountForCard.get(c.id).count,
      }));

      res.json({
        room: { slug: room.slug, name: room.name, subtitle: room.subtitle, frozen: !!room.is_frozen },
        cards,
      });
    } catch (e) {
      console.error('Rooms cards error:', e);
      res.status(500).json({ error: 'Failed to load the room' });
    }
  });

  // POST /api/rooms/:slug/cards — post a card
  app.post('/api/rooms/:slug/cards', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const room = stmts.roomBySlug.get(req.params.slug);
      if (!room) return res.status(404).json({ error: 'No such room' });
      if (room.is_frozen) return res.status(423).json({ error: 'This room is paused for a moment.' });

      const need = String(req.body.support_need || '');
      const body = String(req.body.body || '').trim();
      if (!NEEDS.includes(need)) return res.status(400).json({ error: 'Pick a support need' });
      if (!body || body.length > CARD_MAX) {
        return res.status(400).json({ error: `Card required, max ${CARD_MAX} characters` });
      }

      if (stmts.cardCountLastHour.get(userId).count >= MAX_CARDS_PER_HOUR) {
        return res.status(429).json({ error: 'One card per hour. Rest a moment.' });
      }

      const safety = scanForSafety(body);
      if (safety.crisis) {
        stmts.insertCard.run(room.id, userId, need, body, 1);
        stmts.logCrisis.run(userId, body);
        if (trackEvent) trackEvent(userId, 'crisis_keyword_triggered', { surface: 'room_card', room: room.slug });
        const crisis = getCrisisPayload(req);
        return res.json({ held: true, crisis: true, helplines: crisis.helplines, message: crisis.message });
      }

      const info = stmts.insertCard.run(room.id, userId, need, body, 0);
      res.json({ held: false, card_id: info.lastInsertRowid });
    } catch (e) {
      console.error('Rooms post-card error:', e);
      res.status(500).json({ error: 'Failed to post card' });
    }
  });

  // GET /api/cards/:id/comments — a card and its thread
  app.get('/api/cards/:id/comments', apiLimiter, requireAuth, (req, res) => {
    try {
      const card = stmts.cardById.get(req.params.id);
      if (!card) return res.status(404).json({ error: 'This card has faded' });
      res.json({
        card: {
          id: card.id,
          support_need: card.support_need,
          body: card.body,
          reactions: countsObj(card.id),
        },
        comments: stmts.commentsForCard.all(card.id),
      });
    } catch (e) {
      console.error('Rooms comments error:', e);
      res.status(500).json({ error: 'Failed to load comments' });
    }
  });

  // POST /api/cards/:id/comments — a peer comment (crisis-checked too)
  app.post('/api/cards/:id/comments', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const card = stmts.cardById.get(req.params.id);
      if (!card) return res.status(404).json({ error: 'This card has faded' });

      const room = stmts.roomById.get(card.room_id);
      if (room && room.is_frozen) return res.status(423).json({ error: 'This room is paused for a moment.' });

      const body = String(req.body.body || '').trim();
      if (!body || body.length > COMMENT_MAX) {
        return res.status(400).json({ error: `Comment required, max ${COMMENT_MAX} characters` });
      }

      if (stmts.commentCountLast10Min.get(userId).count >= MAX_COMMENTS_PER_10MIN) {
        return res.status(429).json({ error: 'Slow down a little.' });
      }

      const safety = scanForSafety(body);
      if (safety.crisis) {
        stmts.insertComment.run(card.id, userId, body, 1);
        stmts.logCrisis.run(userId, body);
        if (trackEvent) trackEvent(userId, 'crisis_keyword_triggered', { surface: 'room_comment' });
        const crisis = getCrisisPayload(req);
        return res.json({ held: true, crisis: true, helplines: crisis.helplines, message: crisis.message });
      }

      const info = stmts.insertComment.run(card.id, userId, body, 0);
      res.json({ held: false, comment_id: info.lastInsertRowid });
    } catch (e) {
      console.error('Rooms post-comment error:', e);
      res.status(500).json({ error: 'Failed to post comment' });
    }
  });

  // POST /api/cards/:id/react — toggle a reaction
  app.post('/api/cards/:id/react', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const kind = String(req.body.kind || '');
      if (!REACTIONS.includes(kind)) return res.status(400).json({ error: 'Unknown reaction' });

      const card = stmts.cardById.get(req.params.id);
      if (!card) return res.status(404).json({ error: 'This card has faded' });

      const del = stmts.reactOut.run(card.id, userId, kind);
      const on = del.changes === 0;
      if (on) stmts.reactIn.run(card.id, userId, kind);

      const mine = stmts.myReactions.all(card.id, userId).map(r => r.kind);
      res.json({ reactions: countsObj(card.id), on, mine });
    } catch (e) {
      console.error('Rooms react error:', e);
      res.status(500).json({ error: 'Failed to react' });
    }
  });

  // POST /api/comments/:id/report — hides a comment after the threshold
  app.post('/api/comments/:id/report', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const comment = stmts.commentById.get(req.params.id);
      if (!comment) return res.status(404).json({ error: 'gone' });

      const added = stmts.addReport.run(comment.id, userId);
      if (added.changes === 0) return res.json({ ok: true }); // already reported by this user

      stmts.bumpReport.run(comment.id);
      const fresh = stmts.commentById.get(comment.id);
      const hidden = fresh.report_count >= AUTO_HIDE_REPORTS;
      if (hidden) stmts.holdComment.run(comment.id);
      res.json({ ok: true, hidden });
    } catch (e) {
      console.error('Rooms report error:', e);
      res.status(500).json({ error: 'Failed to report' });
    }
  });
}

function registerRoomsAdminRoutes(app, deps) {
  const { requireAdmin, authLimiter, db } = deps;

  // Held + high-report comments needing a decision
  app.get('/admin/rooms-reports', authLimiter, requireAdmin, (req, res) => {
    try {
      res.json(db.prepare(`
        SELECT id, card_id, body, is_held, report_count, created_at
        FROM room_comments
        WHERE is_held = 1 OR report_count > 0
        ORDER BY report_count DESC, created_at DESC
        LIMIT 100
      `).all());
    } catch (e) { res.status(500).json({ error: 'Failed to load reports' }); }
  });

  // Restore a held comment back to the wall
  app.post('/admin/rooms/comments/:id/restore', authLimiter, requireAdmin, (req, res) => {
    try {
      const r = db.prepare(
        'UPDATE room_comments SET is_held = 0, report_count = 0 WHERE id = ?'
      ).run(req.params.id);
      if (!r.changes) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to restore' }); }
  });

  // Permanently remove a comment
  app.post('/admin/rooms/comments/:id/remove', authLimiter, requireAdmin, (req, res) => {
    try {
      const r = db.prepare('UPDATE room_comments SET is_held = 1 WHERE id = ?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to remove' }); }
  });

  // Kill switch — freeze/unfreeze a room (blocks new cards and comments)
  app.post('/admin/rooms/:slug/freeze', authLimiter, requireAdmin, (req, res) => {
    try {
      const frozen = req.body.frozen ? 1 : 0;
      const r = db.prepare('UPDATE rooms SET is_frozen = ? WHERE slug = ?').run(frozen, req.params.slug);
      if (!r.changes) return res.status(404).json({ error: 'No such room' });
      res.json({ ok: true, frozen: !!frozen });
    } catch (e) { res.status(500).json({ error: 'Failed to update room' }); }
  });
}

module.exports = { registerRoomsRoutes, registerRoomsAdminRoutes };
