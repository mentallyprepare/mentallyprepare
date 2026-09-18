// Route for saving Day 1 entry while waiting for a match
const { encrypt: encryptEntry } = require('../lib/entry-crypto');

module.exports = function(app, deps) {
  const { apiLimiter, requireAuth, stmts, prompts, scanForSafety, HELPLINES, getCrisisPayload, trackEvent } = deps;

  app.post('/api/waiting-entry', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { text, mood, selectedPrompt, piiConfirmed } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'Entry text required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Entry too long (max 5000 chars)' });

      // Only allow if user has no match yet
      const match = stmts.getMatch.get(userId, userId);
      if (match) return res.status(400).json({ error: 'Already matched' });

      const safety = scanForSafety(text);
      if (safety.crisis && trackEvent) trackEvent(userId, 'crisis_keyword_triggered', { surface: 'waiting_entry' });
      if (safety.pii && !piiConfirmed) {
        return res.status(422).json({
          error: 'This may reveal who you are. Please remove personal details to keep this space anonymous.',
          code: 'pii_detected',
          safety: { pii: true, piiFlags: safety.piiFlags }
        });
      }
      const prompt = (typeof selectedPrompt === 'string' && selectedPrompt.trim())
        ? selectedPrompt.trim().replace(/\s+/g, ' ').slice(0, 220)
        : prompts[0];
      stmts.upsertWaitingEntry.run(userId, encryptEntry(text.trim()), mood || '🌓', prompt);

      if (trackEvent) trackEvent(userId, 'day_1_written', { waiting: true });
      const crisisData = safety.crisis ? getCrisisPayload(req) : null;
      res.json({ ok: true, safety: { crisis: safety.crisis, pii: safety.pii, piiFlags: safety.piiFlags, helplines: crisisData ? crisisData.helplines : null } });
    } catch (e) {
      console.error('Waiting entry error:', e);
      res.status(500).json({ error: 'Failed to save waiting entry' });
    }
  });
};
