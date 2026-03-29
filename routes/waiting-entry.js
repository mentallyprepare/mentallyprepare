// Route for saving Day 1 entry while waiting for a match
module.exports = function(app, deps) {
  const { apiLimiter, requireAuth, stmts, prompts, scanForSafety, HELPLINES } = deps;

  app.post('/api/waiting-entry', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'Entry text required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Entry too long (max 5000 chars)' });

      // Only allow if user has no match yet
      const match = stmts.getMatch.get(userId, userId);
      if (match) return res.status(400).json({ error: 'Already matched' });

      const safety = scanForSafety(text);
      const day = 1;
      const prompt = prompts[0];
      stmts.upsertWaitingEntry.run(userId, day, text.trim(), '😶', prompt);

      res.json({ ok: true, safety: { crisis: safety.crisis, pii: safety.pii, helplines: safety.crisis ? HELPLINES : null } });
    } catch (e) {
      console.error('Waiting entry error:', e);
      res.status(500).json({ error: 'Failed to save waiting entry' });
    }
  });
};
