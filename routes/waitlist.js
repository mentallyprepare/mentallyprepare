function registerWaitlistRoutes(app, { db, requireAdmin }) {
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
