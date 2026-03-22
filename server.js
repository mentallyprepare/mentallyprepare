// ═══════════════════════════════════════
// MENTALLY PREPARE — Backend Server v2
// SQLite · Push Notifications · Razorpay · Stripe
// ═══════════════════════════════════════
const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const webpush = require('web-push');

const app = express();
app.set('trust proxy', 1); // Trust Railway/Heroku/Vercel proxy for correct IP handling
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ─── SQLite Database ────────────────────
const DB_PATH = path.join(__dirname, 'mentally-prepare.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ─────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    college TEXT NOT NULL,
    year TEXT DEFAULT '3rd',
    gender TEXT DEFAULT 'prefer_not_to_say',
    match_gender_pref TEXT DEFAULT 'any',
    match_year_pref TEXT DEFAULT 'any',
    archetype TEXT,
    scores TEXT,
    consent_given INTEGER DEFAULT 0,
    consent_date TEXT,
    consent_withdrawn_at TEXT,
    last_active_date TEXT,
    switch_count INTEGER DEFAULT 0,
    push_subscription TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id INTEGER NOT NULL REFERENCES users(id),
    user2_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER NOT NULL REFERENCES matches(id),
    day INTEGER NOT NULL,
    text TEXT NOT NULL,
    mood TEXT DEFAULT '🌓',
    prompt TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, match_id, day)
  );

  CREATE TABLE IF NOT EXISTS reveals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    choice TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(match_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER NOT NULL REFERENCES matches(id),
    day INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE(user_id, match_id, day)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id),
    day INTEGER DEFAULT 0,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deletion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anonymised_id TEXT NOT NULL,
    deleted_at TEXT DEFAULT (datetime('now')),
    reason TEXT DEFAULT 'user_requested'
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    provider_payment_id TEXT,
    provider_order_id TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    product TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    college TEXT NOT NULL,
    year TEXT,
    archetype TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id);
  CREATE INDEX IF NOT EXISTS idx_entries_match ON entries(match_id);
  CREATE INDEX IF NOT EXISTS idx_matches_user1 ON matches(user1_id);
  CREATE INDEX IF NOT EXISTS idx_matches_user2 ON matches(user2_id);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_archetype ON users(archetype);
  CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);
`);

// ─── Migrate from data.json if it exists ─
(function migrateFromJson() {
  const jsonPath = path.join(__dirname, 'data.json');
  if (!fs.existsSync(jsonPath)) return;

  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) {
    console.log('  ✓ SQLite already has data, skipping JSON migration');
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log('  ⟳ Migrating data.json → SQLite...');

    const insertUser = db.prepare(`
      INSERT INTO users (id, name, email, password, college, year, gender, match_gender_pref, match_year_pref, archetype, scores, consent_given, consent_date, last_active_date, switch_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMatch = db.prepare('INSERT INTO matches (id, user1_id, user2_id, started_at) VALUES (?, ?, ?, ?)');
    const insertEntry = db.prepare('INSERT INTO entries (id, user_id, match_id, day, text, mood, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertReveal = db.prepare('INSERT INTO reveals (id, match_id, user_id, choice, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertComment = db.prepare('INSERT INTO comments (id, user_id, match_id, day, text, created_at) VALUES (?, ?, ?, ?, ?, ?)');

    const migrate = db.transaction(() => {
      for (const u of (data.users || [])) {
        insertUser.run(
          u.id, u.name, u.email, u.password, u.college, u.year || '3rd',
          u.gender || 'prefer_not_to_say', u.matchGenderPref || 'any', u.matchYearPref || 'any',
          u.archetype, u.scores ? JSON.stringify(u.scores) : null,
          u.consentGiven ? 1 : 0, u.consentDate || null,
          u.lastActiveDate || u.created_at, u.switchCount || 0, u.created_at
        );
      }
      for (const m of (data.matches || [])) {
        insertMatch.run(m.id, m.user1_id, m.user2_id, m.started_at);
      }
      for (const e of (data.entries || [])) {
        insertEntry.run(e.id, e.user_id, e.match_id, e.day, e.text, e.mood, e.prompt, e.created_at);
      }
      for (const r of (data.reveals || [])) {
        insertReveal.run(r.id, r.match_id, r.user_id, r.choice, r.created_at);
      }
      for (const c of (data.comments || [])) {
        insertComment.run(c.id, c.user_id, c.match_id, c.day, c.text, c.created_at);
      }
    });
    migrate();

    // Rename old file so it doesn't re-migrate
    fs.renameSync(jsonPath, jsonPath + '.migrated');
    console.log('  ✓ Migration complete! data.json → data.json.migrated');
  } catch (e) {
    console.error('  ✗ Migration failed:', e.message);
  }
})();

