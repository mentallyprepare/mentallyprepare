'use strict';

// The Shelf. See mentally-prepare-mobile/docs/proposal-shelf-contract.md.
//
// Five fixed slots per user: song_a, song_b, film, book, memory.
// - GET  /api/shelf                    -> my shelf
// - GET  /api/shelf/user/:userId       -> match (unlock-schedule respecting)
//                                         or discovery-surfaced user (memory hidden)
// - PUT  /api/shelf/:kind              -> upsert one slot
// - DELETE /api/shelf/:kind            -> clear one slot
//
// Notes: everything runs through the shared PII scanner. Memory is never
// visible on Discover; on the match it is only revealed at Day-21 mirror
// (still to build) — for now it is always hidden to the partner.

const KINDS = ['song_a', 'song_b', 'film', 'book', 'memory'];
const KINDS_SET = new Set(KINDS);
const MAX_TITLE = 120;
const MAX_DETAIL = 120;
const MAX_MEMORY = 240; // memory uses `title`; higher cap than name-shaped items

// Unlock schedule when viewing a matched partner's shelf. Days are the
// current match day; a shelf entry unlocks on/after its unlock day.
const PARTNER_UNLOCK_DAY = {
  song_a: 3,
  song_b: 7,
  book: 14,
  film: 21,
  memory: null, // gated by Day-21 mirror consent, not yet built
};

module.exports = function registerShelfRoutes(app, deps) {
  const {
    apiLimiter,
    requireAuth,
    stmts,
    db,
    scanForSafety,
    getMatch,
    getMatchDay,
    getPartnerId,
  } = deps;

  const selectByUser = db.prepare(
    `SELECT kind, title, detail, external_id, artwork_url, created_at, updated_at
     FROM shelf_items WHERE user_id = ? ORDER BY kind`
  );
  const selectOne = db.prepare(
    `SELECT * FROM shelf_items WHERE user_id = ? AND kind = ?`
  );
  const upsertOne = db.prepare(
    `INSERT INTO shelf_items (user_id, kind, title, detail, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, kind) DO UPDATE SET
       title = excluded.title,
       detail = excluded.detail,
       updated_at = datetime('now')`
  );
  const deleteOne = db.prepare(
    `DELETE FROM shelf_items WHERE user_id = ? AND kind = ?`
  );

  function serialize(row) {
    return {
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      artworkUrl: row.artwork_url,
      updatedAt: row.updated_at,
    };
  }

  // GET /api/shelf — my shelf, all five slots visible.
  app.get('/api/shelf', apiLimiter, requireAuth, (req, res) => {
    try {
      const rows = selectByUser.all(req.session.userId);
      res.json({ items: rows.map(serialize) });
    } catch (e) {
      console.error('shelf: my read failed', e);
      res.status(500).json({ error: 'Could not load shelf' });
    }
  });

  // PUT /api/shelf/:kind — upsert one slot.
  app.put('/api/shelf/:kind', apiLimiter, requireAuth, (req, res) => {
    try {
      const kind = String(req.params.kind || '').trim();
      if (!KINDS_SET.has(kind)) {
        return res.status(400).json({ error: 'Unknown shelf kind' });
      }
      const title = String((req.body && req.body.title) || '').trim();
      const detail = req.body && req.body.detail != null
        ? String(req.body.detail).trim() || null
        : null;

      if (!title) return res.status(400).json({ error: 'Title required' });
      const titleCap = kind === 'memory' ? MAX_MEMORY : MAX_TITLE;
      if (title.length > titleCap) {
        return res.status(400).json({ error: `Title too long (max ${titleCap})` });
      }
      if (detail && detail.length > MAX_DETAIL) {
        return res.status(400).json({ error: `Detail too long (max ${MAX_DETAIL})` });
      }

      // PII scan the full input. Memory is the trickiest here: real names and
      // places surface easily. Rejected 422 exactly like /api/entry.
      const safety = scanForSafety([title, detail].filter(Boolean).join(' '));
      if (safety.pii && !(req.body && req.body.piiConfirmed)) {
        return res.status(422).json({
          error: 'This may reveal who you are. Please remove personal details to keep this space anonymous.',
          code: 'pii_detected',
          safety: { pii: true, piiFlags: safety.piiFlags },
        });
      }

      upsertOne.run(req.session.userId, kind, title, detail);
      const row = selectOne.get(req.session.userId, kind);
      res.json({ ok: true, item: serialize(row) });
    } catch (e) {
      console.error('shelf: upsert failed', e);
      res.status(500).json({ error: 'Could not save this' });
    }
  });

  // DELETE /api/shelf/:kind — clear one slot.
  app.delete('/api/shelf/:kind', apiLimiter, requireAuth, (req, res) => {
    try {
      const kind = String(req.params.kind || '').trim();
      if (!KINDS_SET.has(kind)) {
        return res.status(400).json({ error: 'Unknown shelf kind' });
      }
      deleteOne.run(req.session.userId, kind);
      res.json({ ok: true });
    } catch (e) {
      console.error('shelf: delete failed', e);
      res.status(500).json({ error: 'Could not clear this' });
    }
  });

  // GET /api/shelf/user/:userId — someone else's shelf, unlock-respecting.
  // Returns 404 rather than 403 for out-of-scope viewers so existence does
  // not leak. Memory is never included in this response.
  app.get('/api/shelf/user/:userId', apiLimiter, requireAuth, (req, res) => {
    try {
      const viewerId = req.session.userId;
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Currently only the matched partner is a valid viewing scope. Discovery
      // will add its own path once /api/discover/today lands.
      const match = getMatch ? getMatch.get(viewerId, viewerId) : null;
      const partnerId = match ? getPartnerId(match, viewerId) : null;
      if (!partnerId || partnerId !== targetId) {
        return res.status(404).json({ error: 'Not found' });
      }
      const day = getMatchDay(match.started_at);

      const rows = selectByUser.all(targetId).filter((r) => {
        if (r.kind === 'memory') return false; // never exposed to partner via shelf
        const unlockDay = PARTNER_UNLOCK_DAY[r.kind];
        return typeof unlockDay === 'number' && day >= unlockDay;
      });
      res.json({ items: rows.map(serialize) });
    } catch (e) {
      console.error('shelf: partner read failed', e);
      res.status(500).json({ error: 'Could not load' });
    }
  });
};

module.exports.KINDS = KINDS;
