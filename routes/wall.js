// ─── Anonymous Wall — Routes ───
// "Me Too" wall with crisis moderation, reactions, and match handshake.

const POST_CHAR_LIMIT = 500;
const SUPPORT_LINE_LIMIT = 200;
const EXPIRE_HOURS = 36;
const MAX_POSTS_PER_DAY = 3;
const MATCH_DURATION_DAYS = 21;

function registerWallRoutes(app, deps) {
  const { apiLimiter, requireAuth, db, scanForSafety, HELPLINES, getCrisisPayload, trackEvent } = deps;

  // ── Prepared statements ──
  const wallStmts = {
    getActiveQuestion: db.prepare('SELECT * FROM wall_questions WHERE active = 1 ORDER BY id DESC LIMIT 1'),
    getWallPosts: db.prepare(`
      SELECT p.id, p.content, p.created_at, p.match_opt_in,
             (SELECT COUNT(*) FROM wall_reactions r WHERE r.post_id = p.id) AS me_too_count,
             EXISTS(SELECT 1 FROM wall_reactions r WHERE r.post_id = p.id AND r.user_id = ?) AS reacted,
             (p.user_id = ?) AS is_mine
      FROM wall_posts p
      WHERE p.question_id = ? AND p.expire_at > datetime('now') AND p.flagged = 0
      ORDER BY p.created_at DESC
    `),
    getPostById: db.prepare(
      'SELECT id, user_id, match_opt_in FROM wall_posts WHERE id = ? AND expire_at > datetime(\'now\') AND flagged = 0'
    ),
    getUserPostForQuestion: db.prepare(
      'SELECT id FROM wall_posts WHERE question_id = ? AND user_id = ? AND is_seed = 0'
    ),
    getUserPostCountToday: db.prepare(
      `SELECT COUNT(*) as count FROM wall_posts
       WHERE user_id = ? AND is_seed = 0 AND created_at > datetime('now', '-1 day')`
    ),
    insertPost: db.prepare(
      `INSERT INTO wall_posts (question_id, user_id, content, match_opt_in, flagged, expire_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+${EXPIRE_HOURS} hours'))`
    ),
    insertReaction: db.prepare(
      'INSERT OR IGNORE INTO wall_reactions (post_id, user_id) VALUES (?, ?)'
    ),
    getReactionCount: db.prepare(
      'SELECT COUNT(*) as count FROM wall_reactions WHERE post_id = ?'
    ),
    hasReacted: db.prepare(
      'SELECT 1 FROM wall_reactions WHERE post_id = ? AND user_id = ?'
    ),
    insertMatchRequest: db.prepare(
      'INSERT INTO wall_match_requests (post_id, reactor_id, poster_id, support_line) VALUES (?, ?, ?, ?)'
    ),
    getMatchRequest: db.prepare(
      'SELECT * FROM wall_match_requests WHERE id = ? AND poster_id = ?'
    ),
    getExistingMatchRequest: db.prepare(
      'SELECT id FROM wall_match_requests WHERE post_id = ? AND reactor_id = ?'
    ),
    getPendingRequests: db.prepare(`
      SELECT mr.id, mr.post_id, mr.status, mr.support_line, mr.created_at,
             p.content AS post_content
      FROM wall_match_requests mr
      JOIN wall_posts p ON p.id = mr.post_id
      WHERE mr.poster_id = ? AND mr.status = 'pending'
      ORDER BY mr.created_at DESC
    `),
    acceptRequest: db.prepare("UPDATE wall_match_requests SET status = 'accepted' WHERE id = ?"),
    declineRequest: db.prepare("UPDATE wall_match_requests SET status = 'declined' WHERE id = ?"),
    expireOtherRequests: db.prepare(
      "UPDATE wall_match_requests SET status = 'expired' WHERE poster_id = ? AND id != ? AND status = 'pending'"
    ),
    insertMatch: db.prepare(
      `INSERT INTO matches (user1_id, user2_id, matched_at, wall_origin, wall_expires_at)
       VALUES (?, ?, datetime('now'), 1, datetime('now', '+${MATCH_DURATION_DAYS} days'))`
    ),
    hasActiveMatch: db.prepare(
      `SELECT 1 FROM matches WHERE (user1_id = ? OR user2_id = ?)
       AND (
         (wall_origin = 1 AND wall_expires_at > datetime('now'))
         OR (COALESCE(wall_origin, 0) = 0 AND started_at > datetime('now', '-21 days'))
       )`
    ),
    insertChatMessage: db.prepare(
      'INSERT INTO wall_chat_messages (match_id, sender_id, content) VALUES (?, ?, ?)'
    ),
  };

  // Crisis message now comes from getCrisisPayload(req) for locale-aware helplines

  // GET /api/wall/feed
  app.get('/api/wall/feed', apiLimiter, requireAuth, (req, res) => {
    try {
      const q = wallStmts.getActiveQuestion.get();
      if (!q) return res.json({ question: null, posts: [] });

      const posts = wallStmts.getWallPosts.all(req.session.userId, req.session.userId, q.id);

      const safePosts = posts.map(({ is_mine, ...post }) => ({
        ...post,
        is_mine: Boolean(is_mine),
        reacted: Boolean(post.reacted),
      }));

      res.json({ question: { id: q.id, prompt: q.prompt }, posts: safePosts });
    } catch (e) {
      console.error('Wall feed error:', e);
      res.status(500).json({ error: 'Failed to load the wall' });
    }
  });

  // POST /api/wall/post
  app.post('/api/wall/post', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { content, match_opt_in } = req.body;
      const trimmed = String(content || '').trim();

      if (!trimmed || trimmed.length > POST_CHAR_LIMIT) {
        return res.status(400).json({ error: `Content required, max ${POST_CHAR_LIMIT} characters` });
      }

      const q = wallStmts.getActiveQuestion.get();
      if (!q) return res.status(400).json({ error: 'No active question' });

      // Rate limit: 1 post per user per question
      if (wallStmts.getUserPostForQuestion.get(q.id, userId)) {
        return res.status(429).json({ error: "You've already posted for tonight's question" });
      }

      // Rate limit: max 3 posts per day
      const todayCount = wallStmts.getUserPostCountToday.get(userId);
      if (todayCount.count >= MAX_POSTS_PER_DAY) {
        return res.status(429).json({ error: 'Daily post limit reached' });
      }

      // Crisis check
      const safety = scanForSafety(trimmed);
      if (safety.crisis) {
        wallStmts.insertPost.run(q.id, userId, trimmed, match_opt_in ? 1 : 0, 1);
        if (trackEvent) trackEvent(userId, 'crisis_keyword_triggered', { surface: 'wall_post' });
        const crisis = getCrisisPayload(req);
        return res.json({
          crisis: true,
          helplines: crisis.helplines,
          message: crisis.message,
        });
      }

      const optIn = match_opt_in === false ? 0 : 1;
      wallStmts.insertPost.run(q.id, userId, trimmed, optIn, 0);
      res.json({ ok: true });
    } catch (e) {
      console.error('Wall post error:', e);
      res.status(500).json({ error: 'Failed to save post' });
    }
  });

  // POST /api/wall/react
  app.post('/api/wall/react', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { post_id } = req.body;
      if (!post_id) return res.status(400).json({ error: 'post_id required' });

      const post = wallStmts.getPostById.get(post_id);
      if (!post) return res.status(404).json({ error: 'Post not found' });

      if (post.user_id === userId) {
        return res.status(400).json({ error: 'Cannot react to your own post' });
      }

      wallStmts.insertReaction.run(post_id, userId);
      const count = wallStmts.getReactionCount.get(post_id);
      res.json({ me_too_count: count.count });
    } catch (e) {
      console.error('Wall react error:', e);
      res.status(500).json({ error: 'Failed to save reaction' });
    }
  });

  // POST /api/wall/match-request — reactor initiates
  app.post('/api/wall/match-request', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { post_id, support_line } = req.body;
      if (!post_id) return res.status(400).json({ error: 'post_id required' });

      const post = wallStmts.getPostById.get(post_id);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (post.user_id === userId) return res.status(400).json({ error: 'Cannot request match on your own post' });
      if (!post.match_opt_in) return res.status(400).json({ error: 'This post does not accept match requests' });

      if (!wallStmts.hasReacted.get(post_id, userId)) {
        return res.status(400).json({ error: 'You must react before requesting a match' });
      }

      // Clean and crisis-check support line
      let cleanLine = null;
      if (support_line) {
        cleanLine = String(support_line).trim().slice(0, SUPPORT_LINE_LIMIT);
        if (cleanLine) {
          const safety = scanForSafety(cleanLine);
          if (safety.crisis) {
            if (trackEvent) trackEvent(userId, 'crisis_keyword_triggered', { surface: 'wall_support_line' });
            const crisis = getCrisisPayload(req);
            return res.json({ crisis: true, helplines: crisis.helplines, message: crisis.message });
          }
        }
      }

      if (wallStmts.getExistingMatchRequest.get(post_id, userId)) {
        return res.status(409).json({ error: 'Match request already sent' });
      }

      wallStmts.insertMatchRequest.run(post_id, userId, post.user_id, cleanLine);
      res.json({ ok: true });
    } catch (e) {
      console.error('Wall match-request error:', e);
      res.status(500).json({ error: 'Failed to send request' });
    }
  });

  // GET /api/wall/match-requests — poster sees incoming
  app.get('/api/wall/match-requests', apiLimiter, requireAuth, (req, res) => {
    try {
      const requests = wallStmts.getPendingRequests.all(req.session.userId);
      res.json({ requests });
    } catch (e) {
      console.error('Wall match-requests error:', e);
      res.status(500).json({ error: 'Failed to load requests' });
    }
  });

  // POST /api/wall/match-respond — poster accepts or declines
  app.post('/api/wall/match-respond', apiLimiter, requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const { request_id, accept } = req.body;
      if (!request_id) return res.status(400).json({ error: 'request_id required' });

      const matchReq = wallStmts.getMatchRequest.get(request_id, userId);
      if (!matchReq) return res.status(404).json({ error: 'Request not found' });
      if (matchReq.status !== 'pending') return res.status(400).json({ error: 'Request already resolved' });

      if (accept) {
        // One-active-match-per-user guard: any origin
        if (wallStmts.hasActiveMatch.get(matchReq.poster_id, matchReq.poster_id)) {
          return res.status(409).json({ error: 'You already have an active match' });
        }
        if (wallStmts.hasActiveMatch.get(matchReq.reactor_id, matchReq.reactor_id)) {
          return res.status(409).json({ error: 'This person already has an active match' });
        }

        const doAccept = db.transaction(() => {
          wallStmts.acceptRequest.run(request_id);
          wallStmts.expireOtherRequests.run(matchReq.poster_id, request_id);
          const info = wallStmts.insertMatch.run(matchReq.poster_id, matchReq.reactor_id);
          if (matchReq.support_line) {
            wallStmts.insertChatMessage.run(info.lastInsertRowid, matchReq.reactor_id, matchReq.support_line);
          }
          return info.lastInsertRowid;
        });

        const matchId = doAccept();
        res.json({ ok: true, match_id: matchId });
      } else {
        wallStmts.declineRequest.run(request_id);
        res.json({ ok: true });
      }
    } catch (e) {
      console.error('Wall match-respond error:', e);
      res.status(500).json({ error: 'Failed to process response' });
    }
  });
}

module.exports = { registerWallRoutes };