// ─── Prepared Statements ────────────────
const stmts = {
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (name, email, password, college, year, gender, match_gender_pref, match_year_pref, consent_given, consent_date, last_active_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateUserScan: db.prepare('UPDATE users SET archetype = ?, scores = ? WHERE id = ?'),
  updateUserActivity: db.prepare('UPDATE users SET last_active_date = ? WHERE id = ?'),
  updateUserPassword: db.prepare('UPDATE users SET password = ? WHERE id = ?'),
  updateUserConsent: db.prepare('UPDATE users SET consent_given = ?, consent_withdrawn_at = ? WHERE id = ?'),
  updateUserSwitch: db.prepare('UPDATE users SET switch_count = ? WHERE id = ?'),
  updatePushSub: db.prepare('UPDATE users SET push_subscription = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

  getMatch: db.prepare('SELECT * FROM matches WHERE user1_id = ? OR user2_id = ?'),
  insertMatch: db.prepare('INSERT INTO matches (user1_id, user2_id) VALUES (?, ?)'),
  deleteMatch: db.prepare('DELETE FROM matches WHERE id = ?'),
  updateMatchStart: db.prepare('UPDATE matches SET started_at = ? WHERE id = ?'),

  findCandidates: db.prepare(`
    SELECT * FROM users
    WHERE archetype = ?
      AND LOWER(college) != LOWER(?)
      AND id != ?
      AND id NOT IN (SELECT user1_id FROM matches UNION SELECT user2_id FROM matches)
  `),

  getEntries: db.prepare('SELECT * FROM entries WHERE user_id = ? AND match_id = ? ORDER BY day DESC'),
  getPartnerEntries: db.prepare('SELECT * FROM entries WHERE user_id = ? AND match_id = ? AND day < ? ORDER BY day DESC'),
  getEntry: db.prepare('SELECT * FROM entries WHERE user_id = ? AND match_id = ? AND day = ?'),
  upsertEntry: db.prepare(`
    INSERT INTO entries (user_id, match_id, day, text, mood, prompt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, match_id, day) DO UPDATE SET text = excluded.text, mood = excluded.mood
  `),
  deleteUserEntries: db.prepare('DELETE FROM entries WHERE user_id = ?'),

  getReveal: db.prepare('SELECT * FROM reveals WHERE match_id = ? AND user_id = ?'),
  upsertReveal: db.prepare(`
    INSERT INTO reveals (match_id, user_id, choice)
    VALUES (?, ?, ?)
    ON CONFLICT(match_id, user_id) DO UPDATE SET choice = excluded.choice
  `),
  deleteUserReveals: db.prepare('DELETE FROM reveals WHERE user_id = ?'),

  getComments: db.prepare('SELECT * FROM comments WHERE match_id = ? AND (user_id = ? OR user_id = ?)'),
  getComment: db.prepare('SELECT * FROM comments WHERE user_id = ? AND match_id = ? AND day = ?'),
  upsertComment: db.prepare(`
    INSERT INTO comments (user_id, match_id, day, text)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id, day) DO UPDATE SET text = excluded.text, updated_at = datetime('now')
  `),
  deleteUserComments: db.prepare('DELETE FROM comments WHERE user_id = ?'),
  deleteMatchComments: db.prepare('DELETE FROM comments WHERE match_id = ?'),

  insertReport: db.prepare("INSERT INTO reports (reporter_id, day, reason, created_at) VALUES (?, ?, ?, datetime('now'))"),
  deleteUserReports: db.prepare('DELETE FROM reports WHERE reporter_id = ?'),
  deleteReportById: db.prepare('DELETE FROM reports WHERE id = ?'),

  deleteUserMatches: db.prepare('DELETE FROM matches WHERE user1_id = ? OR user2_id = ?'),
  deleteMatchEntries: db.prepare('DELETE FROM entries WHERE match_id = ?'),
  deleteMatchReveals: db.prepare('DELETE FROM reveals WHERE match_id = ?'),
  deleteMatchById: db.prepare('DELETE FROM matches WHERE id = ?'),
  deleteUserPayments: db.prepare('DELETE FROM payments WHERE user_id = ?'),

  insertDeletionLog: db.prepare('INSERT INTO deletion_log (anonymised_id, reason) VALUES (?, ?)'),

  insertPayment: db.prepare('INSERT INTO payments (user_id, provider, provider_order_id, amount, currency, product, status) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updatePayment: db.prepare('UPDATE payments SET provider_payment_id = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?'),
  getPayment: db.prepare('SELECT * FROM payments WHERE id = ?'),
  getPaymentByOrder: db.prepare('SELECT * FROM payments WHERE provider_order_id = ?'),
  getUserPayments: db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC'),

  getAllPushUsers: db.prepare('SELECT id, push_subscription FROM users WHERE push_subscription IS NOT NULL'),
  getActiveMatchUsers: db.prepare(`
    SELECT u.id, u.push_subscription, m.started_at, m.id as match_id
    FROM users u
    JOIN matches m ON (m.user1_id = u.id OR m.user2_id = u.id)
    WHERE u.push_subscription IS NOT NULL
  `),
};

// ─── Helper: parse scores JSON ──────────
function parseUser(row) {
  if (!row) return null;
  return { ...row, scores: row.scores ? JSON.parse(row.scores) : null };
}

// ─── Middleware ──────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://api.razorpay.com", "https://lumberjack-cx.razorpay.com"],
      imgSrc: ["'self'", "data:"],
      frameSrc: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '16kb' }));

// Serve app.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Persist session secret
const SESSION_SECRET_PATH = path.join(__dirname, '.session-secret');
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    if (fs.existsSync(SESSION_SECRET_PATH)) return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SESSION_SECRET_PATH, secret);
  return secret;
}

