function registerWaitlistRoutes(app, { apiLimiter, db, requireAdmin, sendWaitlistConfirmation }) {
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
      const email = String(req.body.email || '').trim().toLowerCase();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email' });
      }

      const existing = db.prepare('SELECT id FROM waitlist WHERE email = ?').get(email);
      if (existing) {
        const position = db.prepare('SELECT COUNT(*) as c FROM waitlist WHERE id <= ?').get(existing.id).c;
        return res.json({ ok: true, position, alreadyExists: true });
      }

      // Insert only name and email, other fields left blank for compatibility
      const result = db.prepare(`
        INSERT INTO waitlist (name, email, college, year, archetype)
        VALUES (?, ?, '', '', '')
      `).run(name, email);
      const position = db.prepare('SELECT COUNT(*) as c FROM waitlist WHERE id <= ?').get(result.lastInsertRowid).c;
      console.log(`  âœ¦ Waitlist signup: ${name} (#${position})`);

      if (sendWaitlistConfirmation) {
        sendWaitlistConfirmation(email, name || email, position)
          .catch(err => console.error('Waitlist email failed:', err));
      }

      res.json({ ok: true, position });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
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
