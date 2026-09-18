// ─── Tonight's Question — Routes for unmatched/waiting users ───
// Provides a nightly rotating community writing experience
// so users stay engaged until a match is found.
const { encrypt: encryptEntry, decrypt: decryptEntry } = require('../lib/entry-crypto');

function registerTonightsQuestionRoutes(app, deps) {
  const {
    apiLimiter,
    requireAuth,
    db,
    stmts,
    parseUser,
    prompts,
    scanForSafety,
    HELPLINES,
    getCrisisPayload,
    trackEvent
  } = deps;

  // Tonight's prompt index — rotates daily based on UTC date
  function getTonightsPromptIndex() {
    const now = new Date();
    const utcDay = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86400000);
    return utcDay % prompts.length;
  }

  // GET /api/tonights-question
  // Returns tonight's prompt, user's entry (if any), anonymous whispers, and stats
  app.get('/api/tonights-question', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const user = parseUser(stmts.getUserById.get(userId));
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!user.archetype) return res.status(400).json({ error: 'Complete the quiz first' });

      // Only for unmatched users
      const match = stmts.getMatch.get(userId, userId);
      if (match) return res.json({ matched: true });

      const promptIndex = getTonightsPromptIndex();
      const prompt = prompts[promptIndex];

      // Get user's entry for tonight
      const myEntry = stmts.getTonightsEntry.get(userId, promptIndex);

      // Get anonymous whispers from other waiting users (tonight only)
      const whispers = stmts.getTonightsWhispers.all(promptIndex, userId);

      // Count how many people wrote tonight
      const countRow = stmts.getTonightsCount.get(promptIndex);
      const writerCount = countRow ? countRow.c : 0;

      // Get user's total nights written (for streak display)
      const nightsRow = stmts.getUserTonightsCount.get(userId);
      const nightsWritten = nightsRow ? nightsRow.c : 0;

      res.json({
        matched: false,
        prompt,
        promptIndex,
        myEntry: myEntry ? { text: decryptEntry(myEntry.text), mood: myEntry.mood, created_at: myEntry.created_at } : null,
        whispers: whispers.map(w => ({
          text: decryptEntry(w.text),
          mood: w.mood,
          created_at: w.created_at
        })),
        writerCount,
        nightsWritten
      });
    } catch (e) {
      console.error('Tonight\'s Question GET error:', e);
      res.status(500).json({ error: 'Failed to load tonight\'s question' });
    }
  });

  // POST /api/tonights-question
  // Submit or update entry for tonight's question
  app.post('/api/tonights-question', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { text, mood, piiConfirmed } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'Entry text required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Entry too long (max 5000 chars)' });

      // Only for unmatched users
      const match = stmts.getMatch.get(userId, userId);
      if (match) return res.status(400).json({ error: 'You are already matched — use the journal instead' });

      const safety = scanForSafety(text);
      if (safety.crisis && trackEvent) trackEvent(userId, 'crisis_keyword_triggered', { surface: 'tonights_question' });
      if (safety.pii && !piiConfirmed) {
        return res.status(422).json({
          error: 'This may reveal who you are. Please remove personal details to keep this space anonymous.',
          piiFlags: safety.piiFlags || []
        });
      }
      const promptIndex = getTonightsPromptIndex();

      stmts.upsertTonightsEntry.run(userId, promptIndex, encryptEntry(text.trim()), mood || '🌓');
      stmts.updateUserActivity.run(new Date().toISOString(), userId);

      res.json({
        ok: true,
        safety: {
          crisis: safety.crisis,
          pii: safety.pii,
          helplines: safety.crisis ? getCrisisPayload(req).helplines : null
        }
      });
    } catch (e) {
      console.error('Tonight\'s Question POST error:', e);
      res.status(500).json({ error: 'Failed to save entry' });
    }
  });

  // GET /api/tonights-question/history
  // Returns all past Tonight's Question entries for the user
  app.get('/api/tonights-question/history', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const entries = stmts.getUserTonightsHistory.all(userId);
      res.json({
        entries: entries.map(e => ({
          promptIndex: e.prompt_index,
          prompt: prompts[e.prompt_index] || '',
          text: decryptEntry(e.text),
          mood: e.mood,
          created_at: e.created_at
        }))
      });
    } catch (e) {
      console.error('Tonight\'s Question history error:', e);
      res.status(500).json({ error: 'Failed to load history' });
    }
  });
}

module.exports = { registerTonightsQuestionRoutes };