app.use(session({
  store: new SQLiteStore({
    db: 'mentally-prepare.db',
    dir: __dirname
  }),
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

// ─── HTTPS redirect (production) ────────
if (IS_PROD) {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      return res.redirect('https://' + req.header('host') + req.url);
    }
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ─── Rate Limiters ──────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

// ─── Prompts ────────────────────────────
const prompts = [
  '"What\'s one thing you wish someone would just ask you about?"',
  '"What did you hide today because it felt too small to explain?"',
  '"When do you become distant, even when you want closeness?"',
  '"What are you tired of carrying alone?"',
  '"Where do you make yourself smaller to stay accepted?"',
  '"What truth would you write if nobody judged it?"',
  '"What moment made you feel seen, even a little?"',
  '"What does emotional effort look like to you?"',
  '"What kind of connection are you ready for now?"',
  '"What\'s the last thing that genuinely moved you?"',
  '"If you could say one honest thing to someone you\'ve lost touch with, what would it be?"',
  '"What are you pretending isn\'t affecting you?"',
  '"When was the last time you let someone see the real version of you?"',
  '"What part of yourself do you think people misread?"',
  '"What would it look like if you stopped performing?"',
  '"What scares you about being known?"',
  '"If your loneliness had a shape, what would it look like?"',
  '"What\'s one boundary you need but can\'t set?"',
  '"What is the thing you most want someone to understand about you?"',
  '"Write a letter to the person you\'ll meet on Day 21."',
  '"Would you like to know who has been writing to you?"'
];

// ─── Safety Keywords ────────────────────
const SAFETY_KEYWORDS = [
  'suicide','kill myself','end my life','want to die','self harm','self-harm',
  'cutting myself','overdose','no reason to live','can\'t go on',
  'hurt myself','ending it all','take my life','not worth living'
];

const CONTENT_FLAGS = [
  'instagram','snapchat','whatsapp','phone number','@gmail','@yahoo',
  'my number is','call me at','dm me','follow me'
];

const HELPLINES = {
  iCall: '9152987821',
  vandrevala: '1860-2662-345',
  nimhans: '080-46110007'
};

function scanForSafety(text) {
  const lower = text.toLowerCase();
  const crisis = SAFETY_KEYWORDS.some(kw => lower.includes(kw));
  let pii = CONTENT_FLAGS.some(kw => lower.includes(kw));
  // Regex for Indian phone numbers (10 digits, with or without spaces/dashes)
  const phoneRegex = /(?:\+91[- ]?)?(?:[6-9][0-9]{9})|(?:[0-9]{3}[- ]?[0-9]{3}[- ]?[0-9]{4})/g;
  if (phoneRegex.test(text)) pii = true;

  // Regex for common social media handles/links
  const socialRegexes = [
    /(?:instagram|ig)\s*[:@]?\s*([a-zA-Z0-9_.]{3,})/i,
    /(?:snapchat|sc)\s*[:@]?\s*([a-zA-Z0-9_.]{3,})/i,
    /(?:whatsapp|wa)\s*[:@]?\s*([0-9]{10,})/i,
    /(?:facebook|fb)\s*[:@]?\s*([a-zA-Z0-9_.]{3,})/i,
    /(?:twitter|x)\s*[:@]?\s*([a-zA-Z0-9_.]{3,})/i,
    /(?:@)[a-zA-Z0-9_.]{3,}/, // generic @handle
    /(?:t\.me|telegram)\s*[:@]?\s*([a-zA-Z0-9_]{3,})/i,
    /(?:linkedin)\s*[:@]?\s*([a-zA-Z0-9_.-]{3,})/i,
    /(?:youtube|yt)\s*[:@]?\s*([a-zA-Z0-9_.-]{3,})/i,
    /(?:facebook\.com|instagram\.com|twitter\.com|linkedin\.com|t\.me|wa\.me|youtube\.com|snapchat\.com|fb\.com|x\.com)\/[a-zA-Z0-9_.-]+/i
  ];
  if (socialRegexes.some(r => r.test(text))) pii = true;
  return { crisis, pii };
}

// ─── Emotional Theme Detection ──────────
const EMOTIONAL_THEMES = {
  isolation: {
    keywords: ['alone','lonely','isolated','nobody','no one','invisible','ignored','forgotten','empty','hollow','left out'],
    prompts: [
      '"What does your loneliness feel like when it\'s at its loudest?"',
      '"If loneliness were a room, what would yours look like?"',
      '"Who was the last person who made you feel less alone — and what exactly did they do?"'
    ]
  },
  family: {
    keywords: ['mom','dad','mother','father','parents','family','sibling','brother','sister','home','childhood'],
    prompts: [
      '"What\'s one conversation with your family you keep replaying?"',
      '"What did your parents teach you about emotions — without saying a word?"',
      '"If you could rewrite one rule from how you grew up, what would it be?"'
    ]
  },
  self_worth: {
    keywords: ['not good enough','worthless','failure','imposter','fake','pretend','doubt myself','not enough','inadequate','deserve'],
    prompts: [
      '"Where did you first learn that you weren\'t enough?"',
      '"What would change if you believed you deserved the good things?"',
      '"Write about a moment you were genuinely proud of yourself — even if you never told anyone."'
    ]
  },
  fear: {
    keywords: ['scared','afraid','fear','anxious','panic','worry','terrified','nervous','dread','overwhelm'],
    prompts: [
      '"What\'s the fear behind the fear — the deeper one you don\'t usually name?"',
      '"If your anxiety could speak honestly, what would it say it\'s trying to protect you from?"',
      '"What would you do tomorrow if fear wasn\'t a factor?"'
    ]
  },
  hope: {
    keywords: ['hope','better','dream','someday','future','wish','imagine','possible','light','grateful','thankful'],
    prompts: [
      '"What small thing is quietly giving you hope right now?"',
      '"Write about the version of yourself you\'re slowly becoming."',
      '"What\'s one thing you\'re learning to trust again?"'
    ]
  },
  anger: {
    keywords: ['angry','frustrated','rage','unfair','hate','furious','tired of','sick of','fed up','resentment'],
    prompts: [
      '"What are you angry about that you haven\'t let yourself fully feel yet?"',
      '"What boundary would your anger set if you actually listened to it?"',
      '"Behind your frustration — what do you actually need?"'
    ]
  },
  grief: {
    keywords: ['miss','lost','gone','grief','mourning','death','passed away','used to be','remember when','nostalgia'],
    prompts: [
      '"What are you grieving that nobody around you sees?"',
      '"Write about something you lost that changed who you are."',
      '"If you could have one more conversation with someone you\'ve lost, what would you say?"'
    ]
  },
  connection: {
    keywords: ['friend','close','trust','open up','vulnerable','bond','deep','understand','listen','seen','heard'],
    prompts: [
      '"What makes someone safe enough to be real with?"',
      '"Describe a moment where you felt truly heard — what made it different?"',
      '"What\'s the kindest thing someone could do for you right now without you having to ask?"'
    ]
  },
  pressure: {
    keywords: ['pressure','expectations','perfect','grades','career','perform','compete','comparison','achievement','success','burnout'],
    prompts: [
      '"Whose voice is loudest when you feel like you\'re not doing enough?"',
      '"What would rest actually look like if you gave yourself permission?"',
      '"What if being ordinary was allowed — what would you do differently?"'
    ]
  }
};

function detectThemes(entries) {
  const themeCounts = {};
  const recentEntries = entries.slice(0, 3);
  const combinedText = recentEntries.map(e => e.text).join(' ').toLowerCase();

  for (const [theme, config] of Object.entries(EMOTIONAL_THEMES)) {
    const count = config.keywords.reduce((sum, kw) => {
      const regex = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      const matches = combinedText.match(regex);
      return sum + (matches ? matches.length : 0);
    }, 0);
    if (count > 0) themeCounts[theme] = count;
  }

  return Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([theme]) => theme);
}

function getAdaptivePrompt(entries, day) {
  if (entries.length < 2) return null;
  const themes = detectThemes(entries);
  if (themes.length === 0) return null;
  const topTheme = themes[0];
  const themeConfig = EMOTIONAL_THEMES[topTheme];
  const promptIdx = (day + topTheme.length) % themeConfig.prompts.length;
  return { prompt: themeConfig.prompts[promptIdx], theme: topTheme, label: topTheme.replace('_', ' ') };
}

function getMoodInsights(entries) {
  if (entries.length < 3) return null;
  const moodMap = { '🌑': 1, '🌒': 2, '🌓': 3, '🌔': 4, '🌕': 5 };
  const moodLabels = { '🌑': 'Heavy', '🌒': 'Quiet', '🌓': 'Okay', '🌔': 'Lighter', '🌕': 'Good' };

  const moodTrend = entries.slice().sort((a, b) => a.day - b.day)
    .map(e => ({ day: e.day, mood: e.mood, value: moodMap[e.mood] || 3 }));

  const counts = {};
  entries.forEach(e => { counts[e.mood] = (counts[e.mood] || 0) + 1; });
  const dominantMood = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const recent = moodTrend.slice(-3);
  const earlier = moodTrend.slice(0, 3);
  const recentAvg = recent.reduce((s, m) => s + m.value, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, m) => s + m.value, 0) / earlier.length;
  const trend = recentAvg > earlierAvg + 0.3 ? 'rising' : recentAvg < earlierAvg - 0.3 ? 'dipping' : 'steady';

  const totalWords = entries.reduce((sum, e) => sum + (e.text ? e.text.trim().split(/\s+/).length : 0), 0);

  return {
    moodTrend, dominantMood,
    dominantLabel: moodLabels[dominantMood] || 'Okay',
    trend, totalWords,
    avgWords: Math.round(totalWords / entries.length),
    uniqueMoods: Object.keys(counts).length
  };
}

// ─── Matching ───────────────────────────
const complementary = {
  protector: 'connector', connector: 'protector',
  performer: 'disconnector', disconnector: 'performer'
};

function attemptMatch(userId) {
  const user = parseUser(stmts.getUserById.get(userId));
  if (!user || !user.archetype) return null;
  const targetType = complementary[user.archetype];
  if (!targetType) return null;

  let candidates = stmts.findCandidates.all(targetType, user.college, userId).map(parseUser);

  // Gender preference filtering
  if (user.match_gender_pref && user.match_gender_pref !== 'any') {
    const filtered = candidates.filter(c => c.gender === user.match_gender_pref);
    if (filtered.length > 0) candidates = filtered;
  }
  candidates = candidates.filter(c => {
    if (!c.match_gender_pref || c.match_gender_pref === 'any') return true;
    return c.match_gender_pref === user.gender;
  });

  // Year preference filtering (soft)
  if (user.match_year_pref && user.match_year_pref !== 'any') {
    const yearNums = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '5th+': 5 };
    let yearFiltered;
    if (user.match_year_pref === '±1_year' || user.match_year_pref === 'nearby') {
      const userYearNum = yearNums[user.year] || 3;
      yearFiltered = candidates.filter(c => Math.abs((yearNums[c.year] || 3) - userYearNum) <= 1);
    } else {
      yearFiltered = candidates.filter(c => c.year === user.match_year_pref);
    }
    if (yearFiltered.length > 0) candidates = yearFiltered;
  }

  const partner = candidates[0] || null;
  if (partner) {
    const result = stmts.insertMatch.run(userId, partner.id);
    return result.lastInsertRowid;
  }
  return null;
}

