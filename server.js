// ---------------------------------------
// MENTALLY PREPARE — Backend Server v2
// SQLite · Push Notifications · Razorpay · Stripe
// ---------------------------------------
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
const { BASE_URL } = require('./lib/config');
const { registerStaticRoutes } = require('./routes/static');
const { registerWaitlistRoutes } = require('./routes/waitlist');
const { registerAdminRoutes } = require('./routes/admin');
const { registerAuthRoutes } = require('./routes/auth');
const { registerAppRoutes } = require('./routes/app');
const { registerPaymentRoutes } = require('./routes/payments');

const app = express();
app.set('trust proxy', 1); // Trust Railway/Heroku/Vercel proxy for correct IP handling
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// --- SQLite Database --------------------
const DB_PATH = path.join(__dirname, 'mentally-prepare.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema -----------------------------
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
    mood TEXT DEFAULT '??',
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

// --- Migrate from data.json if it exists -
(function migrateFromJson() {
  const jsonPath = path.join(__dirname, 'data.json');
  if (!fs.existsSync(jsonPath)) return;

  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) {
    console.log('  ? SQLite already has data, skipping JSON migration');
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log('  ? Migrating data.json ? SQLite...');

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
    console.log('  ? Migration complete! data.json ? data.json.migrated');
  } catch (e) {
    console.error('  ? Migration failed:', e.message);
  }
})();

// --- Prepared Statements ----------------
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

// --- Helper: parse scores JSON ----------
function parseUser(row) {
  if (!row) return null;
  return { ...row, scores: row.scores ? JSON.parse(row.scores) : null };
}

// --- Middleware --------------------------
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

// --- HTTPS redirect (production) --------
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

// --- Rate Limiters ----------------------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

registerAuthRoutes(app, {
  authLimiter,
  bcrypt,
  crypto,
  stmts
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

// --- Prompts ----------------------------
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

// --- Safety Keywords --------------------
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

// --- Emotional Theme Detection ----------
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
  const moodMap = { '??': 1, '??': 2, '??': 3, '??': 4, '??': 5 };
  const moodLabels = { '??': 'Heavy', '??': 'Quiet', '??': 'Okay', '??': 'Lighter', '??': 'Good' };

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

// --- Matching ---------------------------
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

// --- Web Push Setup ---------------------
const VAPID_PATH = path.join(__dirname, '.vapid-keys.json');
let vapidKeys;
try {
  if (fs.existsSync(VAPID_PATH)) {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2));
    console.log('  ? Generated VAPID keys');
  }
  webpush.setVapidDetails(
    'mailto:' + (process.env.CONTACT_EMAIL || 'hello@mentallyprepare.in'),
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
} catch (e) {
  console.error('  ? VAPID setup failed:', e.message);
}

// --- Razorpay Setup ---------------------
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  console.log('  ? Razorpay configured');
}

// --- Stripe Setup -----------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('  ? Stripe configured');
}

registerPaymentRoutes(app, {
  apiLimiter,
  requireAuth,
  express,
  crypto,
  razorpay,
  stripe,
  stmts
});

registerAppRoutes(app, {
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
  complementary,
  deleteUserDataTx,
  vapidKeys,
  IS_PROD
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
        title: 'Your prompt is waiting ?',
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
  console.log(`  ?? Daily reminders: ${sent} sent, ${failed} failed`);
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

  console.log(`  ? Daily push scheduled for 8:00 PM IST (in ${Math.round(delay / 60000)} min)`);
}
scheduleDailyPush();

// ---------------------------------------
// HEALTH CHECK (for UptimeRobot etc.)
// ---------------------------------------
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

// ---------------------------------------
// PRIVACY & STATIC ROUTES
// ---------------------------------------
// ---------------------------------------
// EMAIL REMINDER SIGNUP
// ---------------------------------------
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

// ---------------------------------------
// ADMIN ROUTES
// ---------------------------------------
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

registerAdminRoutes(app, {
  rootDir: __dirname,
  db,
  stmts,
  requireAdmin,
  getAdminStats,
  getMatchDay,
  findUserByIdentifier,
  complementary,
  deleteUserDataTx,
  deleteMatchData
});

registerWaitlistRoutes(app, {
  apiLimiter,
  db,
  requireAdmin
});

registerStaticRoutes(app, {
  baseUrl: BASE_URL,
  rootDir: __dirname
});

// Send announcement (POST /admin/announce)
// 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ---------------------------------------
// GRACEFUL SHUTDOWN
// ---------------------------------------
function shutdown() {
  console.log('\n  Shutting down...');
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------
// START
// ---------------------------------------
app.listen(PORT, () => {
  console.log(`\n  ? Mentally Prepare v2.0`);
  console.log(`  Database: SQLite (${DB_PATH})`);
  console.log(`  Environment: ${IS_PROD ? 'PRODUCTION' : 'development'}`);
  console.log(`  Razorpay: ${razorpay ? '?' : '– skipped (no keys)'}`);
  console.log(`  Stripe: ${stripe ? '?' : '– skipped (no keys)'}`);
  console.log(`  Push: ${vapidKeys ? '?' : '– skipped'}`);
  console.log(`  Running on http://localhost:${PORT}\n`);
});

