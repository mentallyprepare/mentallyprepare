const path = require('path');

function registerAdminRoutes(app, deps) {
  const {
    rootDir,
    db,
    stmts,
    requireAdmin,
    getBufferedLogs,
    authLimiter,
    getAdminStats,
    getMatchDay,
    getCurrentJourneyDayIST,
    getNextUnsealAtIST,
    isEntryUnlocked,
    attachWaitingEntriesToMatch,
    findUserByIdentifier,
    complementary,
    deleteUserDataTx,
    deleteMatchData,
    sendWaitlistAccepted,
    attemptMatch
  } = deps;

  const appLink = process.env.APP_BASE_URL || 'https://mymentallyprepare.com/app';

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(String(value).includes('T') ? value : String(value) + 'Z');
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function startOfToday() {
    const d = new Date();
    const istDay = Math.floor((d.getTime() + 5.5 * 60 * 60 * 1000) / 86400000);
    return new Date(istDay * 86400000 - 5.5 * 60 * 60 * 1000);
  }

  function daysSince(value, fallback = null) {
    const date = parseDate(value) || parseDate(fallback);
    if (!date) return null;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  }

  function wasToday(value) {
    const date = parseDate(value);
    return !!date && date >= startOfToday();
  }

  function withinLast24Hours(value) {
    const date = parseDate(value);
    return !!date && (Date.now() - date.getTime()) <= 86400000;
  }

  function buildReengagementEmail({ user, day, status, partnerWaiting }) {
    const name = user.name || 'there';
    const templates = {
      partner_waiting: {
        action: 'Send partner waiting reminder',
        subject: 'Someone is waiting for your note tonight',
        body: `Hi ${name},\n\nYour anonymous partner has been showing up.\n\nYou do not have to write something perfect tonight. One honest line is enough.\n\nCome back and seal today's note:\n${appLink}\n\nQuietly,\nMentally Prepare`
      },
      missed_today: {
        action: 'Send missed note reminder',
        subject: `Your Day ${day || 1} note is still open`,
        body: `Hi ${name},\n\nTonight's note is still waiting.\n\nYou can write one sentence, one feeling, or one thing you could not say anywhere else.\n\nOpen your private room:\n${appLink}\n\nMentally Prepare`
      },
      inactive_2_days: {
        action: 'Send soft return email',
        subject: 'You are not behind',
        body: `Hi ${name},\n\nYou have been away for a little while.\n\nThat is okay. You are not behind. You can return with just one honest line.\n\nYour private room is still here:\n${appLink}\n\nMentally Prepare`
      },
      inactive_5_days: {
        action: 'Send 21-day reset email',
        subject: 'Want to continue your 21-day reset?',
        body: `Hi ${name},\n\nYou started something honest here.\n\nIf you still want to continue, come back tonight. If your partner has been quiet too, we can help you find a new match when available.\n\nReturn here:\n${appLink}\n\nMentally Prepare`
      },
      waiting_for_match: {
        action: 'Send waiting for match update',
        subject: 'We are still finding the right anonymous match',
        body: `Hi ${name},\n\nYou are on the list for a match.\n\nWhile we look for someone emotionally compatible, you can still write your first private note.\n\nOpen your room:\n${appLink}\n\nMentally Prepare`
      },
      no_scan_yet: {
        action: 'Send scan completion email',
        subject: 'Your anonymous match starts with one small scan',
        body: `Hi ${name},\n\nYou created your Mentally Prepare account, but your emotional scan is still incomplete.\n\nIt takes only a few minutes and helps us match you with the right anonymous partner.\n\nComplete it here:\n${appLink}\n\nMentally Prepare`
      },
      never_started: {
        action: 'Send first note invitation',
        subject: 'Tonight can be your first honest line',
        body: `Hi ${name},\n\nYour private room is ready when you are.\n\nYou do not have to explain everything. Start with one honest line and let that be enough.\n\nOpen your room:\n${appLink}\n\nMentally Prepare`
      },
      active_today: {
        action: 'No email needed today',
        subject: '',
        body: ''
      }
    };

    return templates[status] || (partnerWaiting ? templates.partner_waiting : templates.missed_today);
  }

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
          (
            SELECT m.id FROM matches m
            WHERE m.user1_id = u.id OR m.user2_id = u.id
            ORDER BY m.started_at DESC
            LIMIT 1
          ) as match_id,
          (
            SELECT CASE WHEN m.user1_id = u.id THEN m.user2_id ELSE m.user1_id END
            FROM matches m
            WHERE m.user1_id = u.id OR m.user2_id = u.id
            ORDER BY m.started_at DESC
            LIMIT 1
          ) as partner_id,
          (
            SELECT p.name
            FROM matches m
            JOIN users p ON p.id = CASE WHEN m.user1_id = u.id THEN m.user2_id ELSE m.user1_id END
            WHERE m.user1_id = u.id OR m.user2_id = u.id
            ORDER BY m.started_at DESC
            LIMIT 1
          ) as partner_name
        FROM users u
        ORDER BY u.created_at DESC
      `).all();
      res.json(rows.map(row => ({ ...row, has_match: !!row.match_id })));
    } catch (e) {
      res.status(500).json({ error: 'Failed to load users' });
    }
  });

  app.get('/api/admin/reengagement-users', requireAdmin, (req, res) => {
    try {
      const users = db.prepare(`
        SELECT id, name, email, college, year, archetype, last_active_date, created_at
        FROM users
        ORDER BY created_at DESC
      `).all();

      const matches = db.prepare('SELECT * FROM matches ORDER BY started_at DESC').all();
      const entries = db.prepare(`
        SELECT id, user_id, match_id, day, created_at
        FROM entries
        ORDER BY created_at DESC
      `).all();

      const matchByUser = new Map();
      for (const match of matches) {
        if (!matchByUser.has(match.user1_id)) matchByUser.set(match.user1_id, match);
        if (!matchByUser.has(match.user2_id)) matchByUser.set(match.user2_id, match);
      }

      const entriesByUser = new Map();
      const entriesByUserDay = new Map();
      for (const entry of entries) {
        if (!entriesByUser.has(entry.user_id)) entriesByUser.set(entry.user_id, []);
        entriesByUser.get(entry.user_id).push(entry);
        entriesByUserDay.set(`${entry.user_id}:${entry.match_id}:${entry.day}`, entry);
      }

      const rows = users.map(user => {
        const match = matchByUser.get(user.id);
        const userEntries = entriesByUser.get(user.id) || [];
        const lastEntry = userEntries[0] || null;
        const totalEntries = userEntries.length;
        const daysInactive = daysSince(user.last_active_date, user.created_at);
        const daysSinceLastEntry = lastEntry ? daysSince(lastEntry.created_at) : null;
        const activeToday = wasToday(user.last_active_date) || (lastEntry && wasToday(lastEntry.created_at));

        let partnerId = null;
        let partner = null;
        let partnerEntries = [];
        let partnerLastEntry = null;
        let partnerLastActiveDate = null;
        let partnerDaysInactive = null;
        let currentDay = null;
        let wroteToday = false;
        let partnerWroteToday = false;
        let partnerWaiting = false;
        let matchStatus = 'not_matched';

        if (match) {
          partnerId = match.user1_id === user.id ? match.user2_id : match.user1_id;
          partner = users.find(u => u.id === partnerId) || null;
          partnerEntries = entriesByUser.get(partnerId) || [];
          partnerLastEntry = partnerEntries[0] || null;
          partnerLastActiveDate = partner ? partner.last_active_date : null;
          partnerDaysInactive = partner ? daysSince(partner.last_active_date, partner.created_at) : null;
          currentDay = getMatchDay(match.started_at);
          wroteToday = !!entriesByUserDay.get(`${user.id}:${match.id}:${currentDay}`) || (lastEntry && wasToday(lastEntry.created_at));
          partnerWroteToday = !!entriesByUserDay.get(`${partnerId}:${match.id}:${currentDay}`) || (partnerLastEntry && wasToday(partnerLastEntry.created_at));
          partnerWaiting = !wroteToday && !!partnerLastEntry && (partnerWroteToday || withinLast24Hours(partnerLastEntry.created_at));
          matchStatus = 'matched';
        }

        let status = 'missed_today';
        if (!user.archetype) status = 'no_scan_yet';
        else if (!match) status = totalEntries ? 'waiting_for_match' : 'never_started';
        else if (activeToday || wroteToday) status = 'active_today';
        else if (partnerWaiting) status = 'partner_waiting';
        else if (totalEntries === 0) status = 'never_started';
        else if ((daysInactive || 0) >= 5 || (daysSinceLastEntry || 0) >= 5) status = 'inactive_5_days';
        else if ((daysInactive || 0) >= 2 || (daysSinceLastEntry || 0) >= 2) status = 'inactive_2_days';

        const atRiskDropoff = totalEntries > 0 && !wroteToday && (daysSinceLastEntry || 0) >= 2;
        const email = buildReengagementEmail({ user, day: currentDay, status, partnerWaiting });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          college: user.college,
          year: user.year,
          archetype: user.archetype,
          matchStatus,
          matchId: match ? match.id : null,
          currentDay,
          lastActiveDate: user.last_active_date || user.created_at,
          daysInactive,
          lastEntryDate: lastEntry ? lastEntry.created_at : null,
          daysSinceLastEntry,
          totalEntries,
          wroteToday: !!wroteToday,
          partnerWroteToday: !!partnerWroteToday,
          partnerLastActiveDate,
          partnerDaysInactive,
          partnerWaiting: !!partnerWaiting,
          status,
          statuses: Array.from(new Set([status, atRiskDropoff ? 'at_risk_dropoff' : null].filter(Boolean))),
          suggestedEmailType: status,
          suggestedAction: email.action,
          suggestedSubject: email.subject,
          suggestedEmailBody: email.body
        };
      }).sort((a, b) => {
        if (a.partnerWaiting !== b.partnerWaiting) return a.partnerWaiting ? -1 : 1;
        return (b.daysInactive || 0) - (a.daysInactive || 0);
      });

      res.json({ ok: true, generatedAt: new Date().toISOString(), users: rows });
    } catch (e) {
      console.error('Re-engagement admin error:', e);
      res.status(500).json({ error: 'Failed to load re-engagement users' });
    }
  });

  app.get('/admin/stats', requireAdmin, (req, res) => {
    try {
      res.json(getAdminStats());
    } catch (e) {
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });

  app.get('/admin/matches-debug', requireAdmin, (req, res) => {
    try {
      const matches = db.prepare('SELECT * FROM matches ORDER BY started_at DESC').all();
      const rows = matches.map(match => {
        const user1Entries = db.prepare('SELECT day, created_at FROM entries WHERE user_id = ? AND match_id = ? ORDER BY day DESC').all(match.user1_id, match.id);
        const user2Entries = db.prepare('SELECT day, created_at FROM entries WHERE user_id = ? AND match_id = ? ORDER BY day DESC').all(match.user2_id, match.id);
        const currentDay = getMatchDay(match.started_at);
        const unlockedDay = getCurrentJourneyDayIST(match.started_at, new Date(), { cap: false });
        const user1Visible = user2Entries.filter(e => isEntryUnlocked(e, match)).length;
        const user2Visible = user1Entries.filter(e => isEntryUnlocked(e, match)).length;
        return {
          matchId: match.id,
          currentDay,
          unlockedDay,
          startedAt: match.started_at,
          user1Id: match.user1_id,
          user2Id: match.user2_id,
          user1LastEntryDay: user1Entries[0] ? user1Entries[0].day : null,
          user2LastEntryDay: user2Entries[0] ? user2Entries[0].day : null,
          user1WroteToday: user1Entries.some(e => Number(e.day) === Number(currentDay)),
          user2WroteToday: user2Entries.some(e => Number(e.day) === Number(currentDay)),
          entriesVisibleToUser1: user1Visible,
          entriesVisibleToUser2: user2Visible,
          nextUnsealAt: getNextUnsealAtIST()
        };
      });
      res.json({ ok: true, generatedAt: new Date().toISOString(), timezone: 'Asia/Kolkata', matches: rows });
    } catch (e) {
      console.error('Match debug admin error:', e);
      res.status(500).json({ error: 'Failed to load match debug data' });
    }
  });

  app.get('/admin/logs', requireAdmin, (req, res) => {
    try {
      const level = String(req.query.level || 'all').trim().toLowerCase();
      const search = String(req.query.q || '').trim();
      const sinceMinutes = Number(req.query.since) || 0;
      const limit = Number(req.query.limit) || 200;
      const format = String(req.query.format || '').trim().toLowerCase();
      const logs = getBufferedLogs({ level, search, sinceMinutes, limit });
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="logs.csv"');
        const csv = [
          'id,timestamp,level,message',
          ...logs.entries.map(e => [e.id, JSON.stringify(e.timestamp), e.level, '"' + String(e.message).replace(/"/g, '""') + '"'].join(','))
        ].join('\n');
        return res.send(csv);
      } else if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="logs.json"');
        return res.send(JSON.stringify(logs.entries, null, 2));
      } else {
        res.json(logs);
      }
    } catch (e) {
      res.status(500).json({ error: 'Failed to load logs' });
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

  app.post('/admin/manual-match', authLimiter, requireAdmin, (req, res) => {
    try {
      const userA = findUserByIdentifier(req.body.user1_id);
      const userB = findUserByIdentifier(req.body.user2_id);
      if (!userA || !userB) return res.status(404).json({ error: 'Both users must exist' });
      if (userA.id === userB.id) return res.status(400).json({ error: 'Choose two different users' });
      if (!userA.archetype || !userB.archetype) return res.status(400).json({ error: 'Both users must complete the scan first' });
      // Admins can bypass college and archetype rules in a manual force match
      // if (userA.college.trim().toLowerCase() === userB.college.trim().toLowerCase()) {
      //   return res.status(400).json({ error: 'Users must be from different colleges' });
      // }
      // if (complementary[userA.archetype] !== userB.archetype) {
      //   return res.status(400).json({ error: 'Archetypes are not complementary' });
      // }
      const existingA = stmts.getMatch.get(userA.id, userA.id);
      const existingB = stmts.getMatch.get(userB.id, userB.id);
      const forceRematch = req.body.force_rematch === true || req.body.forceRematch === true;
      if ((existingA || existingB) && !forceRematch) {
        return res.status(400).json({
          error: 'One or both users are already matched. Check “End existing matches first” to rematch them.'
        });
      }

      const result = db.transaction(() => {
        const endedMatchIds = [];
        const matchesToEnd = new Set([existingA && existingA.id, existingB && existingB.id].filter(Boolean));
        for (const matchId of matchesToEnd) {
          deleteMatchData(matchId);
          endedMatchIds.push(matchId);
        }
        const inserted = stmts.insertMatch.run(userA.id, userB.id);
        attachWaitingEntriesToMatch(inserted.lastInsertRowid, [userA.id, userB.id]);
        return { matchId: inserted.lastInsertRowid, endedMatchIds };
      })();

      res.json({ ok: true, match_id: result.matchId, ended_match_ids: result.endedMatchIds });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message || 'Failed to create manual match' });
    }
  });

  // POST /admin/run-matching — attempt to match every unmatched user who has completed the scan
  app.post('/admin/run-matching', requireAdmin, (req, res) => {
    try {
      // Get all unmatched users who have an archetype
      const waiting = db.prepare(`
        SELECT u.id FROM users u
        LEFT JOIN matches m ON m.user1_id = u.id OR m.user2_id = u.id
        WHERE m.id IS NULL AND u.archetype IS NOT NULL
        ORDER BY u.created_at ASC
      `).all();

      let matched = 0;
      const skipped = [];

      for (const row of waiting) {
        // Re-check they're still unmatched (earlier iteration might have matched them)
        const alreadyMatched = stmts.getMatch.get(row.id, row.id);
        if (alreadyMatched) continue;

        const matchId = attemptMatch(row.id);
        if (matchId) {
          matched++;
        } else {
          skipped.push(row.id);
        }
      }

      res.json({
        ok: true,
        matched,
        still_waiting: skipped.length,
        still_waiting_ids: skipped,
        message: matched > 0
          ? `Matched ${matched} pair${matched > 1 ? 's' : ''}. ${skipped.length} user${skipped.length !== 1 ? 's' : ''} still waiting (no compatible partner available).`
          : skipped.length > 0
            ? `${skipped.length} user${skipped.length !== 1 ? 's' : ''} waiting but no compatible partners available yet.`
            : 'Everyone is already matched.'
      });
    } catch (e) {
      console.error('Run-matching error:', e);
      res.status(500).json({ error: 'Matching run failed: ' + (e.message || 'unknown error') });
    }
  });

  app.post('/api/admin/invite', authLimiter, requireAdmin, async (req, res) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Email is required' });
      const entry = db.prepare('SELECT id, name FROM waitlist WHERE email = ?').get(email);
      if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
      if (sendWaitlistAccepted) {
        await sendWaitlistAccepted(email, entry.name || email)
          .catch(err => console.error('Invite email failed:', err));
      }
      db.prepare('UPDATE waitlist SET invited_at = datetime(\'now\') WHERE id = ?').run(entry.id);
      res.json({ ok: true });
    } catch (e) {
      console.error('Invite error:', e);
      res.status(500).json({ error: 'Failed to send invite' });
    }
  });

  app.post('/admin/remove-user', authLimiter, requireAdmin, (req, res) => {
    try {
      const user = findUserByIdentifier(req.body.user_id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      deleteUserDataTx(user.id, 'admin_removed');
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message || 'Failed to remove user' });
    }
  });

  app.post('/admin/end-match', authLimiter, requireAdmin, (req, res) => {
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

  app.post('/admin/unmatch-user', authLimiter, requireAdmin, (req, res) => {
    try {
      const user = findUserByIdentifier(req.body.user_id);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const match = stmts.getMatch.get(user.id, user.id);
      if (!match) return res.status(404).json({ error: 'User is not currently matched' });

      const partnerId = match.user1_id === user.id ? match.user2_id : match.user1_id;
      db.transaction(() => deleteMatchData(match.id))();
      res.json({ ok: true, match_id: match.id, user_id: user.id, partner_id: partnerId });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message || 'Failed to unmatch user' });
    }
  });

  app.post('/admin/dismiss-report', authLimiter, requireAdmin, (req, res) => {
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
        waiting_entries: db.prepare('SELECT * FROM waiting_entries ORDER BY id').all(),
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