function getMatchDay(startedAt) {
  const started = new Date(startedAt);
  const now = new Date();
  const startDay = Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), started.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.min(Math.max(Math.floor((today - startDay) / 86400000) + 1, 1), 21);
}

function findUserByIdentifier(identifier) {
  if (identifier === undefined || identifier === null) return null;
  const raw = String(identifier).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseUser(stmts.getUserById.get(Number(raw)));
  return parseUser(stmts.getUserByEmail.get(raw.toLowerCase()));
}

function deleteMatchData(matchId) {
  stmts.deleteMatchEntries.run(matchId);
  stmts.deleteMatchComments.run(matchId);
  stmts.deleteMatchReveals.run(matchId);
  stmts.deleteMatchById.run(matchId);
}

const deleteUserDataTx = db.transaction((userId, reason = 'admin_removed') => {
  const matches = db.prepare('SELECT id FROM matches WHERE user1_id = ? OR user2_id = ?').all(userId, userId);
  for (const match of matches) deleteMatchData(match.id);
  stmts.insertDeletionLog.run(
    crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16),
    reason
  );
  stmts.deleteUserEntries.run(userId);
  stmts.deleteUserReveals.run(userId);
  stmts.deleteUserComments.run(userId);
  stmts.deleteUserReports.run(userId);
  stmts.deleteUserPayments.run(userId);
  stmts.deleteUser.run(userId);
});

function getPartnerId(match, userId) {
  return match.user1_id === userId ? match.user2_id : match.user1_id;
}

