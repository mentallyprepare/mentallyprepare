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
    getCurrentJourneyDayIST,
    getNextUnsealAtIST,
    isEntryUnlocked,
    prompts,
    getAdaptivePrompt,
    getMoodInsights,
    scanForSafety,
    normalizeCollegeName,
    HELPLINES,
    getCrisisPayload,
    attemptMatch,
    trackEvent,
    attachWaitingEntriesToMatch,
    complementary,
    deleteMatchData,
    deleteUserDataTx,
    vapidKeys,
    IS_PROD
  } = deps;
  const YEARS = new Set(['1st', '2nd', '3rd', '4th', '5th', '5th+']);

  function clean(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function isValidCollegeName(value) {
    const raw = clean(value);
    if (raw.length >= 3) return true;
    return /^d\.?u\.?$/i.test(raw);
  }

  function hasIncompleteProfileBasics(user) {
    const college = clean(user && user.college).toLowerCase();
    const year = clean(user && user.year);
    return !college || college === 'not provided' || !YEARS.has(year);
  }

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

  const promptChoiceLibrary = [
    { text: 'What did you pretend was okay today?', category: 'Honest' },
    { text: 'What is one thing you wish someone noticed?', category: 'Something unsaid' },
    { text: 'What felt heavy, even if it looked small?', category: 'Deep' },
    { text: 'What is one tiny thing you survived today?', category: 'Tiny win' },
    { text: 'What do you want your anonymous partner to understand?', category: 'Honest' },
    { text: 'What are you not ready to say out loud yet?', category: 'Something unsaid' },
    { text: 'What softened today, even a little?', category: 'Light' },
    { text: 'What are you carrying that nobody can see?', category: 'Deep' },
    { text: 'What would feel honest to write tonight?', category: 'Honest' },
    { text: 'What do you need without explaining why?', category: 'What I need tonight' },
    { text: 'Where did you feel a little outside of everyone?', category: 'Deep' },
    { text: 'What sentence have you been avoiding?', category: 'Something unsaid' }
  ];

  function getPromptChoices(day, currentPrompt, specialDay) {
    const offset = Math.max(day - 1, 0) % promptChoiceLibrary.length;
    const rotated = promptChoiceLibrary.slice(offset).concat(promptChoiceLibrary.slice(0, offset));
    const choices = [];
    if (currentPrompt) {
      choices.push({
        text: String(currentPrompt).replace(/^"|"$/g, ''),
        category: specialDay ? specialDay.title : 'Tonight'
      });
    }
    for (const item of rotated) {
      if (choices.length >= 6) break;
      if (!choices.some(choice => choice.text === item.text)) choices.push(item);
    }
    return choices;
  }

  function cleanSelectedPrompt(value) {
    if (typeof value !== 'string') return null;
    const clean = value.trim().replace(/\s+/g, ' ');
    if (!clean || clean.toLowerCase() === 'custom' || clean.toLowerCase() === 'write_my_own') return null;
    return clean.slice(0, 220);
  }

  const defaultPushPreferences = {
    enabled: true,
    morningReminder: true,
    eveningReminder: true,
    dailyReflection: true,
    streakReminder: true,
    silentRoomReminder: false
  };

  function parsePushPreferences(raw) {
    let prefs = {};
    try { prefs = raw ? JSON.parse(raw) : {}; } catch { prefs = {}; }
    const merged = { ...defaultPushPreferences, ...prefs };
    merged.enabled = merged.enabled !== false;
    for (const key of ['morningReminder', 'eveningReminder', 'dailyReflection', 'streakReminder', 'silentRoomReminder']) {
      merged[key] = merged.enabled && merged[key] !== false;
    }
    return merged;
  }

  function cleanPushPreferences(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const enabled = raw.enabled !== false && raw.notificationsOff !== true;
    return {
      enabled,
      morningReminder: enabled && raw.morningReminder !== false,
      eveningReminder: enabled && raw.eveningReminder !== false,
      dailyReflection: enabled && raw.dailyReflection !== false,
      streakReminder: enabled && raw.streakReminder !== false,
      silentRoomReminder: enabled && raw.silentRoomReminder === true
    };
  }

  function buildPartnerStatus({ hasPartner, daysSinceActive = null, partnerEntryCount = 0, switchCount = 0 }) {
    const switchesRemaining = Math.max(0, 2 - (switchCount || 0));
    if (!hasPartner) {
      return {
        hasPartner: false,
        status: 'waiting',
        daysSinceActive: null,
        partnerEntryCount: 0,
        canSwitch: false,
        switchesRemaining,
        reason: 'no_partner',
        friendlyTitle: 'We are still looking for the right anonymous match.',
        friendlyMessage: 'You can write tonight while we search. Your first note will stay ready.',
        nextSwitchAvailableAt: null,
        actionLabel: null
      };
    }

    const canSwitchByQuiet = daysSinceActive >= 5;
    const canSwitch = canSwitchByQuiet && switchesRemaining > 0;
    const nextSwitchAvailableAt = !canSwitchByQuiet
      ? new Date(Date.now() + Math.max(0, 5 - daysSinceActive) * 86400000).toISOString()
      : null;
    let status = daysSinceActive === 0 ? 'active' : daysSinceActive <= 2 ? 'recent' : daysSinceActive <= 4 ? 'quiet' : 'dormant';
    let friendlyTitle = partnerEntryCount > 0 ? 'Your anonymous exchange is open.' : 'Your anonymous partner is here.';
    let friendlyMessage = partnerEntryCount > 0
      ? 'Some notes have already opened. Tonight can add one more quiet truth.'
      : 'They may take a little time to write. You can still seal your note tonight.';
    let reason = 'ok';
    let actionLabel = 'Keep writing';

    if (status === 'quiet') {
      friendlyTitle = 'Your partner has been quiet for a while.';
      friendlyMessage = 'Some people take longer to return. If they stay away, you will be able to quietly find someone new.';
      reason = 'waiting_period';
      actionLabel = 'Keep waiting';
    }
    if (status === 'dormant') {
      friendlyTitle = 'Your partner has been quiet for a while.';
      if (switchesRemaining > 0) {
        friendlyMessage = 'You can keep waiting, or we can quietly look for a new anonymous match. Your previous exchange stays private.';
        reason = 'switch_available';
        actionLabel = 'Find a new match';
      } else {
        friendlyMessage = 'You have already changed partners for this cycle. You can keep writing privately while this one completes.';
        reason = 'switch_limit_reached';
        actionLabel = 'Keep writing';
      }
    }

    return {
      hasPartner: true,
      status,
      daysSinceActive,
      partnerEntryCount,
      canSwitch,
      switchesRemaining,
      reason,
      friendlyTitle,
      friendlyMessage,
      nextSwitchAvailableAt,
      actionLabel
    };
  }

  function daysSinceEntry(entry) {
    if (!entry || !entry.created_at) return null;
    const raw = String(entry.created_at).trim();
    const date = new Date((/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'));
    if (Number.isNaN(date.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  }

  function daysSinceActivityDate(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && raw === new Date().toISOString().slice(0, 10)) return 0;
    const date = new Date(raw.includes('T') ? raw : `${raw}T00:00:00+05:30`);
    if (Number.isNaN(date.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  }

  function getActivityLabel(days) {
    if (days === 0) return 'Partner active today';
    if (days !== null && days <= 7) return 'Partner active this week';
    return 'Partner inactive';
  }

  function getRescueActions(daysInactive, canSwitch) {
    if (daysInactive === null || daysInactive < 5) return [];
    return [
      { id: 'continue_solo', label: 'Continue solo' },
      { id: 'find_new_partner', label: canSwitch ? 'Find new partner' : 'Find new partner unavailable' },
      { id: 'wait_for_partner', label: 'Wait for partner' }
    ];
  }

  function buildPartnerWritingStatus({ userId, partnerId, match, currentDay, visiblePartnerEntries = [], switchCount = 0 }) {
    const switchesRemaining = Math.max(0, 2 - (switchCount || 0));
    if (!match || !partnerId) {
      return {
        hasPartner: false,
        partnerHasWrittenToday: false,
        partnerLastEntryDay: null,
        partnerLastEntryAt: null,
        partnerEntriesVisible: 0,
        partnerTotalEntries: 0,
        waitingForPartner: false,
        nextUnsealAt: null,
        unsealMessage: 'We are still looking for the right anonymous match. You can write tonight while we search.',
        daysSincePartnerEntry: null,
        canSwitch: false,
        switchesRemaining,
        status: 'waiting',
        activityLabel: null,
        daysSincePartnerActive: null,
        canRemindPartner: false,
        rescueActions: [],
        friendlyTitle: 'We are still looking for the right anonymous match.',
        friendlyMessage: 'You can write tonight while we search. Your first note will stay ready.'
      };
    }

    const partner = stmts.getUserById.get(partnerId);
    const partnerEntriesAll = db.prepare(`
      SELECT day, created_at
      FROM entries
      WHERE user_id = ? AND match_id = ?
      ORDER BY day DESC
    `).all(partnerId, match.id);
    const partnerTotalEntries = partnerEntriesAll.length;
    const partnerLastEntry = partnerEntriesAll[0] || null;
    const todayPartnerEntry = partnerEntriesAll.find(e => Number(e.day) === Number(currentDay)) || null;
    const myTodayEntry = stmts.getEntry.get(userId, match.id, currentDay);
    const partnerEntriesVisible = visiblePartnerEntries.length;
    const daysQuiet = daysSinceEntry(partnerLastEntry);
    const daysSincePartnerActive = daysSinceActivityDate(partner && partner.last_active_date);
    const daysInactive = daysSincePartnerActive !== null ? daysSincePartnerActive : daysQuiet;
    const canSwitchByQuiet = daysInactive !== null && daysInactive >= 5;
    const canSwitch = canSwitchByQuiet && switchesRemaining > 0;
    const waitingForPartner = !!myTodayEntry && !todayPartnerEntry;
    const nextUnsealAt = todayPartnerEntry && !isEntryUnlocked(todayPartnerEntry, match)
      ? getNextUnsealAtIST()
      : null;

    let status = 'active';
    let friendlyTitle = 'Your anonymous partner';
    let friendlyMessage = 'Notes open after midnight IST.';
    let unsealMessage = 'Notes open after midnight IST.';

    if (todayPartnerEntry && nextUnsealAt) {
      status = 'wrote_today_sealed';
      friendlyTitle = 'They wrote tonight.';
      friendlyMessage = 'Their note opens after midnight IST.';
      unsealMessage = 'Your partner has written. It will open after midnight IST.';
    } else if (todayPartnerEntry) {
      status = 'opened';
      friendlyTitle = 'A note from your partner opened.';
      friendlyMessage = 'You can read the latest opened note now.';
      unsealMessage = 'A note from your partner opened.';
    } else if (!waitingForPartner && visiblePartnerEntries.some(e => Number(e.day) === Number(currentDay) - 1)) {
      status = 'opened';
      friendlyTitle = 'A note from your partner opened.';
      friendlyMessage = 'You can read the latest opened note now.';
      unsealMessage = 'A note from your partner opened.';
    } else if (!partnerTotalEntries) {
      status = 'never_wrote';
      friendlyTitle = 'They have not left a note yet.';
      friendlyMessage = 'Some people return late. You can still seal your note.';
      unsealMessage = 'Your partner has not left a note yet.';
    } else if (!todayPartnerEntry) {
      status = daysQuiet !== null && daysQuiet >= 2 ? 'partner_quiet' : 'not_written_today';
      friendlyTitle = daysQuiet !== null && daysQuiet >= 2 ? 'Your partner has been quiet for a while.' : 'They have not written tonight yet.';
      friendlyMessage = daysQuiet !== null && daysQuiet >= 2
        ? 'You can keep waiting. If they stay quiet long enough, you can quietly look for someone new.'
        : 'Some people return late. You can still seal your note.';
      unsealMessage = waitingForPartner ? 'Your note is sealed. Their side is still quiet.' : 'Your partner has not written yet tonight.';
    }

    if (canSwitch) {
      friendlyMessage = 'You can keep waiting, or quietly look for someone new.';
    }

    return {
      hasPartner: true,
      partnerHasWrittenToday: !!todayPartnerEntry,
      partnerLastEntryDay: partnerLastEntry ? partnerLastEntry.day : null,
      partnerLastEntryAt: partnerLastEntry ? partnerLastEntry.created_at : null,
      partnerEntriesVisible,
      partnerTotalEntries,
      waitingForPartner,
      nextUnsealAt,
      unsealMessage,
      daysSincePartnerEntry: daysQuiet,
      daysSincePartnerActive,
      activityLabel: getActivityLabel(daysInactive),
      canRemindPartner: daysInactive !== null && daysInactive >= 2,
      rescueActions: getRescueActions(daysInactive, canSwitch),
      canSwitch,
      switchesRemaining,
      status,
      friendlyTitle,
      friendlyMessage
    };
  }

  function clearMatchForSwitch(matchId) {
    if (typeof deleteMatchData === 'function') {
      deleteMatchData(matchId);
      return;
    }

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
    `).all();

    for (const { name } of tables) {
      const refsMatch = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all()
        .filter(fk => fk.table === 'matches' && fk.to === 'id');

      for (const fk of refsMatch) {
        db.prepare(`DELETE FROM "${name.replace(/"/g, '""')}" WHERE "${fk.from.replace(/"/g, '""')}" = ?`).run(matchId);
      }
    }

    stmts.deleteMatchById.run(matchId);
  }

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
        emailVerified: !!user.email_verified,
        archetype: user.archetype,
        scores: user.scores,
        profilePhoto: rawUser.profile_photo || null,
        authProvider: rawUser.auth_provider || 'password',
        pushPreferences: parsePushPreferences(rawUser.push_preferences),
        pushSubscribed: !!rawUser.push_subscription
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
      let partnerStatus = buildPartnerWritingStatus({
        userId,
        partnerId: null,
        match: null,
        currentDay: 1,
        visiblePartnerEntries: [],
        switchCount: user.switch_count
      });
      const waitingEntry = stmts.getWaitingEntry.get(userId);

      if (match) {
        const partnerId = getPartnerId(match, userId);
        const day = getMatchDay(match.started_at);
        const unlockedJourneyDay = getCurrentJourneyDayIST(match.started_at, new Date(), { cap: false });
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
          promptChoices: getPromptChoices(day, currentPrompt, specialDay),
          partner: partner ? { archetype: partner.archetype, scores: partner.scores } : null,
          startedAt: match.started_at
        };

        entriesData = stmts.getEntries.all(userId, match.id)
          .map((e) => ({ day: e.day, text: e.text, mood: e.mood, prompt: e.prompt, created_at: e.created_at }));

        // Partner entries — show entries from previous days (midnight unsealing)
        const allPartnerEntries = stmts.getPartnerEntries.all(partnerId, match.id, unlockedJourneyDay);
        partnerEntries = allPartnerEntries
          .filter((e) => isEntryUnlocked(e, match))
          .map((e) => ({ day: e.day, text: e.text, mood: e.mood, created_at: e.created_at }));

        partnerStatus = buildPartnerWritingStatus({
          userId,
          partnerId,
          match,
          currentDay: day,
          visiblePartnerEntries: partnerEntries,
          switchCount: user.switch_count
        });

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
          const revealChoices = ['first_name', 'name_college', 'contact_details'];
          const myWantsReveal = myReveal && revealChoices.includes(myReveal.choice);
          const partnerWantsReveal = partnerReveal && revealChoices.includes(partnerReveal.choice);
          const bothReveal = !!(myWantsReveal && partnerWantsReveal);
          const eitherAnonymous = (myReveal && myReveal.choice === 'stay_anonymous') || (partnerReveal && partnerReveal.choice === 'stay_anonymous');

          // Get partner's unsent letter for reveal
          const partnerDay11 = stmts.getEntry.get(partnerId, match.id, 11);
          let partnerIdentity = null;
          if (bothReveal && partner) {
            const firstName = String(partner.name || '').trim().split(/\s+/)[0] || 'Your partner';
            partnerIdentity = { name: firstName };
            if (partnerReveal.choice === 'name_college' || partnerReveal.choice === 'contact_details') {
              partnerIdentity = { ...partnerIdentity, fullName: partner.name, college: partner.college, year: partner.year };
            }
            if (partnerReveal.choice === 'contact_details') {
              partnerIdentity.email = partner.email;
            }
          }

          revealData = {
            available: true,
            myChoice: myReveal ? myReveal.choice : null,
            partnerChose: !!partnerReveal,
            revealed: bothReveal,
            anonymous: eitherAnonymous,
            partner: partnerIdentity,
            partnerUnsentLetter: (bothReveal || eitherAnonymous) && partnerDay11 ? partnerDay11.text : null
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
        partnerStatus,
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

  app.post('/api/profile/basics', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const user = stmts.getUserById.get(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (stmts.getMatch.get(userId, userId)) {
        return res.status(409).json({ error: 'College and year cannot be changed after matching has started.' });
      }
      if (!hasIncompleteProfileBasics(user)) {
        return res.status(409).json({ error: 'Profile basics are already complete.' });
      }

      const college = clean(req.body && req.body.college);
      const year = clean(req.body && req.body.year);
      if (!isValidCollegeName(college)) return res.status(400).json({ error: 'Please enter your college name.' });
      if (!YEARS.has(year)) return res.status(400).json({ error: 'Please choose your year.' });

      stmts.updateUserProfileBasics.run(
        college,
        normalizeCollegeName ? normalizeCollegeName(college) : college.toLowerCase(),
        year,
        new Date().toISOString(),
        userId
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('Profile basics update error:', e);
      res.status(500).json({ error: 'Could not save your profile yet. Please try again.' });
    }
  });

  app.post('/api/profile', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const user = stmts.getUserById.get(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (stmts.getMatch.get(userId, userId)) {
        return res.status(409).json({ error: 'Profile basics are locked after matching starts.' });
      }

      const name = clean(req.body && req.body.name);
      const college = clean(req.body && req.body.college);
      const year = clean(req.body && req.body.year);
      if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
      if (!isValidCollegeName(college)) return res.status(400).json({ error: 'Please enter your college name.' });
      if (!YEARS.has(year)) return res.status(400).json({ error: 'Please choose your year.' });

      stmts.updateUserProfile.run(
        name,
        college,
        normalizeCollegeName ? normalizeCollegeName(college) : college.toLowerCase(),
        year,
        new Date().toISOString(),
        userId
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('Profile update error:', e);
      res.status(500).json({ error: 'Could not save your profile yet. Please try again.' });
    }
  });

  app.post('/api/scan', apiLimiter, requireAuth, (req, res) => {
    try {
      const { scores, archetype, answers } = req.body;
      if (!archetype || !scores) return res.status(400).json({ error: 'Scan data required' });
      const validTypes = ['protector', 'connector', 'performer', 'disconnector'];
      if (!validTypes.includes(archetype)) return res.status(400).json({ error: 'Invalid archetype' });
      if (!Array.isArray(answers) || answers.length !== 11 || answers.some((answer) => !Number.isInteger(answer) || answer < 1 || answer > 7)) {
        return res.status(400).json({ error: 'Please answer every scan question before continuing.' });
      }
      const validScoreKeys = ['openness', 'awareness', 'guard', 'reciprocity'];
      if (!validScoreKeys.every((key) => Number.isFinite(Number(scores[key])) && Number(scores[key]) >= 0 && Number(scores[key]) <= 100)) {
        return res.status(400).json({ error: 'Invalid scan score data.' });
      }

      const userId = req.session.userId;
      const user = stmts.getUserById.get(userId);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const existingMatch = stmts.getMatch.get(userId, userId);
      if (existingMatch) return res.status(400).json({ error: 'Cannot retake scan after matching' });

      stmts.updateUserScan.run(archetype, JSON.stringify(scores), userId);
      const matchId = attemptMatch(userId);
      if (trackEvent) trackEvent(userId, 'scan_completed', { archetype });
      res.json({
        ok: true,
        matched: !!matchId
      });
    } catch (e) {
      console.error('Scan error:', e);
      res.status(500).json({ error: 'Failed to save scan' });
    }
  });

  app.post('/api/entry', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { text, mood, selectedPrompt, piiConfirmed } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'Entry text required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Entry too long (max 5000 chars)' });

      const safety = scanForSafety(text);
      if (safety.crisis && trackEvent) trackEvent(userId, 'crisis_keyword_triggered', { surface: 'journal_entry' });
      if (safety.pii && !piiConfirmed) {
        return res.status(422).json({
          error: 'This may reveal who you are. Please remove personal details to keep this space anonymous.',
          code: 'pii_detected',
          safety: { pii: true, piiFlags: safety.piiFlags }
        });
      }
      stmts.updateUserActivity.run(new Date().toISOString(), userId);

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const day = getMatchDay(match.started_at);
      if (day > 21) return res.status(400).json({ error: 'Journey complete' });

      const prompt = cleanSelectedPrompt(selectedPrompt) || prompts[(day - 1) % prompts.length];
      const existingEntry = stmts.getEntry.get(userId, match.id, day);
      if (trackEvent && !existingEntry && day === 1) {
        trackEvent(userId, 'day_1_written', { day });
        trackEvent(userId, 'first_reflection', { day });
      }
      if (trackEvent && !existingEntry && day === 2) {
        trackEvent(userId, 'day_2_returned', { day });
        trackEvent(userId, 'day_2', { day });
      }
      if (trackEvent && !existingEntry && [3, 7, 14, 21].includes(day)) trackEvent(userId, `day_${day}`, { day });
      if (trackEvent && !existingEntry) trackEvent(userId, 'day_written', { day });
      stmts.upsertEntry.run(userId, match.id, day, text.trim(), mood || '🌓', prompt);

      const crisisData = safety.crisis ? getCrisisPayload(req) : null;
      res.json({ ok: true, day, safety: { crisis: safety.crisis, pii: safety.pii, piiFlags: safety.piiFlags, helplines: crisisData ? crisisData.helplines : null } });
    } catch (e) {
      console.error('Entry error:', e);
      res.status(500).json({ error: 'Failed to save entry' });
    }
  });

  app.get('/api/partner-status', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const user = stmts.getUserById.get(userId);
      let match = stmts.getMatch.get(userId, userId);
      if (!match && user.archetype) {
        attemptMatch(userId);
        match = stmts.getMatch.get(userId, userId);
      }
      if (!match) return res.json(buildPartnerWritingStatus({ userId, partnerId: null, match: null, currentDay: 1, visiblePartnerEntries: [], switchCount: user ? user.switch_count : 0 }));

      const partnerId = getPartnerId(match, userId);
      const partner = stmts.getUserById.get(partnerId);
      if (!partner) return res.json(buildPartnerWritingStatus({ userId, partnerId: null, match: null, currentDay: 1, visiblePartnerEntries: [], switchCount: user ? user.switch_count : 0 }));

      const currentDay = getMatchDay(match.started_at);
      const unlockedJourneyDay = getCurrentJourneyDayIST(match.started_at, new Date(), { cap: false });
      const visiblePartnerEntries = stmts.getPartnerEntries.all(partnerId, match.id, unlockedJourneyDay)
        .filter((e) => isEntryUnlocked(e, match))
        .map((e) => ({ day: e.day, created_at: e.created_at }));

      res.json(buildPartnerWritingStatus({
        userId,
        partnerId,
        match,
        currentDay,
        visiblePartnerEntries,
        switchCount: user ? user.switch_count : 0
      }));
    } catch (e) {
      console.error('Partner status error:', e);
      res.status(500).json({ error: 'Failed to check partner status' });
    }
  });

  app.post('/api/partner-reminder', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No active match found' });
      const partnerId = getPartnerId(match, userId);
      const partner = stmts.getUserById.get(partnerId);
      if (!partner) return res.status(400).json({ error: 'Partner not found' });
      const daysInactive = daysSinceActivityDate(partner.last_active_date);
      if (daysInactive !== null && daysInactive < 2) {
        return res.status(400).json({ error: 'Your partner has been active recently. Give them a little time.' });
      }
      const recent = db.prepare(`
        SELECT id FROM nudges
        WHERE user_id = ? AND match_id = ? AND type = 'partner_reminder'
          AND created_at >= datetime('now', '-24 hours')
        LIMIT 1
      `).get(partnerId, match.id);
      if (!recent) {
        stmts.insertNudge.run(partnerId, match.id, 'partner_reminder', 'Your reflection partner may appreciate a reminder.');
        if (trackEvent) trackEvent(userId, 'partner_reminder_sent', { matchId: match.id, partnerInactiveDays: daysInactive });
      }
      res.json({ ok: true, message: 'Gentle reminder sent.' });
    } catch (e) {
      console.error('Partner reminder error:', e);
      res.status(500).json({ error: 'Failed to send reminder' });
    }
  });

  app.post('/api/continue-solo', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const match = stmts.getMatch.get(userId, userId);
      const metadata = { hasMatch: !!match, matchId: match ? match.id : null };
      const existingEvent = db.prepare(`
        SELECT id FROM analytics_events
        WHERE user_id = ? AND event_name = 'continue_solo_selected' AND metadata = ?
        LIMIT 1
      `).get(userId, JSON.stringify(metadata));
      if (trackEvent && !existingEvent) trackEvent(userId, 'continue_solo_selected', metadata);
      res.json({ ok: true, state: 'solo', message: 'You can keep writing privately while the room settles.' });
    } catch (e) {
      console.error('Continue solo error:', e);
      res.status(500).json({ error: 'Failed to save solo choice' });
    }
  });

  app.post('/api/switch-partner', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const user = stmts.getUserById.get(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      if ((user.switch_count || 0) >= 2) {
        return res.status(400).json({
          error: 'You have already changed partners for this cycle. You can keep writing privately while this one completes.',
          ok: false,
          switchesRemaining: 0,
          state: 'blocked'
        });
      }

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No current match to switch from' });

      const partnerId = getPartnerId(match, userId);
      const partner = stmts.getUserById.get(partnerId);
      const lastActive = partner && partner.last_active_date ? new Date(partner.last_active_date) : new Date(match.started_at);
      const daysSinceActive = Math.floor((Date.now() - lastActive.getTime()) / 86400000);

      if (daysSinceActive < 5) {
        return res.status(400).json({
          error: 'Your partner has been quiet, but we will give them a little more time. If they stay away, you will be able to quietly find someone new.',
          ok: false,
          switchesRemaining: Math.max(0, 2 - (user.switch_count || 0)),
          state: 'too_soon'
        });
      }

      const newCount = (user.switch_count || 0) + 1;

      db.transaction(() => {
        // Existing product behavior removes the old match container and its attached entries.
        // The user-facing copy promises privacy rather than future access to that old exchange.
        clearMatchForSwitch(match.id);
        stmts.updateUserSwitch.run(newCount, userId);
      })();

      const newMatchId = attemptMatch(userId);
      res.json({
        ok: true,
        matched: !!newMatchId,
        newMatchCreated: !!newMatchId,
        switchesRemaining: 2 - newCount,
        state: newMatchId ? 'matched' : 'waiting',
        waitingState: newMatchId ? null : 'searching',
        previousExchangePrivate: true,
        message: newMatchId
          ? 'You have a new anonymous match. Start gently tonight.'
          : 'We are still looking for the right anonymous match. You can write tonight while we search.'
      });
    } catch (e) {
      console.error('Switch error:', e);
      res.status(500).json({
        ok: false,
        state: 'error',
        error: 'We could not look for a new match just now. Please try once more.'
      });
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

      const currentDay = getCurrentJourneyDayIST(match.started_at, new Date(), { cap: false });
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
      const { day, reason, category } = req.body;
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });
      let match = stmts.getMatch.get(userId, userId);
      if (!match && user.archetype) {
        attemptMatch(userId);
        match = stmts.getMatch.get(userId, userId);
      }
      const partnerId = match ? getPartnerId(match, userId) : null;
      const entryDay = Number.isInteger(Number(day)) ? Number(day) : 0;
      stmts.insertReport.run(userId, match ? match.id : null, partnerId, entryDay, entryDay, category || 'entry', reason.trim().substring(0, 500));
      if (trackEvent) trackEvent(userId, 'report_clicked', { category: category || 'entry' });
      res.json({ ok: true });
    } catch (e) {
      console.error('Report error:', e);
      res.status(500).json({ error: 'Failed to submit report' });
    }
  });

  app.post('/api/block-partner', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No active match found' });
      const partnerId = getPartnerId(match, userId);
      const reason = String(req.body.reason || 'blocked_by_user').trim().slice(0, 500);
      db.transaction(() => {
        stmts.insertBlock.run(userId, partnerId, match.id, reason);
        stmts.insertReport.run(userId, match.id, partnerId, 0, 0, 'block', reason || 'Partner blocked');
        deleteMatchData(match.id);
      })();
      if (trackEvent) trackEvent(userId, 'block_clicked', { matchId: match.id });
      res.json({ ok: true, message: 'Partner blocked. Your identity remains anonymous and the match has been closed.' });
    } catch (e) {
      console.error('Block error:', e);
      res.status(500).json({ error: 'Failed to block partner' });
    }
  });

  app.post('/api/rematch-request', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const match = stmts.getMatch.get(userId, userId);
      const reason = String(req.body.reason || 'requested_by_user').trim().slice(0, 500);
      stmts.insertRematchRequest.run(userId, match ? match.id : null, reason);
      if (trackEvent) trackEvent(userId, 'rematch_requested', { hasMatch: !!match });
      res.json({ ok: true, message: 'Rematch request saved for review.' });
    } catch (e) {
      console.error('Rematch request error:', e);
      res.status(500).json({ error: 'Failed to request rematch' });
    }
  });

  app.post('/api/reveal', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      let { choice } = req.body;
      if (choice === 'yes') choice = 'first_name';
      if (choice === 'no') choice = 'stay_anonymous';
      const validChoices = ['first_name', 'name_college', 'contact_details', 'stay_anonymous'];
      if (!validChoices.includes(choice)) return res.status(400).json({ error: 'Choose what you want to reveal, or stay anonymous.' });

      const match = stmts.getMatch.get(userId, userId);
      if (!match) return res.status(400).json({ error: 'No match found' });

      const day = getMatchDay(match.started_at);
      if (day < 21) return res.status(400).json({ error: 'Not yet Day 21' });

      const existing = stmts.getReveal.get(match.id, userId);
      if (existing) return res.status(409).json({ error: 'Reveal choice is already locked.' });
      stmts.insertRevealChoice.run(match.id, userId, choice, new Date().toISOString());
      if (trackEvent) trackEvent(userId, 'reveal_request', { choice });
      if (trackEvent) trackEvent(userId, 'reveal_choice_submitted', { choice });
      const REVEAL_YES = ['first_name', 'name_college', 'contact_details'];
      if (trackEvent && REVEAL_YES.includes(choice)) {
        const partnerId = getPartnerId(match, userId);
        const partnerReveal = stmts.getReveal.get(match.id, partnerId);
        if (partnerReveal && REVEAL_YES.includes(partnerReveal.choice)) {
          trackEvent(userId, 'mutual_reveal', { matchId: match.id });
        }
      }
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

      const currentDay = getCurrentJourneyDayIST(match.started_at, new Date(), { cap: false });
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
      const moods = ['🌑', '🌒', '🌓', '🌔', '🌕'];
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
      const moods = ['🌑', '🌒', '🌓', '🌔', '🌕'];
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
      if (!stmts.getReveal.get(match.id, partnerId)) stmts.insertRevealChoice.run(match.id, partnerId, 'first_name', new Date().toISOString());
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

      if (trackEvent) trackEvent(userId, 'account_deleted');
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
      const { subscription, preferences } = req.body || {};
      if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
      stmts.updatePushSub.run(JSON.stringify(subscription), req.session.userId);
      if (preferences) {
        stmts.updatePushPrefs.run(JSON.stringify(cleanPushPreferences(preferences)), req.session.userId);
      }
      console.log('Push subscription saved', { userId: req.session.userId });
      res.json({ ok: true, preferences: parsePushPreferences(stmts.getUserById.get(req.session.userId).push_preferences) });
    } catch (e) {
      console.error('Push subscribe error:', e);
      res.status(500).json({ error: 'Failed to save subscription' });
    }
  });

  app.get('/api/push/preferences', apiLimiter, requireAuth, (req, res) => {
    try {
      const user = stmts.getUserById.get(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({
        preferences: parsePushPreferences(user.push_preferences),
        subscribed: !!user.push_subscription
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load notification settings' });
    }
  });

  app.post('/api/push/preferences', apiLimiter, requireAuth, (req, res) => {
    try {
      const preferences = cleanPushPreferences((req.body && req.body.preferences) || req.body || {});
      stmts.updatePushPrefs.run(JSON.stringify(preferences), req.session.userId);
      console.log('Push preferences updated', { userId: req.session.userId, enabled: preferences.enabled });
      res.json({ ok: true, preferences });
    } catch (e) {
      console.error('Push preferences update error:', e);
      res.status(500).json({ error: 'Failed to save notification settings' });
    }
  });

  app.post('/api/push/unsubscribe', apiLimiter, requireAuth, (req, res) => {
    try {
      stmts.updatePushSub.run(null, req.session.userId);
      stmts.updatePushPrefs.run(JSON.stringify({ ...defaultPushPreferences, enabled: false }), req.session.userId);
      console.log('Push unsubscribed', { userId: req.session.userId });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to unsubscribe' });
    }
  });
}

module.exports = {
  registerAppRoutes
};
