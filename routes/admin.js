const path = require('path');

function registerAdminRoutes(app, deps) {
  const {
    rootDir,
    db,
    stmts,
    requireAdmin,
    getAdminStats,
    getMatchDay,
    findUserByIdentifier,
    complementary,
    deleteUserDataTx,
    deleteMatchData
  } = deps;

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'admin.html'));
  });

  app.post('/admin/announce', requireAdmin, (req, res) => {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
    console.log('[ADMIN ANNOUNCEMENT]', message);
    res.json({ ok: true });
  });

  app.get('/admin/reports', requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT r.id, r.reporter_id, r.day, r.reason, r.created_at, u.name as reporter_name
        FROM reports r
        LEFT JOIN users u ON u.id = r.reporter_id
        ORDER BY r.created_at DESC
        LIMIT 20
      `).all();
      res.json(rows.map(r => ({
        id: r.id,
        reporter_id: r.reporter_id,
        reporter_name: r.reporter_name,
        day: r.day,
        reason: r.reason,
        date: r.created_at
      })));
    } catch (e) {
      res.status(500).json({ error: 'Failed to load reports' });
    }
  });

  app.get('/admin/users', requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT
          u.id, u.name, u.email, u.college, u.year, u.archetype, u.created_at,
          EXISTS (
            SELECT 1 FROM matches m WHERE m.user1_id = u.id OR m.user2_id = u.id
          ) as has_match
        FROM users u
        ORDER BY u.created_at DESC
      `).all();
      res.json(rows.map(row => ({ ...row, has_match: !!row.has_match })));
    } catch (e) {
      res.status(500).json({ error: 'Failed to load users' });
    }
  });

  app.get('/admin/stats', requireAdmin, (req, res) => {
    try {
      res.json(getAdminStats());
    } catch (e) {
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });

  app.get('/admin/activity', requireAdmin, (req, res) => {
    try {
      const activity = [
        ...db.prepare(`
          SELECT created_at, 'register' as type, name || ' joined from ' || college as message
          FROM users
          ORDER BY created_at DESC
          LIMIT 8
        `).all(),
        ...db.prepare(`
          SELECT m.started_at as created_at, 'match' as type, u1.name || ' matched with ' || u2.name as message
          FROM matches m
          JOIN users u1 ON u1.id = m.user1_id
          JOIN users u2 ON u2.id = m.user2_id
          ORDER BY m.started_at DESC
          LIMIT 8
        `).all(),
        ...db.prepare(`
          SELECT e.created_at, 'entry' as type, u.name || ' wrote Day ' || e.day || ' in match #' || e.match_id as message
          FROM entries e
          JOIN users u ON u.id = e.user_id
          ORDER BY e.created_at DESC
          LIMIT 8
        `).all(),
        ...db.prepare(`
          SELECT r.created_at, 'report' as type, 'Report from ' || COALESCE(u.name, 'user #' || r.reporter_id) || ': ' || r.reason as message
          FROM reports r
          LEFT JOIN users u ON u.id = r.reporter_id
          ORDER BY r.created_at DESC
          LIMIT 8
        `).all(),
        ...db.prepare(`
          SELECT rv.created_at, 'reveal' as type, u.name || ' chose ' || rv.choice || ' on reveal day' as message
          FROM reveals rv
          JOIN users u ON u.id = rv.user_id
          ORDER BY rv.created_at DESC
          LIMIT 8
        `).all(),
        ...db.prepare(`
          SELECT deleted_at as created_at, 'delete' as type, 'User data deleted (' || reason || ')' as message
          FROM deletion_log
          ORDER BY deleted_at DESC
          LIMIT 5
        `).all()
      ]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 12);
      res.json(activity);
    } catch (e) {
      res.status(500).json({ error: 'Failed to load activity' });
    }
  });

  app.post('/admin/manual-match', requireAdmin, (req, res) => {
    try {
      const userA = findUserByIdentifier(req.body.user1_id);
      const userB = findUserByIdentifier(req.body.user2_id);
      if (!userA || !userB) return res.status(404).json({ error: 'Both users must exist' });
      if (userA.id === userB.id) return res.status(400).json({ error: 'Choose two different users' });
      if (!userA.archetype || !userB.archetype) return res.status(400).json({ error: 'Both users must complete the scan first' });
      if (userA.college.trim().toLowerCase() === userB.college.trim().toLowerCase()) {
        return res.status(400).json({ error: 'Users must be from different colleges' });
      }
      if (complementary[userA.archetype] !== userB.archetype) {
        return res.status(400).json({ error: 'Archetypes are not complementary' });
      }
      if (stmts.getMatch.get(userA.id, userA.id) || stmts.getMatch.get(userB.id, userB.id)) {
        return res.status(400).json({ error: 'One or both users are already matched' });
      }
      const result = stmts.insertMatch.run(userA.id, userB.id);
      res.json({ ok: true, match_id: result.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ error: 'Failed to create manual match' });
    }
  });

  app.post('/admin/remove-user', requireAdmin, (req, res) => {
    try {
      const user = findUserByIdentifier(req.body.user_id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      deleteUserDataTx(user.id, 'admin_removed');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to remove user' });
    }
  });

  app.post('/admin/end-match', requireAdmin, (req, res) => {
    try {
      const matchId = Number(req.body.match_id);
      if (!Number.isInteger(matchId) || matchId <= 0) return res.status(400).json({ error: 'Valid match ID required' });
      const match = db.prepare('SELECT id FROM matches WHERE id = ?').get(matchId);
      if (!match) return res.status(404).json({ error: 'Match not found' });
      db.transaction(() => deleteMatchData(matchId))();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to end match' });
    }
  });

  app.post('/admin/dismiss-report', requireAdmin, (req, res) => {
    try {
      const reportId = Number(req.body.report_id);
      if (!Number.isInteger(reportId) || reportId <= 0) return res.status(400).json({ error: 'Valid report ID required' });
      const result = stmts.deleteReportById.run(reportId);
      if (!result.changes) return res.status(404).json({ error: 'Report not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to dismiss report' });
    }
  });

  app.get('/admin/export', requireAdmin, (req, res) => {
    try {
      const exportData = {
        exported_at: new Date().toISOString(),
        users: db.prepare('SELECT id, name, email, college, year, archetype, consent_given, created_at, last_active_date FROM users ORDER BY id').all(),
        matches: db.prepare('SELECT * FROM matches ORDER BY id').all(),
        entries: db.prepare('SELECT * FROM entries ORDER BY id').all(),
        reveals: db.prepare('SELECT * FROM reveals ORDER BY id').all(),
        comments: db.prepare('SELECT * FROM comments ORDER BY id').all(),
        reports: db.prepare('SELECT * FROM reports ORDER BY id').all(),
        payments: db.prepare('SELECT id, user_id, provider, provider_payment_id, provider_order_id, amount, currency, product, status, created_at, updated_at FROM payments ORDER BY id').all(),
        deletion_log: db.prepare('SELECT * FROM deletion_log ORDER BY id').all()
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="mentally-prepare-admin-export.json"');
      res.json(exportData);
    } catch (e) {
      console.error('Admin export error:', e);
      res.status(500).json({ error: 'Failed to export data' });
    }
  });
}

module.exports = {
  registerAdminRoutes
};