// ─── Web Push Setup ─────────────────────
const VAPID_PATH = path.join(__dirname, '.vapid-keys.json');
let vapidKeys;
try {
  if (fs.existsSync(VAPID_PATH)) {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2));
    console.log('  ✓ Generated VAPID keys');
  }
  webpush.setVapidDetails(
    'mailto:' + (process.env.CONTACT_EMAIL || 'hello@mentallyprepare.in'),
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
} catch (e) {
  console.error('  ✗ VAPID setup failed:', e.message);
}

// ─── Razorpay Setup ─────────────────────
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  console.log('  ✓ Razorpay configured');
}

// ─── Stripe Setup ───────────────────────
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('  ✓ Stripe configured');
}

// ═══════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password, college, year, gender, matchGenderPref, matchYearPref, consentGiven } = req.body;
    if (!name || !name.trim() || !email || !email.trim() || !password || !college || !college.trim()) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (!consentGiven) {
      return res.status(400).json({ error: 'You must accept the Privacy Policy to register' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const emailClean = email.toLowerCase().trim();
    const existing = stmts.getUserByEmail.get(emailClean);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });

    const hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const result = stmts.insertUser.run(
      name.trim(), emailClean, hash, college.trim(), year || '3rd',
      gender || 'prefer_not_to_say', matchGenderPref || 'any', matchYearPref || 'any',
      1, now, now
    );

    req.session.userId = Number(result.lastInsertRowid);
    res.json({ ok: true });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = stmts.getUserByEmail.get(email.toLowerCase().trim());
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ═══════════════════════════════════════
// STATE ROUTE
// ═══════════════════════════════════════
app.get('/api/me', apiLimiter, requireAuth, (req, res) => {
  try {
    const userId = req.session.userId;
    const rawUser = stmts.getUserById.get(userId);
    if (!rawUser) return res.status(404).json({ error: 'User not found' });
    const user = parseUser(rawUser);

    const safeUser = { id: user.id, name: user.name, email: user.email, college: user.college, year: user.year, archetype: user.archetype, scores: user.scores };

    const match = stmts.getMatch.get(userId, userId);
    let matchData = null, entriesData = [], partnerEntries = [], streak = 0, revealData = null, comments = [];

    if (match) {
      const partnerId = getPartnerId(match, userId);
      const day = getMatchDay(match.started_at);
      const partner = parseUser(stmts.getUserById.get(partnerId));

      matchData = {
        id: match.id, day,
        currentPrompt: prompts[(day - 1) % prompts.length],
        partner: partner ? { archetype: partner.archetype, scores: partner.scores } : null,
        startedAt: match.started_at
      };

      entriesData = stmts.getEntries.all(userId, match.id)
        .map(e => ({ day: e.day, text: e.text, mood: e.mood, prompt: e.prompt, created_at: e.created_at }));

      partnerEntries = stmts.getPartnerEntries.all(partnerId, match.id, day)
        .map(e => ({ day: e.day, text: e.text, mood: e.mood }));

      // Comments
      const allComments = stmts.getComments.all(match.id, userId, partnerId);
      comments = allComments.map(c => ({
        day: c.day, text: c.text,
        from: c.user_id === userId ? 'me' : 'partner',
        created_at: c.created_at
      }));

      // Streak
      const entryDays = new Set(entriesData.map(e => e.day));
      if (entryDays.has(day)) streak++;
      for (let d = day - 1; d >= 1; d--) {
        if (entryDays.has(d)) streak++; else break;
      }

      // Reveal
      if (day >= 21) {
        const myReveal = stmts.getReveal.get(match.id, userId);
        const partnerReveal = stmts.getReveal.get(match.id, partnerId);
        const bothYes = myReveal && myReveal.choice === 'yes' && partnerReveal && partnerReveal.choice === 'yes';
        const eitherNo = (myReveal && myReveal.choice === 'no') || (partnerReveal && partnerReveal.choice === 'no');

        revealData = {
          available: true,
          myChoice: myReveal ? myReveal.choice : null,
          partnerChose: !!partnerReveal,
          revealed: bothYes,
          anonymous: eitherNo,
          partner: bothYes && partner ? { name: partner.name, college: partner.college, year: partner.year } : null
        };
      }
    }

    // Adaptive prompt
    let adaptivePrompt = null;
    if (match && entriesData.length >= 2) {
      const day = getMatchDay(match.started_at);
      adaptivePrompt = getAdaptivePrompt(entriesData, day);
    }

    // Mood insights
    const insights = entriesData.length >= 3 ? getMoodInsights(entriesData) : null;

    res.json({ user: safeUser, match: matchData, entries: entriesData, partnerEntries, streak, reveal: revealData, comments, adaptivePrompt, insights });
  } catch (e) {
    console.error('State error:', e);
    res.status(500).json({ error: 'Failed to load state' });
  }
});

// ═══════════════════════════════════════
// SCAN ROUTE
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// ENTRY ROUTE
// ═══════════════════════════════════════
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
    stmts.upsertEntry.run(userId, match.id, day, text.trim(), mood || '🌓', prompt);

    res.json({ ok: true, day, safety: { crisis: safety.crisis, pii: safety.pii, helplines: safety.crisis ? HELPLINES : null } });
  } catch (e) {
    console.error('Entry error:', e);
    res.status(500).json({ error: 'Failed to save entry' });
  }
});

// ═══════════════════════════════════════
// PARTNER STATUS
// ═══════════════════════════════════════
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
      hasPartner: true, daysSinceActive, partnerEntryCount,
      canSwitch: daysSinceActive >= 5,
      status: daysSinceActive === 0 ? 'active' : daysSinceActive <= 2 ? 'recent' : daysSinceActive <= 4 ? 'inactive' : 'dormant'
    });
  } catch (e) {
    console.error('Partner status error:', e);
    res.status(500).json({ error: 'Failed to check partner status' });
  }
});

