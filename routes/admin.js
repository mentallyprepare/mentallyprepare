const path = require('path');
const crypto = require('crypto');
const { signInAgainEmail } = require('../email-templates');
const { logAdminAction } = require('../lib/admin-auth');
const REPORT_STATUSES = new Set(['open', 'reviewed', 'dismissed', 'escalated', 'resolved']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    getCurrentJourneyDay,
    getNextUnsealAt,
    getMatchRegion,
    isEntryUnlocked,
    attachWaitingEntriesToMatch,
    findUserByIdentifier,
    deleteUserDataTx,
    deleteMatchData,
    sendWaitlistAccepted,
    attemptMatch,
    broadcastPush,
    sendSignInAgain,
    sendSignInFollowUp,
    emailServiceEnabled
  } = deps;

  const appLink = process.env.APP_BASE_URL || 'https://mymentallyprepare.com/app';
  const baseUrl = (process.env.APP_BASE_URL || 'https://mymentallyprepare.com').replace(/\/app\/?$/, '').replace(/\/$/, '');

  function updateReportStatus(reportId, status, reason, actor = 'admin') {
    if (!Number.isInteger(reportId) || reportId <= 0) {
      const err = new Error('Valid report ID required');
      err.statusCode = 400;
      throw err;
    }
    if (!REPORT_STATUSES.has(status)) {
      const err = new Error('Valid report status required');
      err.statusCode = 400;
      throw err;
    }
    return db.transaction(() => {
      const report = stmts.getReportById.get(reportId);
      if (!report) {
        const err = new Error('Report not found');
        err.statusCode = 404;
        throw err;
      }
      const oldStatus = report.status || 'open';
      stmts.updateReportStatus.run(status, reportId);
      stmts.insertReportStatusHistory.run(reportId, actor, String(reason || '').trim(), oldStatus, status);
      return { ok: true, report_id: reportId, old_status: oldStatus, new_status: status };
    })();
  }

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

  function reauthRecipients() {
    const users = db.prepare("SELECT id, name, email FROM users WHERE COALESCE(account_status, 'active') != 'deleted' ORDER BY id").all();
    return {
      totalAccounts: users.length,
      recipients: users.filter(user => EMAIL_RE.test(String(user.email || '').trim()))
    };
  }

  function freshStartCounts() {
    return {
      activeMatches: db.prepare('SELECT COUNT(*) AS n FROM matches WHERE archived_at IS NULL').get().n,
      matchEntries: db.prepare('SELECT COUNT(*) AS n FROM entries e JOIN matches m ON m.id = e.match_id WHERE m.archived_at IS NULL').get().n,
      standaloneReflections: ['waiting_entries', 'tonights_question_entries', 'daily_notes'].reduce((sum, table) =>
        sum + db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
    };
  }

  function archiveStandaloneRecords() {
    const insert = db.prepare('INSERT INTO archived_user_records (user_id, source, content_json) VALUES (?, ?, ?)');
    for (const [table, source] of [['waiting_entries', 'waiting'], ['tonights_question_entries', 'tonights_question'], ['daily_notes', 'daily_note']]) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) insert.run(row.user_id, source, JSON.stringify(row));
      db.prepare(`DELETE FROM ${table}`).run();
    }
  }

  const nextDelivery = db.prepare(`
    SELECT d.campaign_id, d.user_id, d.email, d.name
    FROM reauth_campaign_deliveries d
    JOIN reauth_campaigns c ON c.id = d.campaign_id
    WHERE c.status = 'sending' AND d.status = 'pending'
      AND (c.pause_until IS NULL OR c.pause_until <= datetime('now'))
    ORDER BY d.campaign_id, d.user_id LIMIT 1
  `);
  const claimDelivery = db.prepare("UPDATE reauth_campaign_deliveries SET status = 'sending', attempted_at = datetime('now') WHERE campaign_id = ? AND user_id = ? AND status = 'pending'");
  const finishDelivery = db.prepare('UPDATE reauth_campaign_deliveries SET status = ? WHERE campaign_id = ? AND user_id = ?');
  let sendingReauthEmail = false;

  function sqliteUtc(date) {
    return date.toISOString().replace('T', ' ').slice(0, 19);
  }

  function providerPauseUntil(error) {
    if (error.statusCode !== 429) return null;
    const now = new Date();
    const code = String(error.providerCode || '').toLowerCase();
    if (code === 'monthly_quota_exceeded') {
      return sqliteUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5)));
    }
    if (code === 'daily_quota_exceeded') {
      return sqliteUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)));
    }
    const retrySeconds = Number(error.retryAfter);
    return sqliteUtc(new Date(now.getTime() + (Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.max(retrySeconds, 60) : 300) * 1000));
  }

  function reconcileReauthCampaigns() {
    // A crash can leave one claimed delivery without a known outcome. Keep it
    // visible for human review and never resend it automatically.
    db.prepare("UPDATE reauth_campaign_deliveries SET status = 'uncertain' WHERE status = 'sending' AND attempted_at <= datetime('now', '-10 minutes')").run();
    db.exec(`UPDATE reauth_campaigns SET
      sent = (SELECT COUNT(*) FROM reauth_campaign_deliveries WHERE campaign_id = reauth_campaigns.id AND status = 'sent'),
      failed = (SELECT COUNT(*) FROM reauth_campaign_deliveries WHERE campaign_id = reauth_campaigns.id AND status IN ('failed', 'uncertain'))
      WHERE status = 'sending';
      UPDATE reauth_campaigns SET status = CASE WHEN failed > 0 THEN 'completed_with_errors' ELSE 'completed' END
      WHERE status = 'sending' AND NOT EXISTS (SELECT 1 FROM reauth_campaign_deliveries WHERE campaign_id = reauth_campaigns.id AND status IN ('pending', 'sending'));`);
  }

  async function processReauthEmail() {
    if (sendingReauthEmail || !emailServiceEnabled || typeof sendSignInAgain !== 'function') return;
    reconcileReauthCampaigns();
    const delivery = nextDelivery.get();
    if (!delivery) return;
    if (claimDelivery.run(delivery.campaign_id, delivery.user_id).changes !== 1) return;
    sendingReauthEmail = true;
    let status = 'sent';
    try {
      await sendSignInAgain(delivery.email, delivery.name);
    } catch (error) {
      const pauseUntil = providerPauseUntil(error);
      if (pauseUntil) {
        status = 'pending';
        db.prepare('UPDATE reauth_campaigns SET pause_until = ? WHERE id = ?').run(pauseUntil, delivery.campaign_id);
        console.warn(`Sign-in campaign email provider limit reached; queued delivery will resume after ${pauseUntil}.`);
      } else {
        status = 'failed';
        console.error('Sign-in campaign delivery failed; check delivery status in Founder admin.');
      }
    } finally {
      try {
        finishDelivery.run(status, delivery.campaign_id, delivery.user_id);
        db.prepare(`UPDATE reauth_campaigns SET
          sent = (SELECT COUNT(*) FROM reauth_campaign_deliveries WHERE campaign_id = ? AND status = 'sent'),
          failed = (SELECT COUNT(*) FROM reauth_campaign_deliveries WHERE campaign_id = ? AND status IN ('failed', 'uncertain'))
          WHERE id = ?`).run(delivery.campaign_id, delivery.campaign_id, delivery.campaign_id);
        db.prepare(`UPDATE reauth_campaigns SET status = CASE WHEN failed > 0 THEN 'completed_with_errors' ELSE 'completed' END
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM reauth_campaign_deliveries WHERE campaign_id = ? AND status IN ('pending', 'sending'))`).run(delivery.campaign_id, delivery.campaign_id);
      } finally {
        sendingReauthEmail = false;
      }
    }
  }

  // One recipient at a time. Persistent rows survive a restart; uncertain in-flight
  // deliveries are left for review rather than silently sent twice.
  const reauthTimer = setInterval(() => processReauthEmail().catch(error => console.error('Sign-in campaign worker failed:', error)), 1800);
  if (reauthTimer.unref) reauthTimer.unref();

  const followUpEligibleSql = `
    SELECT d.campaign_id, d.user_id, d.email, d.name
    FROM reauth_campaign_deliveries d
    JOIN users u ON u.id = d.user_id
    WHERE d.campaign_id = (SELECT MAX(id) FROM reauth_campaigns)
      AND d.status = 'sent' AND d.attempted_at <= datetime('now', '-3 days')
      AND COALESCE(u.account_status, 'active') != 'deleted'
      AND CASE WHEN json_valid(u.push_preferences) THEN json_extract(u.push_preferences, '$.emailReminders') ELSE 0 END = 1
      AND u.archetype IS NULL
      AND (u.last_login_at IS NULL OR datetime(u.last_login_at) < datetime(u.auth_reset_at, 'unixepoch'))
      AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id AND e.event_name = 'login'
        AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch'))
      AND NOT EXISTS (SELECT 1 FROM reauth_followup_deliveries f WHERE f.user_id = u.id)
    ORDER BY d.user_id`;
  const followUpEligible = db.prepare(followUpEligibleSql);
  const followUpStillEligible = db.prepare(`SELECT 1 FROM users u WHERE u.id = ?
    AND COALESCE(u.account_status, 'active') != 'deleted'
    AND CASE WHEN json_valid(u.push_preferences) THEN json_extract(u.push_preferences, '$.emailReminders') ELSE 0 END = 1
    AND u.archetype IS NULL
    AND (u.last_login_at IS NULL OR datetime(u.last_login_at) < datetime(u.auth_reset_at, 'unixepoch'))
    AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id = u.id AND e.event_name = 'login'
      AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch'))`);
  let sendingFollowUp = false;
  async function processSignInFollowUp() {
    if (sendingFollowUp || !emailServiceEnabled || typeof sendSignInFollowUp !== 'function') return;
    db.prepare("UPDATE reauth_followup_deliveries SET status = 'uncertain' WHERE status = 'sending' AND attempted_at <= datetime('now', '-10 minutes')").run();
    const delivery = db.prepare("SELECT * FROM reauth_followup_deliveries WHERE status = 'pending' ORDER BY user_id LIMIT 1").get();
    if (!delivery || (delivery.next_attempt_at && delivery.next_attempt_at > sqliteUtc(new Date()))) return;
    if (db.prepare("UPDATE reauth_followup_deliveries SET status = 'sending', attempted_at = datetime('now') WHERE user_id = ? AND status = 'pending'").run(delivery.user_id).changes !== 1) return;
    sendingFollowUp = true;
    try {
      if (!followUpStillEligible.get(delivery.user_id)) {
        db.prepare("UPDATE reauth_followup_deliveries SET status = 'skipped' WHERE user_id = ?").run(delivery.user_id);
        return;
      }
      await sendSignInFollowUp(delivery.email, delivery.name);
      db.prepare("UPDATE reauth_followup_deliveries SET status = 'sent' WHERE user_id = ?").run(delivery.user_id);
    } catch (error) {
      const pauseUntil = providerPauseUntil(error);
      if (pauseUntil) {
        db.prepare("UPDATE reauth_followup_deliveries SET status = 'pending', next_attempt_at = ? WHERE user_id = ?").run(pauseUntil, delivery.user_id);
        console.warn(`Sign-in follow-up provider limit reached; queued delivery resumes after ${pauseUntil}.`);
      } else {
        db.prepare("UPDATE reauth_followup_deliveries SET status = 'failed' WHERE user_id = ?").run(delivery.user_id);
        console.error('Sign-in follow-up delivery failed; review Founder dashboard.');
      }
    } finally {
      sendingFollowUp = false;
    }
  }
  const followUpTimer = setInterval(() => processSignInFollowUp().catch(error => console.error('Sign-in follow-up worker failed:', error)), 1800);
  if (followUpTimer.unref) followUpTimer.unref();

  app.get('/admin/reauth-campaign/follow-up/preview', authLimiter, requireAdmin, (req, res) => {
    if (req.admin.role !== 'admin' || req.admin.legacy) return res.status(403).json({ error: 'A named founder admin is required' });
    const eligible = followUpEligible.all();
    const statuses = db.prepare('SELECT status, COUNT(*) AS count FROM reauth_followup_deliveries GROUP BY status').all();
    const nextAttempt = db.prepare("SELECT next_attempt_at FROM reauth_followup_deliveries WHERE status = 'pending' AND next_attempt_at IS NOT NULL ORDER BY next_attempt_at DESC LIMIT 1").get();
    res.json({ ok: true, eligible: eligible.length, statuses, nextAttemptAt: nextAttempt?.next_attempt_at || null,
      canStart: eligible.length > 0 && !!emailServiceEnabled, subject: 'Your Mentally Prepare space is here' });
  });

  app.post('/admin/reauth-campaign/follow-up/start', authLimiter, requireAdmin, (req, res) => {
    if (req.admin.role !== 'admin' || req.admin.legacy) return res.status(403).json({ error: 'A named founder admin is required' });
    if (!emailServiceEnabled || typeof sendSignInFollowUp !== 'function') return res.status(503).json({ error: 'Email delivery is not configured' });
    if (req.body?.confirmation !== 'SEND FOLLOWUP') return res.status(400).json({ error: 'Confirm SEND FOLLOWUP' });
    const queued = db.transaction(() => {
      const eligible = followUpEligible.all();
      const insert = db.prepare('INSERT OR IGNORE INTO reauth_followup_deliveries (campaign_id, user_id, email, name) VALUES (?, ?, ?, ?)');
      let count = 0;
      for (const person of eligible) count += insert.run(person.campaign_id, person.user_id, person.email, person.name).changes;
      return count;
    })();
    if (!queued) return res.status(409).json({ error: 'No eligible past users remain' });
    logAdminAction(db, req, 'auth.followup_queued', { metadata: { queued } });
    res.status(202).json({ ok: true, queued });
    processSignInFollowUp().catch(error => console.error('Sign-in follow-up worker failed:', error));
  });

  app.get('/admin/reauth-campaign/preview', authLimiter, requireAdmin, (req, res) => {
    if (req.admin.role !== 'admin' || req.admin.legacy) return res.status(403).json({ error: 'A named founder admin is required' });
    const { totalAccounts, recipients } = reauthRecipients();
    const campaign = db.prepare('SELECT id, created_at, status, total, sent, failed, pause_until AS pauseUntil FROM reauth_campaigns ORDER BY id DESC LIMIT 1').get() || null;
    const blocked = db.prepare("SELECT id FROM reauth_campaigns WHERE status = 'sending' OR created_at >= datetime('now', '-30 days') LIMIT 1").get();
    const deliveries = campaign ? db.prepare('SELECT user_id AS userId, email, status, attempted_at AS attemptedAt FROM reauth_campaign_deliveries WHERE campaign_id = ? ORDER BY user_id').all(campaign.id) : [];
    res.json({ ok: true, totalAccounts, recipientCount: recipients.length, skippedCount: totalAccounts - recipients.length,
      freshStart: freshStartCounts(), dailyEmailRecipients: recipients.length,
      subject: 'A new Mentally Prepare journey is ready', sampleHtml: signInAgainEmail('friend'),
      recipients: recipients.map(user => ({ userId: user.id, email: user.email })), campaign, deliveries, canStart: !blocked && recipients.length > 0 && !!emailServiceEnabled });
  });

  app.get('/admin/reauth-campaign/progress', authLimiter, requireAdmin, (req, res) => {
    if (req.admin.role !== 'admin' || req.admin.legacy) return res.status(403).json({ error: 'A named founder admin is required' });
    const campaign = db.prepare('SELECT id, created_at, total, sent, failed FROM reauth_campaigns ORDER BY id DESC LIMIT 1').get();
    if (!campaign) return res.json({ ok: true, campaign: null, counts: null, people: [] });
    const rows = db.prepare(`
      SELECT d.user_id AS userId, d.name, d.email, d.status AS emailStatus,
        u.archetype,
        EXISTS(SELECT 1 FROM analytics_events e WHERE e.user_id = d.user_id AND e.event_name = 'login'
          AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch'))
          OR datetime(u.last_login_at) >= datetime(u.auth_reset_at, 'unixepoch') AS signedIn,
        EXISTS(SELECT 1 FROM analytics_events e WHERE e.user_id = d.user_id AND e.event_name = 'scan_started'
          AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch')) AS scanStarted,
        EXISTS(SELECT 1 FROM analytics_events e WHERE e.user_id = d.user_id AND e.event_name = 'day_1_written'
          AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch')) AS firstNote,
        (SELECT COUNT(DISTINCT date(e.created_at, '+330 minutes')) FROM analytics_events e
          WHERE e.user_id = d.user_id AND e.event_name IN ('day_1_written', 'day_written')
          AND e.created_at >= datetime(u.auth_reset_at, 'unixepoch')) AS writingDays
      FROM reauth_campaign_deliveries d
      JOIN users u ON u.id = d.user_id
      WHERE d.campaign_id = ? ORDER BY d.user_id
    `).all(campaign.id);
    const people = rows.map(row => ({
      userId: row.userId, name: row.name, email: row.email, emailStatus: row.emailStatus,
      firstNote: !!row.firstNote,
      writingDays: Number(row.writingDays || 0),
      stage: row.archetype ? 'test_completed' : row.scanStarted ? 'test_started' : row.firstNote ? 'first_note' : row.signedIn ? 'signed_in' : 'not_seen'
    }));
    const counts = { invited: campaign.total, signedIn: 0, firstNote: 0, wroteOnTwoDays: 0, testStarted: 0, testCompleted: 0 };
    for (const person of people) {
      if (person.stage !== 'not_seen') counts.signedIn++;
      if (person.firstNote) counts.firstNote++;
      if (person.writingDays >= 2) counts.wroteOnTwoDays++;
      if (person.stage === 'test_started' || person.stage === 'test_completed') counts.testStarted++;
      if (person.stage === 'test_completed') counts.testCompleted++;
    }
    res.json({ ok: true, campaign, counts, people });
  });

  app.post('/admin/reauth-campaign/start', authLimiter, requireAdmin, (req, res) => {
    if (req.admin.role !== 'admin' || req.admin.legacy) return res.status(403).json({ error: 'A named founder admin is required' });
    if (!emailServiceEnabled || typeof sendSignInAgain !== 'function') return res.status(503).json({ error: 'Email delivery is not configured' });
    if (!req.body || req.body.confirmation !== 'REQUIRE SIGN-IN') return res.status(400).json({ error: 'Type REQUIRE SIGN-IN to confirm' });
    const previous = db.prepare("SELECT id FROM reauth_campaigns WHERE status = 'sending' OR created_at >= datetime('now', '-30 days') ORDER BY id DESC LIMIT 1").get();
    if (previous) return res.status(409).json({ error: 'A sign-in campaign is running or was started in the last 30 days' });
    const { recipients } = reauthRecipients();
    if (!recipients.length) return res.status(409).json({ error: 'No deliverable account email addresses found' });
    const startedAt = Math.floor(Date.now() / 1000);
    const campaignId = db.transaction(() => {
      const campaign = db.prepare('INSERT INTO reauth_campaigns (started_by, total) VALUES (?, ?)').run(req.admin.email, recipients.length);
      archiveStandaloneRecords();
      db.prepare("UPDATE matches SET archived_at = datetime('now') WHERE archived_at IS NULL").run();
      const updateFreshStart = db.prepare("UPDATE users SET archetype = NULL, scores = NULL, switch_count = 0, last_active_date = NULL, push_preferences = ? WHERE id = ? AND COALESCE(account_status, 'active') != 'deleted'");
      for (const user of db.prepare("SELECT id, push_preferences FROM users WHERE COALESCE(account_status, 'active') != 'deleted'").all()) {
        let preferences = {};
        try { preferences = user.push_preferences ? JSON.parse(user.push_preferences) : {}; } catch {}
        updateFreshStart.run(JSON.stringify({ ...preferences, emailReminders: true }), user.id);
      }
      db.prepare("UPDATE users SET auth_version = COALESCE(auth_version, 0) + 1, auth_reset_at = ? WHERE COALESCE(account_status, 'active') != 'deleted'").run(startedAt);
      const insert = db.prepare('INSERT INTO reauth_campaign_deliveries (campaign_id, user_id, email, name) VALUES (?, ?, ?, ?)');
      for (const user of recipients) insert.run(campaign.lastInsertRowid, user.id, user.email.trim(), user.name || 'friend');
      return Number(campaign.lastInsertRowid);
    })();
    logAdminAction(db, req, 'auth.force_signin_all', { metadata: { campaignId, recipients: recipients.length } });
    res.status(202).json({ ok: true, campaignId, queued: recipients.length });
    processReauthEmail().catch(error => console.error('Sign-in campaign worker failed:', error));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'admin.html'));
  });

  app.get('/admin/reminders', (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'admin-reminders.html'));
  });

  app.get('/admin/reports', authLimiter, requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT r.id, r.day, r.reason, r.created_at, r.updated_at, r.category, r.status
        FROM reports r
        ORDER BY r.created_at DESC
        LIMIT 20
      `).all();
      res.json(rows.map(r => ({
        id: r.id,
        day: r.day,
        category: r.category,
        status: r.status,
        reason: r.reason,
        date: r.created_at,
        updated_at: r.updated_at
      })));
    } catch (e) {
      res.status(500).json({ error: 'Failed to load reports' });
    }
  });

  app.get('/admin/users', authLimiter, requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT
          u.id, u.name, u.email, u.college, u.year, u.archetype, u.created_at,
          (
            SELECT m.id FROM matches m
            WHERE m.archived_at IS NULL AND (m.user1_id = u.id OR m.user2_id = u.id)
            ORDER BY m.started_at DESC
            LIMIT 1
          ) as match_id,
          (
            SELECT CASE WHEN m.user1_id = u.id THEN m.user2_id ELSE m.user1_id END
            FROM matches m
            WHERE m.archived_at IS NULL AND (m.user1_id = u.id OR m.user2_id = u.id)
            ORDER BY m.started_at DESC
            LIMIT 1
          ) as partner_id,
          (
            SELECT p.name
            FROM matches m
            JOIN users p ON p.id = CASE WHEN m.user1_id = u.id THEN m.user2_id ELSE m.user1_id END
            WHERE m.archived_at IS NULL AND (m.user1_id = u.id OR m.user2_id = u.id)
            ORDER BY m.started_at DESC
            LIMIT 1
          ) as partner_name
        FROM users u
        WHERE COALESCE(u.account_status, 'active') != 'deleted'
        ORDER BY u.created_at DESC
      `).all();
      res.json(rows.map(row => ({ ...row, has_match: !!row.match_id })));
    } catch (e) {
      res.status(500).json({ error: 'Failed to load users' });
    }
  });

  app.post('/admin/create-verification-link', authLimiter, requireAdmin, (req, res) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email required' });
      }

      const user = stmts.getUserByEmail.get(email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

      const token = crypto.randomBytes(32).toString('hex');
      stmts.updateVerificationToken.run(token, new Date().toISOString(), user.id);
      res.json({
        ok: true,
        email: user.email,
        verifyUrl: `${baseUrl}/api/verify-email?token=${encodeURIComponent(token)}`
      });
    } catch (e) {
      console.error('Create verification link error:', e);
      res.status(500).json({ error: 'Failed to create verification link' });
    }
  });

  app.get('/api/admin/reengagement-users', authLimiter, requireAdmin, (req, res) => {
    try {
      const users = db.prepare(`
        SELECT id, name, email, college, year, archetype, last_active_date, created_at
        FROM users
        ORDER BY created_at DESC
      `).all();

      const matches = db.prepare('SELECT * FROM matches WHERE archived_at IS NULL ORDER BY started_at DESC').all();
      const entries = db.prepare(`
        SELECT e.id, e.user_id, e.match_id, e.day, e.created_at
        FROM entries e JOIN matches m ON m.id = e.match_id
        WHERE m.archived_at IS NULL
        ORDER BY e.created_at DESC
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

  app.get('/admin/stats', authLimiter, requireAdmin, (req, res) => {
    try {
      res.json(getAdminStats());
    } catch (e) {
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });

  app.get('/admin/matches-debug', authLimiter, requireAdmin, (req, res) => {
    try {
      const matches = db.prepare('SELECT * FROM matches WHERE archived_at IS NULL ORDER BY started_at DESC').all();
      const rows = matches.map(match => {
        const user1Entries = db.prepare('SELECT day, created_at FROM entries WHERE user_id = ? AND match_id = ? ORDER BY day DESC').all(match.user1_id, match.id);
        const user2Entries = db.prepare('SELECT day, created_at FROM entries WHERE user_id = ? AND match_id = ? ORDER BY day DESC').all(match.user2_id, match.id);
        const currentDay = getMatchDay(match.started_at);
        const matchRegion = getMatchRegion(match);
        const unlockedDay = getCurrentJourneyDay(match.started_at, matchRegion);
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
          region: matchRegion,
          nextUnsealAt: getNextUnsealAt(matchRegion)
        };
      });
      res.json({ ok: true, generatedAt: new Date().toISOString(), matches: rows });
    } catch (e) {
      console.error('Match debug admin error:', e);
      res.status(500).json({ error: 'Failed to load match debug data' });
    }
  });

  app.get('/admin/logs', authLimiter, requireAdmin, (req, res) => {
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

  app.get('/admin/activity', authLimiter, requireAdmin, (req, res) => {
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
          SELECT r.created_at, 'report' as type, 'Report #' || r.id || ' submitted: ' || r.reason as message
          FROM reports r
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
      // Email verification no longer required for matching
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
  app.post('/admin/run-matching', authLimiter, requireAdmin, (req, res) => {
    try {
      // Get all unmatched users who have an archetype
      const waiting = db.prepare(`
        SELECT u.id FROM users u
        LEFT JOIN matches m ON m.archived_at IS NULL AND (m.user1_id = u.id OR m.user2_id = u.id)
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

  // Admin broadcast — push a message to every saved subscription
  app.post('/api/push/send-all', authLimiter, requireAdmin, async (req, res) => {
    try {
      const message = String(req.body.message || '').trim();
      if (!message) return res.status(400).json({ error: 'Message is required' });
      if (typeof broadcastPush !== 'function') return res.status(503).json({ error: 'Push not configured' });
      const result = await broadcastPush(message);
      if (!result.ok) return res.status(503).json({ error: result.error || 'Push not configured' });
      res.json({ ok: true, sent: result.sent, failed: result.failed, total: result.total });
    } catch (e) {
      console.error('Broadcast push error:', e);
      res.status(500).json({ error: 'Failed to send broadcast' });
    }
  });

  app.post('/admin/remove-user', authLimiter, requireAdmin, (req, res) => {
    try {
      const user = findUserByIdentifier(req.body.user_id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      deleteUserDataTx(user.id, 'admin_removed');
      try {
        stmts.insertAnalyticsEvent.run(null, 'admin_remove_user', JSON.stringify({
          target_anonymised_id: crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 16)
        }));
      } catch (e) {
        console.warn('admin_remove_user analytics skipped:', e.message);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message || 'Failed to remove user' });
    }
  });

  app.post('/admin/end-match', authLimiter, requireAdmin, (req, res) => {
    try {
      const matchId = Number(req.body.match_id);
      if (!Number.isInteger(matchId) || matchId <= 0) return res.status(400).json({ error: 'Valid match ID required' });
      const match = db.prepare('SELECT id FROM matches WHERE id = ? AND archived_at IS NULL').get(matchId);
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

  app.post('/admin/report-status', authLimiter, requireAdmin, (req, res) => {
    try {
      const reportId = Number(req.body.report_id);
      const status = String(req.body.status || '').trim().toLowerCase();
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'Reason is required' });
      res.json(updateReportStatus(reportId, status, reason));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message || 'Failed to update report' });
    }
  });

  app.post('/admin/dismiss-report', authLimiter, requireAdmin, (req, res) => {
    try {
      const reportId = Number(req.body.report_id);
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'Reason is required' });
      res.json(updateReportStatus(reportId, 'dismissed', reason));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message || 'Failed to dismiss report' });
    }
  });

  app.get('/admin/export', authLimiter, requireAdmin, (req, res) => {
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
        report_status_history: db.prepare('SELECT * FROM report_status_history ORDER BY id').all(),
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
