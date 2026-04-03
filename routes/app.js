function registerAppRoutes(app, deps) {
  const {
    apiLimiter,
    requireAuth,
    bcrypt,
    db,
    stmts,
    parseUser,
    getPartnerId,
    getMatchDay,
    prompts,
    getAdaptivePrompt,
    getMoodInsights,
    scanForSafety,
    HELPLINES,
    attemptMatch,
    attachWaitingEntriesToMatch,
    complementary,
    deleteUserDataTx,
    vapidKeys,
    IS_PROD
  } = deps;

  function requireDev(req, res, next) {
    if (IS_PROD) return res.status(404).json({ error: 'Not found' });
    next();
  }

  // --- Special prompts for milestone days ---
  const specialDayPrompts = {
    7: { type: 'weekly_ritual', title: 'The Halfway Honest', prompt: '"Write one thing you\u2019ve never said out loud — to anyone. Not even yourself."', badge: '🔥' },
    11: { type: 'unsent_letter', title: 'The Unsent Letter', prompt: '"Dear stranger, I want you to know..."', badge: '💌' },
    14: { type: 'weekly_ritual', title: 'The Mirror Entry', prompt: '"Read your Day 1 entry. Now write what you\u2019d say to that version of yourself."', badge: '🪞' },
    21: { type: 'final_night', title: 'The Last Night', prompt: '"Would you like to know who has been writing to you?"', badge: '✦' }
  };

  // --- Connection score calculation ---
  function calcConnectionScore(userEntries, partnerEntries, matchDay) {
    if (!userEntries.length || !partnerEntries.length) return 0;
    const userDays = new Set(userEntries.map(e => e.day));
    const partnerDays = new Set(partnerEntries.map(e => e.day));
    // Sync bonus: both wrote same day
    let syncDays = 0;
    userDays.forEach(d => { if (partnerDays.has(d)) syncDays++; });
    const syncScore = Math.min(syncDays / Math.max(matchDay - 1, 1), 1) * 40;
    // Consistency
    const consistencyScore = Math.min(userEntries.length / Math.max(matchDay, 1), 1) * 30;
    // Word balance
    const userAvg = userEntries.reduce((s, e) => s + (e.text ? e.text.split(/\s+/).length : 0), 0) / userEntries.length;
    const partnerAvg = partnerEntries.reduce((s, e) => s + (e.text ? e.text.split(/\s+/).length : 0), 0) / partnerEntries.length;
    const ratio = Math.min(userAvg, partnerAvg) / Math.max(userAvg, partnerAvg, 1);
    const balanceScore = ratio * 30;
    return Math.round(Math.min(syncScore + consistencyScore + balanceScore, 100));
  }

  app.get('/api/me', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const rawUser = stmts.getUserById.get(userId);
      if (!rawUser) return res.status(404).json({ error: 'User not found' });
      const user = parseUser(rawUser);

      const safeUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        college: user.college,
        year: user.year,
        archetype: user.archetype,
        scores: user.scores
      };

      const match = stmts.getMatch.get(userId, userId);
      let matchData = null;
      let entriesData = [];
      let partnerEntries = [];
      let streak = 0;
      let revealData = null;
      let comments = [];
      let reactions = [];
      let nudges = [];
      let connectionScore = 0;
      let specialDay = null;
      let unsentLetter = null;
      const waitingEntry = stmts.getWaitingEntry.get(userId);

      if (match) {
        const partnerId = getPartnerId(match, userId);
        const day = getMatchDay(match.started_at);
        const partner = parseUser(stmts.getUserById.get(partnerId));

        // Get special day info
        if (specialDayPrompts[day]) {
          specialDay = { ...specialDayPrompts[day], day };
        }

        // Determine the current prompt
        let currentPrompt;
        if (specialDay) {
          currentPrompt = specialDay.prompt;
        } else {
          currentPrompt = prompts[(day - 1) % prompts.length];
        }

        matchData = {
          id: match.id,
          day,
          currentPrompt,
          partner: partner ? { archetype: partner.archetype, scores: partner.scores } : null,
          startedAt: match.started_at
        };

        entriesData = stmts.getEntries.all(userId, match.id)
          .map((e) => ({ day: e.day, text: e.text, mood: e.mood, prompt: e.prompt, created_at: e.created_at }));

        // Partner entries — show entries from previous days (midnight unsealing)
        const allPartnerEntries = stmts.getPartnerEntries.all(partnerId, match.id, day);
        partnerEntries = allPartnerEntries
          .map((e) => ({ day: e.day, text: e.text, mood: e.mood }));

        const allComments = stmts.getComments.all(match.id, userId, partnerId);
        comments = allComments.map((c) => ({
          day: c.day,
          text: c.text,
          from: c.user_id === userId ? 'me' : 'partner',
          created_at: c.created_at
        }));

        // Reactions
        const allReactions = stmts.getReactions.all(match.id);
        reactions = allReactions.map(r => ({
          day: r.day,
          emoji: r.emoji,
          from: r.user_id === userId ? 'me' : 'partner'
        }));

        // Active nudges
        nudges = stmts.getActiveNudges.all(userId).map(n => ({
          id: n.id, type: n.type, message: n.message
        }));

        // Connection score
        connectionScore = calcConnectionScore(entriesData, partnerEntries, day);

        // Unsent letter (Day 11 entry for reveal)
        const day11Entry = entriesData.find(e => e.day === 11);
        if (day11Entry && day >= 21) {
          unsentLetter = { text: day11Entry.text, mood: day11Entry.mood };
        }

        const entryDays = new Set(entriesData.map((e) => e.day));
        if (entryDays.has(day)) streak++;
        for (let d = day - 1; d >= 1; d--) {
          if (entryDays.has(d)) streak++;
          else break;
        }

        if (day >= 21) {
          const myReveal = stmts.getReveal.get(match.id, userId);
          const partnerReveal = stmts.getReveal.get(match.id, partnerId);
          const bothYes = myReveal && myReveal.choice === 'yes' && partnerReveal && partnerReveal.choice === 'yes';
          const eitherNo = (myReveal && myReveal.choice === 'no') || (partnerReveal && partnerReveal.choice === 'no');

          // Get partner's unsent letter for reveal
          const partnerDay11 = stmts.getEntry.get(partnerId, match.id, 11);

          revealData = {
            available: true,
            myChoice: myReveal ? myReveal.choice : null,
            partnerChose: !!partnerReveal,
            revealed: bothYes,
            anonymous: eitherNo,
            partner: bothYes && partner ? { name: partner.name, college: partner.college, year: partner.year, email: partner.email } : null,
            partnerUnsentLetter: (bothYes || eitherNo) && partnerDay11 ? partnerDay11.text : null
          };
        }
      }

      let adaptivePrompt = null;
      if (match && entriesData.length >= 2) {
        const day = getMatchDay(match.started_at);
        adaptivePrompt = getAdaptivePrompt(entriesData, day);
      }

      const insights = entriesData.length >= 3 ? getMoodInsights(entriesData) : null;

      // Always provide archetype and Day 1 prompt for waiting state
      const waitingInfo = {
        archetype: safeUser.archetype,
        day1Prompt: prompts[0],
        savedEntry: waitingEntry ? waitingEntry.text : ''
      };
      res.json({
        user: safeUser,
        match: matchData,
        entries: entriesData,
        partnerEntries,
        streak,
        reveal: revealData,
        comments,
        reactions,
        nudges,
        connectionScore,
        specialDay,
        unsentLetter,
        adaptivePrompt,
        insights,
        waitingInfo: !matchData ? waitingInfo : undefined
      });
    } catch (e) {
      console.error('State error:', e);
      res.status(500).json({ error: 'Failed to load state' });
    }
  });

  app.post('/api/scan', apiLimiter, requireAuth, (req, res) => {
    try {
      const { scores, archetype } = req.body;
      if (!archetype || !scores) return res.status(400).json({ error: 'Scan data required' });
      const validTypes = ['protector', 'connector', 'performer', 'disconnector'];
      if (!validTypes.includes(archetype)) return res.status(400).json({ error: 'Invalid archetype' });

      const userId = req.session.userId;
      const existingMatch = stmts.getMatch.get(userId, userId);
      if (existingMatch) return res.status(400).json({ error: 'Cannot retake scan after matching' });

      stmts.updateUserScan.run(archetype, JSON.stringify(scores), userId);
      const matchId = attemptMatch(userId);
      res.json({ ok: true, matched: !!matchId });
    } catch (e) {
      console.error('Scan error:', e);
      res.status(500).json({ error: 'Failed to save scan' });
    }
  });

  app.post('/api/entry', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { text, mood } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'Entry text required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Entry too long (max 5000 chars)' });

      const safety = scanForSafety(text);
      stmts.updateUserActivity.run(new Date().toISOString(), userId);

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const day = getMatchDay(match.started_at);
      if (day > 21) return res.status(400).json({ error: 'Journey complete' });

      const prompt = prompts[(day - 1) % prompts.length];
      stmts.upsertEntry.run(userId, match.id, day, text.trim(), mood || '??', prompt);

      res.json({ ok: true, day, safety: { crisis: safety.crisis, pii: safety.pii, helplines: safety.crisis ? HELPLINES : null } });
    } catch (e) {
      console.error('Entry error:', e);
      res.status(500).json({ error: 'Failed to save entry' });
    }
  });

  app.get('/api/partner-status', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.json({ hasPartner: false });

      const partnerId = getPartnerId(match, userId);
      const partner = stmts.getUserById.get(partnerId);
      if (!partner) return res.json({ hasPartner: false });

      const lastActive = partner.last_active_date ? new Date(partner.last_active_date) : new Date(partner.created_at);
      const daysSinceActive = Math.floor((Date.now() - lastActive.getTime()) / 86400000);
      const partnerEntryCount = db.prepare('SELECT COUNT(*) as c FROM entries WHERE user_id = ? AND match_id = ?').get(partnerId, match.id).c;

      res.json({
        hasPartner: true,
        daysSinceActive,
        partnerEntryCount,
        canSwitch: daysSinceActive >= 5,
        status: daysSinceActive === 0 ? 'active' : daysSinceActive <= 2 ? 'recent' : daysSinceActive <= 4 ? 'inactive' : 'dormant'
      });
    } catch (e) {
      console.error('Partner status error:', e);
      res.status(500).json({ error: 'Failed to check partner status' });
    }
  });

  app.post('/api/switch-partner', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const user = stmts.getUserById.get(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      if ((user.switch_count || 0) >= 2) {
        return res.status(400).json({ error: 'Maximum 2 partner switches per cycle' });
      }

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No current match to switch from' });

      const partnerId = getPartnerId(match, userId);
      const partner = stmts.getUserById.get(partnerId);
      const lastActive = partner && partner.last_active_date ? new Date(partner.last_active_date) : new Date(match.started_at);
      const daysSinceActive = Math.floor((Date.now() - lastActive.getTime()) / 86400000);

      if (daysSinceActive < 5) {
        return res.status(400).json({ error: 'Your partner was active recently. Switch is available after 5 days of inactivity.' });
      }

      stmts.deleteMatch.run(match.id);
      const newCount = (user.switch_count || 0) + 1;
      stmts.updateUserSwitch.run(newCount, userId);

      const newMatchId = attemptMatch(userId);
      res.json({ ok: true, matched: !!newMatchId, switchesRemaining: 2 - newCount });
    } catch (e) {
      console.error('Switch error:', e);
      res.status(500).json({ error: 'Failed to switch partner' });
    }
  });

  app.post('/api/comment', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { day, text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text required' });
      if (text.length > 500) return res.status(400).json({ error: 'Comment too long (max 500 chars)' });
      if (!day || day < 1 || day > 21) return res.status(400).json({ error: 'Invalid day' });

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const currentDay = getMatchDay(match.started_at);
      if (day >= currentDay) return res.status(400).json({ error: 'That entry is still sealed' });

      const partnerId = getPartnerId(match, userId);
      const partnerEntry = stmts.getEntry.get(partnerId, match.id, day);
      if (!partnerEntry) return res.status(400).json({ error: 'No partner entry to comment on' });

      stmts.upsertComment.run(userId, match.id, day, text.trim());
      res.json({ ok: true });
    } catch (e) {
      console.error('Comment error:', e);
      res.status(500).json({ error: 'Failed to save comment' });
    }
  });

  app.post('/api/report', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { day, reason } = req.body;
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });
      stmts.insertReport.run(userId, day || 0, reason.trim().substring(0, 500));
      res.json({ ok: true });
    } catch (e) {
      console.error('Report error:', e);
      res.status(500).json({ error: 'Failed to submit report' });
    }
  });

  app.post('/api/reveal', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { choice } = req.body;
      if (choice !== 'yes' && choice !== 'no') return res.status(400).json({ error: 'Choice must be yes or no' });

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const day = getMatchDay(match.started_at);
      if (day < 21) return res.status(400).json({ error: 'Not yet Day 21' });

      stmts.upsertReveal.run(match.id, userId, choice);
      res.json({ ok: true });
    } catch (e) {
      console.error('Reveal error:', e);
      res.status(500).json({ error: 'Failed to save reveal choice' });
    }
  });

  // --- Emoji Reactions ---
  const VALID_REACTIONS = ['🤍', '🥺', '💛', '🫂', '✨', '🌙'];

  app.post('/api/react', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { day, emoji } = req.body;
      if (!day || day < 1 || day > 21) return res.status(400).json({ error: 'Invalid day' });
      if (!emoji || !VALID_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction' });

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const currentDay = getMatchDay(match.started_at);
      if (day >= currentDay) return res.status(400).json({ error: 'That entry is still sealed' });

      const partnerId = getPartnerId(match, userId);
      const partnerEntry = stmts.getEntry.get(partnerId, match.id, day);
      if (!partnerEntry) return res.status(400).json({ error: 'No partner entry on that day' });

      stmts.upsertReaction.run(userId, match.id, day, emoji);
      res.json({ ok: true });
    } catch (e) {
      console.error('React error:', e);
      res.status(500).json({ error: 'Failed to save reaction' });
    }
  });

  // --- Dismiss Nudge ---
  app.post('/api/nudge/dismiss', apiLimiter, requireAuth, (req, res) => {
    try {
      const { nudgeId } = req.body;
      if (!nudgeId) return res.status(400).json({ error: 'Nudge ID required' });
      stmts.dismissNudge.run(nudgeId, req.session.userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to dismiss nudge' });
    }
  });

  app.post('/api/dev/setup', requireAuth, requireDev, async (req, res) => {
    try {
      const userId = req.session.userId;
      const user = parseUser(stmts.getUserById.get(userId));
      if (!user || !user.archetype) return res.status(400).json({ error: 'Complete scan first' });

      let match = stmts.getMatch.get(userId, userId);
      if (!match) {
        const targetType = complementary[user.archetype];
        const hash = await bcrypt.hash('testtest', 12);
        const now = new Date().toISOString();
        const partnerResult = db.prepare(`
        INSERT INTO users (name, email, password, college, year, gender, match_gender_pref, match_year_pref, archetype, scores, last_active_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
          'Priya Sharma',
          'test-' + Date.now() + '@test.com',
          hash,
          'Miranda House, Delhi',
          '3rd',
          'prefer_not_to_say',
          'any',
          'any',
          targetType,
          JSON.stringify({ openness: 70, awareness: 65, guard: 75, reciprocity: 60 }),
          now
        );
        const partnerId = Number(partnerResult.lastInsertRowid);
        const result = stmts.insertMatch.run(userId, partnerId);
        attachWaitingEntriesToMatch(result.lastInsertRowid, [userId, partnerId]);
        match = stmts.getMatch.get(userId, userId);
      }

      const partnerId = getPartnerId(match, userId);
      const day = getMatchDay(match.started_at);
      const fakeTexts = [
        'I keep wondering who you are. That might be weird to say.',
        'Today was hard. But writing here makes it feel a little less heavy.',
        'I think about what you wrote yesterday. It stayed with me.',
        'Some days I don\'t know what to say. But I show up anyway.',
        'You make me think about things differently. That scares me a little.',
        'I used to think loneliness was about being alone. It\'s not.',
        'Tonight I almost didn\'t write. But here I am.',
        'The prompt made me think of something I haven\'t told anyone.',
        'Is it strange that I feel like I know you?',
        'I wonder if you\'re having a good day today.'
      ];
      const moods = ['??', '??', '??', '??', '??'];
      for (let d = 1; d < day; d++) {
        const existing = stmts.getEntry.get(partnerId, match.id, d);
        if (!existing) {
          stmts.upsertEntry.run(partnerId, match.id, d, fakeTexts[(d - 1) % fakeTexts.length], moods[d % moods.length], prompts[(d - 1) % prompts.length]);
        }
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('Dev setup error:', e);
      res.status(500).json({ error: 'Dev setup failed' });
    }
  });

  app.post('/api/dev/advance', requireAuth, requireDev, (req, res) => {
    try {
      const userId = req.session.userId;
      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const d = new Date();
      d.setDate(d.getDate() - 21);
      stmts.updateMatchStart.run(d.toISOString(), match.id);

      const partnerId = getPartnerId(match, userId);
      const fakeTexts = [
        'I keep wondering who you are.',
        'Today was hard.',
        'I think about what you wrote.',
        'Some days I don\'t know what to say.',
        'You make me think differently.',
        'Loneliness isn\'t about being alone.',
        'Tonight I almost didn\'t write.',
        'The prompt made me think of something.',
        'I feel like I know you.',
        'I wonder about your day.'
      ];
      const moods = ['??', '??', '??', '??', '??'];
      for (let day = 1; day <= 21; day++) {
        const existing = stmts.getEntry.get(partnerId, match.id, day);
        if (!existing) {
          stmts.upsertEntry.run(partnerId, match.id, day, fakeTexts[(day - 1) % fakeTexts.length], moods[day % moods.length], prompts[(day - 1) % prompts.length]);
        }
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('Dev advance error:', e);
      res.status(500).json({ error: 'Advance failed' });
    }
  });

  app.post('/api/dev/partner-reveal', requireAuth, requireDev, (req, res) => {
    try {
      const userId = req.session.userId;
      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const partnerId = getPartnerId(match, userId);
      stmts.upsertReveal.run(match.id, partnerId, 'yes');
      res.json({ ok: true });
    } catch (e) {
      console.error('Dev reveal error:', e);
      res.status(500).json({ error: 'Partner reveal failed' });
    }
  });

  app.get('/api/my-data', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const user = parseUser(stmts.getUserById.get(userId));
      if (!user) return res.status(404).json({ error: 'User not found' });

      const match = stmts.getMatch.get(userId, userId);
      const myEntries = db.prepare('SELECT day, prompt, text, mood, created_at FROM entries WHERE user_id = ?').all(userId)
        .map((e) => ({ day: e.day, prompt: e.prompt, text: e.text, mood: e.mood, written_at: e.created_at }));
      const waitingDraft = stmts.getWaitingEntry.get(userId);
      const myReveals = db.prepare('SELECT match_id, choice, created_at FROM reveals WHERE user_id = ?').all(userId)
        .map((r) => ({ match_id: r.match_id, choice: r.choice, decided_at: r.created_at }));
      const myComments = db.prepare('SELECT day, text, created_at FROM comments WHERE user_id = ?').all(userId)
        .map((c) => ({ day: c.day, text: c.text, written_at: c.created_at }));

      const exportData = {
        exported_at: new Date().toISOString(),
        notice: 'This is all personal data Mentally Prepare holds about you. Partner details are excluded to protect their privacy.',
        profile: {
          name: user.name,
          email: user.email,
          college: user.college,
          year: user.year,
          gender: user.gender,
          matchGenderPref: user.match_gender_pref,
          matchYearPref: user.match_year_pref,
          archetype: user.archetype,
          scores: user.scores,
          consentGiven: !!user.consent_given,
          consentDate: user.consent_date,
          accountCreated: user.created_at,
          lastActive: user.last_active_date
        },
        match: match ? { status: 'active', dayCount: getMatchDay(match.started_at) } : null,
        waiting_draft: waitingDraft ? {
          prompt: waitingDraft.prompt,
          text: waitingDraft.text,
          created_at: waitingDraft.created_at,
          updated_at: waitingDraft.updated_at
        } : null,
        journal_entries: myEntries,
        comments: myComments,
        reveal_choices: myReveals
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="my-mentally-prepare-data.json"');
      res.json(exportData);
    } catch (e) {
      console.error('Data export error:', e);
      res.status(500).json({ error: 'Failed to export data' });
    }
  });

  app.delete('/api/account', apiLimiter, requireAuth, async (req, res) => {
    try {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'Password confirmation required to delete account' });

      const userId = req.session.userId;
      const user = stmts.getUserById.get(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const passwordValid = await bcrypt.compare(password, user.password);
      if (!passwordValid) return res.status(401).json({ error: 'Incorrect password. Account not deleted.' });

      deleteUserDataTx(userId, 'user_requested');

      req.session.destroy(() => {
        res.json({ ok: true, message: 'Your account and all associated data has been permanently deleted.' });
      });
    } catch (e) {
      console.error('Account deletion error:', e);
      res.status(500).json({ error: 'Account deletion failed' });
    }
  });

  app.get('/api/consent', apiLimiter, requireAuth, (req, res) => {
    try {
      const user = stmts.getUserById.get(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ consentGiven: !!user.consent_given, consentDate: user.consent_date || null });
    } catch (e) {
      res.status(500).json({ error: 'Failed to check consent' });
    }
  });

  app.post('/api/consent/withdraw', apiLimiter, requireAuth, (req, res) => {
    try {
      const user = stmts.getUserById.get(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      stmts.updateUserConsent.run(0, new Date().toISOString(), user.id);
      res.json({ ok: true, message: 'Consent withdrawn. You can still export or delete your data.' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to withdraw consent' });
    }
  });

  app.get('/api/push/public-key', (req, res) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Push not configured' });
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.post('/api/push/subscribe', apiLimiter, requireAuth, (req, res) => {
    try {
      const { subscription } = req.body;
      if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
      stmts.updatePushSub.run(JSON.stringify(subscription), req.session.userId);
      res.json({ ok: true });
    } catch (e) {
      console.error('Push subscribe error:', e);
      res.status(500).json({ error: 'Failed to save subscription' });
    }
  });

  app.post('/api/push/unsubscribe', apiLimiter, requireAuth, (req, res) => {
    try {
      stmts.updatePushSub.run(null, req.session.userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to unsubscribe' });
    }
  });
}

module.exports = {
  registerAppRoutes
};