// ═══════════════════════════════════════
// SWITCH PARTNER
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// COMMENTS
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// REPORT
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// REVEAL
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// DEV TOOLS (blocked in production)
// ═══════════════════════════════════════
function requireDev(req, res, next) {
  if (IS_PROD) return res.status(404).json({ error: 'Not found' });
  next();
}

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
        'Priya Sharma', 'test-' + Date.now() + '@test.com', hash,
        'Miranda House, Delhi', '3rd', 'prefer_not_to_say', 'any', 'any',
        targetType, JSON.stringify({ openness: 70, awareness: 65, guard: 75, reciprocity: 60 }), now
      );
      const partnerId = Number(partnerResult.lastInsertRowid);
      stmts.insertMatch.run(userId, partnerId);
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

    const d = new Date(); d.setDate(d.getDate() - 21);
    stmts.updateMatchStart.run(d.toISOString(), match.id);

    const partnerId = getPartnerId(match, userId);
    const fakeTexts = [
      'I keep wondering who you are.', 'Today was hard.', 'I think about what you wrote.',
      'Some days I don\'t know what to say.', 'You make me think differently.',
      'Loneliness isn\'t about being alone.', 'Tonight I almost didn\'t write.',
      'The prompt made me think of something.', 'I feel like I know you.',
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
    stmts.upsertReveal.run(match.id, partnerId, 'yes');
    res.json({ ok: true });
  } catch (e) {
    console.error('Dev reveal error:', e);
    res.status(500).json({ error: 'Partner reveal failed' });
  }
});

// ═══════════════════════════════════════
// PASSWORD RESET
// ═══════════════════════════════════════
const resetTokens = new Map();

