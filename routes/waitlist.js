function registerWaitlistRoutes(app, { apiLimiter, db, requireAdmin }) {
  app.get('/api/waitlist/count', apiLimiter, (req, res) => {
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM waitlist').get().c;
      res.json({ count });
    } catch {
      res.json({ count: 0 });
    }
  });

  app.post('/api/waitlist', apiLimiter, (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const college = String(req.body.college || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const year = String(req.body.year || '').trim();
      const archetype = req.body.archetype ? String(req.body.archetype).trim().toLowerCase() : null;

      if (!name || !email || !college) {
        return res.status(400).json({ error: 'Name, email and college are required' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email' });
      }

      const validArchetypes = ['protector', 'connector', 'performer', 'disconnector'];
      if (archetype && !validArchetypes.includes(archetype)) {
        return res.status(400).json({ error: 'Invalid archetype' });
      }

      const existing = db.prepare('SELECT id FROM waitlist WHERE email = ?').get(email);
      if (existing) {
        const position = db.prepare('SELECT COUNT(*) as c FROM waitlist WHERE id <= ?').get(existing.id).c;
        return res.json({ ok: true, position, alreadyExists: true });
      }

      const result = db.prepare(`
        INSERT INTO waitlist (name, email, college, year, archetype)
        VALUES (?, ?, ?, ?, ?)
      `).run(name, email, college, year || '', archetype || '');
      const position = db.prepare('SELECT COUNT(*) as c FROM waitlist WHERE id <= ?').get(result.lastInsertRowid).c;
      console.log(`  ✦ Waitlist signup: ${name} from ${college} (#${position})`);
      res.json({ ok: true, position });
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        const existing = db.prepare('SELECT id FROM waitlist WHERE email = ?').get(req.body.email?.toLowerCase().trim());
        if (existing) {
          const position = db.prepare('SELECT COUNT(*) as c FROM waitlist WHERE id <= ?').get(existing.id).c;
          return res.json({ ok: true, position, alreadyExists: true });
        }
      }
      console.error('Waitlist error:', e);
      res.status(500).json({ error: 'Failed to join waitlist' });
    }
  });

  app.get('/admin/waitlist', requireAdmin, (req, res) => {
    try {
      const entries = db.prepare('SELECT * FROM waitlist ORDER BY created_at DESC').all();
      res.json(entries);
    } catch (e) {
      res.status(500).json({ error: 'Failed to load waitlist' });
    }
  });
}

module.exports = {
  registerWaitlistRoutes
};