app.post('/api/forgot-password', authLimiter, (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = stmts.getUserByEmail.get(email.toLowerCase().trim());
    if (!user) return res.json({ ok: true, message: 'If that email exists, a reset code has been generated.' });

    const token = crypto.randomBytes(32).toString('hex');
    resetTokens.set(token, { userId: user.id, expires: Date.now() + 15 * 60 * 1000 });
    console.log(`  ✉ Password reset token for ${user.email}: ${token}`);
    res.json({ ok: true, message: 'If that email exists, a reset link has been generated.' });
  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  try {
    const { code, newPassword } = req.body;
    const token = code;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const entry = resetTokens.get(token);
    if (!entry || entry.expires < Date.now()) {
      if (token) resetTokens.delete(token);
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = stmts.getUserById.get(entry.userId);
    if (!user) return res.status(400).json({ error: 'User not found' });

    const hash = await bcrypt.hash(newPassword, 12);
    stmts.updateUserPassword.run(hash, user.id);
    resetTokens.delete(token);
    res.json({ ok: true });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ═══════════════════════════════════════
// DATA EXPORT
// ═══════════════════════════════════════
app.get('/api/my-data', apiLimiter, requireAuth, (req, res) => {
  try {
    const userId = req.session.userId;
    const user = parseUser(stmts.getUserById.get(userId));
    if (!user) return res.status(404).json({ error: 'User not found' });

    const match = stmts.getMatch.get(userId, userId);
    const myEntries = db.prepare('SELECT day, prompt, text, mood, created_at FROM entries WHERE user_id = ?').all(userId)
      .map(e => ({ day: e.day, prompt: e.prompt, text: e.text, mood: e.mood, written_at: e.created_at }));
    const myReveals = db.prepare('SELECT match_id, choice, created_at FROM reveals WHERE user_id = ?').all(userId)
      .map(r => ({ match_id: r.match_id, choice: r.choice, decided_at: r.created_at }));
    const myComments = db.prepare('SELECT day, text, created_at FROM comments WHERE user_id = ?').all(userId)
      .map(c => ({ day: c.day, text: c.text, written_at: c.created_at }));

    const exportData = {
      exported_at: new Date().toISOString(),
      notice: 'This is all personal data Mentally Prepare holds about you. Partner details are excluded to protect their privacy.',
      profile: {
        name: user.name, email: user.email, college: user.college, year: user.year,
        gender: user.gender, matchGenderPref: user.match_gender_pref, matchYearPref: user.match_year_pref,
        archetype: user.archetype, scores: user.scores,
        consentGiven: !!user.consent_given, consentDate: user.consent_date,
        accountCreated: user.created_at, lastActive: user.last_active_date
      },
      match: match ? { status: 'active', dayCount: getMatchDay(match.started_at) } : null,
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

// ═══════════════════════════════════════
// ACCOUNT DELETION
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// CONSENT
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════
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

// Daily push notification cron (call via external cron or setInterval)
function sendDailyReminders() {
  if (!vapidKeys) return;
  const rows = stmts.getActiveMatchUsers.all();
  let sent = 0, failed = 0;

  for (const row of rows) {
    if (!row.push_subscription) continue;
    const day = getMatchDay(row.started_at);
    if (day > 21) continue;

    try {
      const sub = JSON.parse(row.push_subscription);
      const payload = JSON.stringify({
        title: 'Your prompt is waiting ✦',
        body: `Day ${day} of 21 — take 5 minutes to be honest.`,
        url: '/app'
      });
      webpush.sendNotification(sub, payload).then(() => { sent++; }).catch(err => {
        failed++;
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired, clean up
          stmts.updatePushSub.run(null, row.id);
        }
      });
    } catch { failed++; }
  }
  console.log(`  📬 Daily reminders: ${sent} sent, ${failed} failed`);
}

// Run daily at 8pm IST (14:30 UTC)
function scheduleDailyPush() {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(14, 30, 0, 0); // 8:00 PM IST
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - now.getTime();

  setTimeout(() => {
    sendDailyReminders();
    setInterval(sendDailyReminders, 24 * 60 * 60 * 1000);
  }, delay);

  console.log(`  ⏰ Daily push scheduled for 8:00 PM IST (in ${Math.round(delay / 60000)} min)`);
}
scheduleDailyPush();

// ═══════════════════════════════════════
// RAZORPAY (India payments)
// ═══════════════════════════════════════
app.post('/api/pay/razorpay/create', apiLimiter, requireAuth, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });

    const { product } = req.body;
    const products = {
      'archetype-pdf': { amount: 99900, name: 'Connection Profile PDF', currency: 'INR' },
      'second-cycle': { amount: 49900, name: 'Second 21-Day Cycle', currency: 'INR' }
    };
    const p = products[product];
    if (!p) return res.status(400).json({ error: 'Invalid product' });

    const order = await razorpay.orders.create({
      amount: p.amount,
      currency: p.currency,
      receipt: 'mp_' + Date.now(),
      notes: { product, userId: String(req.session.userId) }
    });

    const result = stmts.insertPayment.run(req.session.userId, 'razorpay', order.id, p.amount, p.currency, product, 'created');

    res.json({
      orderId: order.id,
      amount: p.amount,
      currency: p.currency,
      name: p.name,
      keyId: process.env.RAZORPAY_KEY_ID,
      paymentId: Number(result.lastInsertRowid)
    });
  } catch (e) {
    console.error('Razorpay create error:', e);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.post('/api/pay/razorpay/verify', apiLimiter, requireAuth, (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    // Verify signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Update payment record
    const payment = stmts.getPaymentByOrder.get(razorpay_order_id);
    if (payment) {
      stmts.updatePayment.run(razorpay_payment_id, 'paid', payment.id);
    }

    res.json({ ok: true, verified: true });
  } catch (e) {
    console.error('Razorpay verify error:', e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ═══════════════════════════════════════
// STRIPE (International payments)
// ═══════════════════════════════════════
app.post('/api/pay/stripe/create', apiLimiter, requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });

    const { product } = req.body;
    const products = {
      'archetype-pdf': { amount: 1200, name: 'Connection Profile PDF', currency: 'usd' },
      'second-cycle': { amount: 600, name: 'Second 21-Day Cycle', currency: 'usd' }
    };
    const p = products[product];
    if (!p) return res.status(400).json({ error: 'Invalid product' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: p.currency,
          product_data: { name: p.name, description: 'Mentally Prepare — ' + p.name },
          unit_amount: p.amount
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: req.header('origin') + '/app?payment=success',
      cancel_url: req.header('origin') + '/app?payment=cancelled',
      metadata: { product, userId: String(req.session.userId) }
    });

    const result = stmts.insertPayment.run(req.session.userId, 'stripe', session.id, p.amount, p.currency, product, 'created');

    res.json({ url: session.url, paymentId: Number(result.lastInsertRowid) });
  } catch (e) {
    console.error('Stripe create error:', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook (must use raw body)
app.post('/api/pay/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send();

    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send('Webhook signature verification failed');
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const payment = stmts.getPaymentByOrder.get(session.id);
      if (payment) {
        stmts.updatePayment.run(session.payment_intent, 'paid', payment.id);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook error:', e);
    res.status(500).send();
  }
});

// Payment history
app.get('/api/pay/history', apiLimiter, requireAuth, (req, res) => {
  try {
    const payments = stmts.getUserPayments.all(req.session.userId)
      .map(p => ({ id: p.id, product: p.product, amount: p.amount, currency: p.currency, status: p.status, provider: p.provider, created_at: p.created_at }));
    res.json({ payments });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load payment history' });
  }
});

// ═══════════════════════════════════════
// HEALTH CHECK (for UptimeRobot etc.)
// ═══════════════════════════════════════
app.get('/api/health', (req, res) => {
  try {
    // Quick DB check
    const check = db.prepare('SELECT COUNT(*) as c FROM users').get();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      users: check.c,
      db: 'sqlite',
      env: process.env.NODE_ENV || 'development',
      version: '2.0.0'
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ═══════════════════════════════════════
// PRIVACY & STATIC ROUTES
// ═══════════════════════════════════════
// ═══════════════════════════════════════
// EMAIL REMINDER SIGNUP
// ═══════════════════════════════════════
const EMAILS_PATH = path.join(__dirname, 'daily-reminder-emails.txt');
app.post('/api/reminder-signup', apiLimiter, (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const emailClean = email.trim().toLowerCase();
    let emails = [];
    if (fs.existsSync(EMAILS_PATH)) {
      emails = fs.readFileSync(EMAILS_PATH, 'utf8').split('\n').map(e => e.trim()).filter(Boolean);
    }
    if (emails.includes(emailClean)) {
      return res.status(409).json({ error: 'Already signed up' });
    }
    fs.appendFileSync(EMAILS_PATH, emailClean + '\n');

    // Send welcome/daily reminder email immediately
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
      }
    });
    const subject = 'Mentally Prepare: Daily Reminder';
    const text = 'Welcome! You are now signed up to receive daily reminders to write your journal entry. Take 5 minutes today to write your first entry!';
    transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: emailClean,
      subject,
      text
    }, (err, info) => {
      if (err) {
        console.error('Failed to send welcome reminder to', emailClean, err);
      } else {
        console.log('Sent welcome reminder to', emailClean);
      }
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save email' });
  }
});

// ═══════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════
// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const pw = req.headers['x-admin-password'] || req.headers['x-admin-key'] || req.query.key;
  if (!adminPassword || !pw || pw !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function getAdminStats() {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeMatches = db.prepare('SELECT COUNT(*) as c FROM matches').get().c;
  const entriesToday = db.prepare(`
    SELECT COUNT(*) as c
    FROM entries
    WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')
  `).get().c;
  const openReports = db.prepare('SELECT COUNT(*) as c FROM reports').get().c;
  const reachedDay21 = db.prepare('SELECT started_at FROM matches').all()
    .filter(match => getMatchDay(match.started_at) >= 21).length;
  const bothRevealed = db.prepare(`
    SELECT COUNT(*) as c
    FROM (
      SELECT match_id
      FROM reveals
      WHERE choice = 'yes'
      GROUP BY match_id
      HAVING COUNT(*) = 2
    )
  `).get().c;

  const archetypeRows = db.prepare(`
    SELECT COALESCE(archetype, 'noscan') as archetype, COUNT(*) as count
    FROM users
    GROUP BY COALESCE(archetype, 'noscan')
  `).all();
  const archetypes = { protector: 0, connector: 0, performer: 0, disconnector: 0, noscan: 0 };
  for (const row of archetypeRows) {
    if (row.archetype in archetypes) archetypes[row.archetype] = row.count;
  }

  const waitingUsers = db.prepare(`
    SELECT u.id, u.name, u.email, u.college, u.year, u.archetype, u.created_at
    FROM users u
    LEFT JOIN matches m ON m.user1_id = u.id OR m.user2_id = u.id
    WHERE m.id IS NULL AND u.archetype IS NOT NULL
    ORDER BY u.created_at ASC
  `).all().map(user => ({
    ...user,
    waitDays: Math.max(Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000), 0)
  }));

  return {
    totalUsers,
    activeMatches,
    waitingForMatch: waitingUsers.length,
    entriesToday,
    reachedDay21,
    bothRevealed,
    openReports,
    archetypes,
    waitingUsers
  };
}

// Send announcement (POST /admin/announce)
app.post('/admin/announce', requireAdmin, express.json(), (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
  // TODO: Broadcast to users (push/email/etc). For now, just log.
  console.log('[ADMIN ANNOUNCEMENT]', message);
  res.json({ ok: true });
});

// Get recent reports (GET /admin/reports)
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
        EXISTS (
          SELECT 1 FROM matches m WHERE m.user1_id = u.id OR m.user2_id = u.id
        ) as has_match
      FROM users u
      ORDER BY u.created_at DESC
    `).all();
    res.json(rows.map(row => ({ ...row, has_match: !!row.has_match })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

app.get('/admin/stats', requireAdmin, (req, res) => {
  try {
    res.json(getAdminStats());
  } catch (e) {
    res.status(500).json({ error: 'Failed to load stats' });
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

app.post('/admin/manual-match', requireAdmin, express.json(), (req, res) => {
  try {
    const userA = findUserByIdentifier(req.body.user1_id);
    const userB = findUserByIdentifier(req.body.user2_id);
    if (!userA || !userB) return res.status(404).json({ error: 'Both users must exist' });
    if (userA.id === userB.id) return res.status(400).json({ error: 'Choose two different users' });
    if (!userA.archetype || !userB.archetype) return res.status(400).json({ error: 'Both users must complete the scan first' });
    if (userA.college.trim().toLowerCase() === userB.college.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Users must be from different colleges' });
    }
    if (complementary[userA.archetype] !== userB.archetype) {
      return res.status(400).json({ error: 'Archetypes are not complementary' });
    }
    if (stmts.getMatch.get(userA.id, userA.id) || stmts.getMatch.get(userB.id, userB.id)) {
      return res.status(400).json({ error: 'One or both users are already matched' });
    }
    const result = stmts.insertMatch.run(userA.id, userB.id);
    res.json({ ok: true, match_id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create manual match' });
  }
});

app.post('/admin/remove-user', requireAdmin, express.json(), (req, res) => {
  try {
    const user = findUserByIdentifier(req.body.user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    deleteUserDataTx(user.id, 'admin_removed');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

app.post('/admin/end-match', requireAdmin, express.json(), (req, res) => {
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

app.post('/admin/dismiss-report', requireAdmin, express.json(), (req, res) => {
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

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/waitlist', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'waitlist.html'));
});

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
    const college = String(req.body.college || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const year = String(req.body.year || '').trim();
    const archetype = req.body.archetype ? String(req.body.archetype).trim().toLowerCase() : null;

    if (!name || !email || !college) {
      return res.status(400).json({ error: 'Name, email and college are required' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email' });
    }

    const validArchetypes = ['protector', 'connector', 'performer', 'disconnector'];
    if (archetype && !validArchetypes.includes(archetype)) {
      return res.status(400).json({ error: 'Invalid archetype' });
    }

    const existing = db.prepare('SELECT id FROM waitlist WHERE email = ?').get(email);
    if (existing) {
      const position = db.prepare('SELECT COUNT(*) as c FROM waitlist WHERE id <= ?').get(existing.id).c;
      return res.json({ ok: true, position, alreadyExists: true });
    }

    const result = db.prepare(`
      INSERT INTO waitlist (name, email, college, year, archetype)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, email, college, year || '', archetype || '');
    const position = db.prepare('SELECT COUNT(*) as c FROM waitlist WHERE id <= ?').get(result.lastInsertRowid).c;
    console.log(`  ✦ Waitlist signup: ${name} from ${college} (#${position})`);
    res.json({ ok: true, position });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
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

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://mymentallyprepare.com';
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><priority>1.0</priority></url>
  <url><loc>${base}/waitlist</loc><priority>0.9</priority></url>
  <url><loc>${base}/privacy</loc><priority>0.5</priority></url>
  <url><loc>${base}/terms</loc><priority>0.5</priority></url>
</urlset>`);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nSitemap: https://mymentallyprepare.com/sitemap.xml');
});

// 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ═══════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════
function shutdown() {
  console.log('\n  Shutting down...');
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n  ✦ Mentally Prepare v2.0`);
  console.log(`  Database: SQLite (${DB_PATH})`);
  console.log(`  Environment: ${IS_PROD ? 'PRODUCTION' : 'development'}`);
  console.log(`  Razorpay: ${razorpay ? '✓' : '– skipped (no keys)'}`);
  console.log(`  Stripe: ${stripe ? '✓' : '– skipped (no keys)'}`);
  console.log(`  Push: ${vapidKeys ? '✓' : '– skipped'}`);
  console.log(`  Running on http://localhost:${PORT}\n`);
});
