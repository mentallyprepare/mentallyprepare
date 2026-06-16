require('dotenv').config({ quiet: true });

// --- Crash reporting (Sentry). No-op without SENTRY_DSN set. ---
// Crashes only: no tracing, no PII. Entry text never goes to third parties.
// Console breadcrumbs disabled because our logs contain emails and user IDs.
const Sentry = require('@sentry/node');
const SENTRY_ENABLED = Boolean(process.env.SENTRY_DSN);
if (SENTRY_ENABLED) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    integrations(defaults) {
      return defaults.filter(i => i.name !== 'Console');
    },
    beforeBreadcrumb(crumb) {
      if (crumb.category === 'console') return null;
      return crumb;
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        delete event.request.headers;
      }
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
        delete event.user.username;
      }
      return event;
    },
  });
}

// --- Error Logging for Startup Issues ---
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (SENTRY_ENABLED) {
    Sentry.captureException(err);
    Sentry.close(2000).finally(() => process.exit(1));
    return;
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  if (SENTRY_ENABLED) {
    Sentry.captureException(reason);
    Sentry.close(2000).finally(() => process.exit(1));
    return;
  }
  process.exit(1);
});
// ---------------------------------------
// MENTALLY PREPARE — Backend Server v2
// SQLite · Push Notifications · Razorpay · Stripe
// ---------------------------------------

// --- Ensure DB directory exists and is writable (test-volume.js logic) ---

const path = require('path');
const fs = require('fs');
const util = require('util');
const IS_PROD = process.env.NODE_ENV === 'production';
const FALLBACK_DATA_DIR = IS_PROD ? '/tmp/mentally-prepare-data' : __dirname;
const requestedDataDir = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (IS_PROD ? '/data/db' : __dirname);
const Database = require('better-sqlite3');

const MAX_BUFFERED_LOGS = Math.max(100, Number(process.env.ADMIN_LOG_BUFFER_SIZE) || 800);
const runtimeLogBuffer = [];
let nextRuntimeLogId = 1;

function normalizeLogArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  return arg;
}

function recordRuntimeLog(level, args) {
  try {
    runtimeLogBuffer.push({
      id: nextRuntimeLogId++,
      level,
      timestamp: new Date().toISOString(),
      message: util.format(...args.map(normalizeLogArg))
    });
    if (runtimeLogBuffer.length > MAX_BUFFERED_LOGS) {
      runtimeLogBuffer.splice(0, runtimeLogBuffer.length - MAX_BUFFERED_LOGS);
    }
  } catch {}
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

['log', 'info', 'warn', 'error'].forEach((level) => {
  console[level] = (...args) => {
    recordRuntimeLog(level, args);
    return originalConsole[level](...args);
  };
});

function getBufferedLogs({ search = '', level = 'all', sinceMinutes = 0, limit = 200 } = {}) {
  const normalizedSearch = String(search || '').trim().toLowerCase();
  const normalizedLevel = String(level || 'all').trim().toLowerCase();
  const cappedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const since = Math.max(Number(sinceMinutes) || 0, 0);
  const minTimestamp = since > 0 ? Date.now() - (since * 60 * 1000) : 0;

  const filteredEntries = runtimeLogBuffer.filter((entry) => {
    if (normalizedLevel !== 'all' && entry.level !== normalizedLevel) return false;
    if (minTimestamp && new Date(entry.timestamp).getTime() < minTimestamp) return false;
    if (normalizedSearch && !entry.message.toLowerCase().includes(normalizedSearch)) return false;
    return true;
  });

  return {
    total: runtimeLogBuffer.length,
    count: Math.min(filteredEntries.length, cappedLimit),
    entries: filteredEntries.slice(-cappedLimit).reverse()
  };
}

function getDataDirCandidates(preferredDir) {
  return [preferredDir, FALLBACK_DATA_DIR, __dirname]
    .filter((dir, idx, arr) => dir && arr.indexOf(dir) === idx);
}

function initializeDatabase(preferredDir) {
  // Allow explicit DB_PATH override (e.g. for test isolation)
  if (process.env.DB_PATH) {
    const explicitPath = process.env.DB_PATH;
    const explicitDir = path.dirname(explicitPath);
    if (!fs.existsSync(explicitDir)) fs.mkdirSync(explicitDir, { recursive: true });
    const db = new Database(explicitPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('Using explicit DB_PATH:', explicitPath);
    return { DATA_DIR: explicitDir, DB_PATH: explicitPath, db };
  }
  let lastError = null;
  const candidates = getDataDirCandidates(preferredDir);
  for (const candidate of candidates) {
    const dbPath = path.join(candidate, 'mentally-prepare.db');
    let db = null;
    try {
      if (!fs.existsSync(candidate)) {
        fs.mkdirSync(candidate, { recursive: true });
        console.log('Created directory:', candidate);
      }
      fs.accessSync(candidate, fs.constants.W_OK);
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      console.log('Checking directory:', candidate);
      console.log('Directory is writable');
      console.log('Using SQLite DB file:', dbPath);
      return { DATA_DIR: candidate, DB_PATH: dbPath, db };
    } catch (e) {
      if (db) {
        try { db.close(); } catch {}
      }
      lastError = e;
      console.error('Data directory unavailable:', candidate, e.message);
    }
  }
  throw new Error(`No usable SQLite data directory available: ${lastError ? lastError.message : 'unknown error'}`);
}

// resolveDataDir removed — initializeDatabase() handles data dir resolution.
const { DATA_DIR, DB_PATH, db } = initializeDatabase(requestedDataDir);
if (IS_PROD && DATA_DIR === __dirname) {
  console.warn('Using app directory for data storage. SQLite data will be ephemeral until a Railway volume is mounted.');
} else if (IS_PROD && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
  console.warn('No Railway volume mount detected. SQLite data may be stored on ephemeral disk.');
}

// --- Now require other modules ---
const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const { registerStaticRoutes } = require('./routes/static');
const { registerWaitlistRoutes } = require('./routes/waitlist');
const { registerAdminRoutes } = require('./routes/admin');
const { registerAuthRoutes } = require('./routes/auth');
const { registerAppRoutes } = require('./routes/app');
const registerWaitingEntryRoute = require('./routes/waiting-entry');
const { registerTonightsQuestionRoutes } = require('./routes/tonights-question');
const { registerPaymentRoutes } = require('./routes/payments');
const { registerSilentRoutes, registerSilentAdminRoutes } = require('./routes/silent');
const { registerWallRoutes } = require('./routes/wall');
const { runBackup } = require('./scripts/backup');
// ---------------------------------------------------------------
const webpush = require('web-push');
const { BASE_URL } = require('./lib/config');
const { sendWaitlistConfirmation, sendWaitlistAccepted, sendLoginWelcome, sendMatchFoundNotification, sendDailyPromptReminder, sendPartnerWroteReminder, sendPartnerStillWriting } = require('./email-service');
const cron = require('node-cron');

const DEFAULT_FIREBASE_WEB_CONFIG = {
  apiKey: 'AIzaSyCXJTXJj6T0lxbpVOStMa73gFys-Ul76sg',
  authDomain: 'mentally-prepare.firebaseapp.com',
  projectId: 'mentally-prepare',
  appId: '1:1052302846379:web:edbb01face488ffbfb4aee',
  messagingSenderId: '1052302846379',
  storageBucket: 'mentally-prepare.firebasestorage.app'
};

function parseFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  }
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }
  return null;
}

let firebaseAuth = null;
let firebaseCertCache = { expiresAt: 0, certs: {} };
try {
  const serviceAccount = parseFirebaseServiceAccount();
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID
    });
    firebaseAuth = admin.auth();
    console.log('Firebase Admin ready');
  } else {
    console.log('Firebase token verifier ready (public certificate mode)');
  }
} catch (e) {
  console.warn('Firebase Admin setup failed; falling back to public Firebase token verifier:', e.message);
  firebaseAuth = null;
}

function getFirebaseAuthDomain(req) {
  const configured = process.env.FIREBASE_AUTH_DOMAIN || DEFAULT_FIREBASE_WEB_CONFIG.authDomain;
  if (!shouldUseSameOriginFirebaseAuthDomain(req)) return configured;
  return getRequestHost(req) || configured;
}

function getRequestHost(req) {
  const host = String(req && req.headers && req.headers.host ? req.headers.host : '').split(':')[0].toLowerCase();
  return host;
}

function isProductionFirebaseAuthHost(host) {
  const sameOriginHosts = new Set([
    'mymentallyprepare.com',
    'www.mymentallyprepare.com',
    'mentallyprepare-production.up.railway.app'
  ]);
  return sameOriginHosts.has(host);
}

function shouldUseSameOriginFirebaseAuthDomain(req) {
  const configured = String(process.env.FIREBASE_USE_SAME_ORIGIN_AUTH_DOMAIN || '').toLowerCase();
  if (configured === 'true') return true;
  return isProductionFirebaseAuthHost(getRequestHost(req));
}

function getFirebaseWebConfig(req) {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || DEFAULT_FIREBASE_WEB_CONFIG.apiKey,
    authDomain: getFirebaseAuthDomain(req),
    projectId: process.env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_WEB_CONFIG.projectId,
    appId: process.env.FIREBASE_APP_ID || DEFAULT_FIREBASE_WEB_CONFIG.appId,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || DEFAULT_FIREBASE_WEB_CONFIG.messagingSenderId,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || DEFAULT_FIREBASE_WEB_CONFIG.storageBucket,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  };
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const enabled = required.every((key) => !!config[key]);
  return { enabled, config };
}

function base64UrlToBuffer(value) {
  const clean = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - clean.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function parseJwtPart(value) {
  return JSON.parse(base64UrlToBuffer(value).toString('utf8'));
}

async function getFirebasePublicCerts() {
  if (firebaseCertCache.expiresAt > Date.now() && Object.keys(firebaseCertCache.certs).length) {
    return firebaseCertCache.certs;
  }
  const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!response.ok) throw new Error(`Firebase cert fetch failed: ${response.status}`);
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 60 * 60 * 1000;
  firebaseCertCache = {
    expiresAt: Date.now() + Math.max(5 * 60 * 1000, maxAgeMs - 60 * 1000),
    certs: await response.json()
  };
  return firebaseCertCache.certs;
}

function getTestFirebaseTokenPayload(idToken) {
  if (process.env.NODE_ENV !== 'test') return null;
  if (!process.env.FIREBASE_TEST_ID_TOKEN || idToken !== process.env.FIREBASE_TEST_ID_TOKEN) return null;
  if (!process.env.FIREBASE_TEST_ID_TOKEN_PAYLOAD) throw new Error('Firebase test token payload missing');
  const payload = JSON.parse(process.env.FIREBASE_TEST_ID_TOKEN_PAYLOAD);
  if (!payload.uid && payload.sub) payload.uid = payload.sub;
  if (!payload.uid) throw new Error('Firebase test token payload missing uid');
  return payload;
}

async function verifyFirebaseIdToken(idToken) {
  const testPayload = getTestFirebaseTokenPayload(idToken);
  if (testPayload) return testPayload;

  if (firebaseAuth) return firebaseAuth.verifyIdToken(idToken);

  const projectId = getFirebaseWebConfig().config.projectId;
  if (!projectId) throw new Error('Firebase project ID is missing');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid Firebase ID token shape');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtPart(encodedHeader);
  const payload = parseJwtPart(encodedPayload);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unexpected Firebase token header');

  const certs = await getFirebasePublicCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error('Firebase token certificate not found');

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  if (!verifier.verify(cert, base64UrlToBuffer(encodedSignature))) {
    throw new Error('Firebase token signature invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('Firebase token audience mismatch');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Firebase token issuer mismatch');
  if (!payload.sub || String(payload.sub).length > 128) throw new Error('Firebase token subject invalid');
  if (payload.exp <= now) throw new Error('Firebase token expired');
  if (payload.iat > now + 300) throw new Error('Firebase token issued in the future');

  return { ...payload, uid: payload.sub };
}


const app = express();
app.set('trust proxy', 1); // Trust Railway/Heroku/Vercel proxy for correct IP handling
const PORT = process.env.PORT || 8080;

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
    college_normalized TEXT,
    archetype TEXT,
    scores TEXT,
    email_verified INTEGER DEFAULT 0,
    email_verified_at TEXT,
    email_verification_token TEXT,
    email_verification_sent_at TEXT,
    consent_given INTEGER DEFAULT 0,
    consent_date TEXT,
    consent_age_confirmed INTEGER DEFAULT 0,
    consent_policy_version TEXT,
    consent_withdrawn_at TEXT,
    last_active_date TEXT,
    switch_count INTEGER DEFAULT 0,
    push_subscription TEXT,
    push_preferences TEXT,
    push_subscription_updated_at TEXT,
    push_last_sent_at TEXT,
    push_last_sent_type TEXT,
    firebase_uid TEXT,
    profile_photo TEXT,
    auth_provider TEXT DEFAULT 'password',
    last_login_at TEXT,
    account_status TEXT DEFAULT 'active',
    deleted_at TEXT,
    deleted_reason TEXT,
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

  CREATE TABLE IF NOT EXISTS waiting_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    text TEXT NOT NULL,
    mood TEXT DEFAULT '??',
    prompt TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reveals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    choice TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    locked_at TEXT,
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
    match_id INTEGER,
    reported_user_id INTEGER,
    entry_day INTEGER,
    category TEXT DEFAULT 'entry',
    day INTEGER DEFAULT 0,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS report_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES reports(id),
    actor TEXT NOT NULL,
    reason TEXT,
    old_status TEXT,
    new_status TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_id INTEGER NOT NULL REFERENCES users(id),
    blocked_user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER REFERENCES matches(id),
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(blocker_id, blocked_user_id)
  );

  CREATE TABLE IF NOT EXISTS rematch_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER REFERENCES matches(id),
    reason TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    event_name TEXT NOT NULL,
    metadata TEXT,
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

  CREATE TABLE IF NOT EXISTS reminder_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER NOT NULL REFERENCES matches(id),
    day INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, match_id, day)
  );

  CREATE TABLE IF NOT EXISTS daily_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER REFERENCES matches(id),
    day INTEGER NOT NULL,
    archetype TEXT NOT NULL,
    observation TEXT NOT NULL,
    permission TEXT NOT NULL,
    question TEXT NOT NULL,
    landed TEXT DEFAULT NULL,
    opened_at TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, day)
  );

  CREATE TABLE IF NOT EXISTS tonights_question_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    prompt_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    mood TEXT DEFAULT '🌓',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, prompt_index)
  );

  CREATE INDEX IF NOT EXISTS idx_tq_prompt ON tonights_question_entries(prompt_index);
  CREATE INDEX IF NOT EXISTS idx_tq_user ON tonights_question_entries(user_id);

  CREATE TABLE IF NOT EXISTS sealed_room_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER NOT NULL REFERENCES matches(id),
    day INTEGER NOT NULL,
    color TEXT,
    weather TEXT,
    time_of_day TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, match_id, day)
  );

  CREATE TABLE IF NOT EXISTS nudges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER NOT NULL REFERENCES matches(id),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    dismissed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS archetype_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_id INTEGER NOT NULL REFERENCES matches(id),
    day INTEGER NOT NULL,
    scores TEXT NOT NULL,
    archetype TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id);
  CREATE INDEX IF NOT EXISTS idx_entries_match ON entries(match_id);
  CREATE INDEX IF NOT EXISTS idx_matches_user1 ON matches(user1_id);
  CREATE INDEX IF NOT EXISTS idx_matches_user2 ON matches(user2_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_match ON reactions(match_id);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_archetype ON users(archetype);
  CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);

  CREATE TABLE IF NOT EXISTS silent_lines (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL CHECK (length(content) <= 200),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'deleted')),
    moderation_flag TEXT,
    created_at      DATETIME NOT NULL DEFAULT (datetime('now')),
    approved_at     DATETIME,
    expires_at      DATETIME NOT NULL,
    deleted_at      DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_silent_status_expires ON silent_lines(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_silent_user_created   ON silent_lines(user_id, created_at);

  CREATE TABLE IF NOT EXISTS crisis_review (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  );
`);

// INTERNAL ONLY — never call with user input (uses string interpolation in SQL).
function ensureColumn(tableName, columnName, definition) {
  try {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  } catch (e) {
    if (e && !/duplicate column/i.test(e.message || '')) {
      console.error(`Failed to ensure ${tableName}.${columnName} column exists:`, e);
    }
  }
}

ensureColumn('waitlist', 'college', "TEXT NOT NULL DEFAULT ''");
ensureColumn('waitlist', 'year', 'TEXT');
ensureColumn('waitlist', 'archetype', 'TEXT');
ensureColumn('waitlist', 'invited_at', 'TEXT');
ensureColumn('matches', 'constellation_name', 'TEXT');
ensureColumn('users', 'gender', 'TEXT');
ensureColumn('users', 'match_gender_pref', "TEXT DEFAULT 'any'");
ensureColumn('users', 'match_year_pref', "TEXT DEFAULT 'any'");
ensureColumn('users', 'college_normalized', 'TEXT');
ensureColumn('users', 'email_verified', 'INTEGER DEFAULT 0');
ensureColumn('users', 'email_verified_at', 'TEXT');
ensureColumn('users', 'email_verification_token', 'TEXT');
ensureColumn('users', 'email_verification_sent_at', 'TEXT');
ensureColumn('users', 'consent_age_confirmed', 'INTEGER DEFAULT 0');
ensureColumn('users', 'consent_policy_version', 'TEXT');
ensureColumn('users', 'last_active_date', 'TEXT');
ensureColumn('users', 'switch_count', 'INTEGER DEFAULT 0');
ensureColumn('users', 'login_email_sent_at', 'TEXT');
ensureColumn('users', 'updated_at', 'TEXT');
ensureColumn('users', 'push_preferences', 'TEXT');
ensureColumn('users', 'push_subscription_updated_at', 'TEXT');
ensureColumn('users', 'push_last_sent_at', 'TEXT');
ensureColumn('users', 'push_last_sent_type', 'TEXT');
ensureColumn('users', 'firebase_uid', 'TEXT');
ensureColumn('users', 'profile_photo', 'TEXT');
ensureColumn('users', 'auth_provider', "TEXT DEFAULT 'password'");
ensureColumn('users', 'last_login_at', 'TEXT');
ensureColumn('users', 'account_status', "TEXT DEFAULT 'active'");
ensureColumn('users', 'deleted_at', 'TEXT');
ensureColumn('users', 'deleted_reason', 'TEXT');
ensureColumn('matches', 'matched_at', 'TEXT');
ensureColumn('matches', 'updated_at', 'TEXT');
ensureColumn('entries', 'updated_at', 'TEXT');
ensureColumn('waiting_entries', 'scan_completed_at', 'TEXT');
ensureColumn('reports', 'updated_at', 'TEXT');
ensureColumn('reveals', 'locked_at', 'TEXT');
ensureColumn('reports', 'match_id', 'INTEGER');
ensureColumn('reports', 'reported_user_id', 'INTEGER');
ensureColumn('reports', 'entry_day', 'INTEGER');
ensureColumn('reports', 'category', "TEXT DEFAULT 'entry'");
ensureColumn('reports', 'status', "TEXT DEFAULT 'open'");

db.prepare(`
  CREATE TABLE IF NOT EXISTS report_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES reports(id),
    actor TEXT NOT NULL,
    reason TEXT,
    old_status TEXT,
    new_status TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`).run();

// Silent Room — presence/witness columns
ensureColumn('silent_lines', 'seen_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('silent_lines', 'resonance_count', 'INTEGER NOT NULL DEFAULT 0');

// Resonance dedup table (one resonance per user per line)
db.prepare(`
  CREATE TABLE IF NOT EXISTS silent_resonance (
    line_id  TEXT NOT NULL REFERENCES silent_lines(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (line_id, user_id)
  )
`).run();

// ─── Anonymous Wall Schema ───
if (process.env.WALL_ENABLED === 'true') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wall_questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt     TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wall_posts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id  INTEGER NOT NULL REFERENCES wall_questions(id),
      user_id      INTEGER NOT NULL REFERENCES users(id),
      content      TEXT NOT NULL,
      match_opt_in INTEGER NOT NULL DEFAULT 1,
      is_seed      INTEGER NOT NULL DEFAULT 0,
      flagged      INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expire_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wall_reactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL REFERENCES wall_posts(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS wall_match_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id      INTEGER NOT NULL REFERENCES wall_posts(id),
      reactor_id   INTEGER NOT NULL,
      poster_id    INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      support_line TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (post_id, reactor_id)
    );

    CREATE TABLE IF NOT EXISTS wall_chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id   INTEGER NOT NULL REFERENCES matches(id),
      sender_id  INTEGER NOT NULL REFERENCES users(id),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wall_posts_question ON wall_posts(question_id, expire_at);
  `);

  // Wall-specific columns on matches
  ensureColumn('matches', 'wall_origin', 'INTEGER DEFAULT 0');
  ensureColumn('matches', 'wall_expires_at', 'TEXT');

  // Seed a default question if none exists
  const wallQCount = db.prepare('SELECT COUNT(*) as count FROM wall_questions').get();
  if (wallQCount.count === 0) {
    db.prepare('INSERT INTO wall_questions (prompt, active) VALUES (?, 1)').run(
      'What are you carrying that no one knows about?'
    );
  }
}

const SERVER_START_MS = Date.now();
const APP_VERSION = '1.2.3';

function handleLiveness(req, res) {
  try {
    const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - SERVER_START_MS) / 1000),
      users,
      db: 'sqlite',
      env: process.env.NODE_ENV || 'development',
      version: APP_VERSION
    });
  } catch (e) {
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - SERVER_START_MS) / 1000),
      db: 'error',
      env: process.env.NODE_ENV || 'development',
      version: APP_VERSION
    });
  }
}

function handleLivenessText(req, res) {
  res.status(200).send('ok');
}

function handleReadiness(req, res) {
  try {
    db.prepare('SELECT 1').get();
    const firebaseConfig = getFirebaseWebConfig(req);
    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      db: 'sqlite',
      dataDir: DATA_DIR,
      railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
      firebaseAuthDomain: firebaseConfig.config.authDomain,
      firebaseSameOriginAuthDomain: firebaseConfig.config.authDomain === getRequestHost(req)
    });
  } catch (e) {
    res.status(503).json({ status: 'not_ready', error: e.message });
  }
}

function handleReadinessText(req, res) {
  try {
    db.prepare('SELECT 1').get();
    res.status(200).send('ready');
  } catch (e) {
    res.status(503).send('not_ready');
  }
}

(function migrateReminderEmailsFromFile() {
  const legacyPath = path.join(__dirname, 'daily-reminder-emails.txt');
  if (!fs.existsSync(legacyPath)) return;

  const insertReminderSignup = db.prepare(`
    INSERT INTO reminder_signups (email)
    VALUES (?)
    ON CONFLICT(email) DO NOTHING
  `);

  const emails = fs.readFileSync(legacyPath, 'utf8')
    .split(/\r?\n/)
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);

  if (!emails.length) return;

  const migrate = db.transaction(() => {
    for (const email of emails) insertReminderSignup.run(email);
  });

  try {
    migrate();
    console.log(`  ? Imported ${emails.length} reminder signup(s) from daily-reminder-emails.txt`);
  } catch (e) {
    console.error('  ? Reminder signup migration failed:', e.message);
  }
})();

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
  getUserByFirebaseUid: db.prepare('SELECT * FROM users WHERE firebase_uid = ?'),
  getUserByVerificationToken: db.prepare('SELECT * FROM users WHERE email_verification_token = ?'),
  getUsersByName: db.prepare('SELECT * FROM users WHERE LOWER(name) = LOWER(?) ORDER BY created_at DESC'),
  insertUser: db.prepare(`
    INSERT INTO users (
      name, email, password, college, college_normalized, year, gender,
      match_gender_pref, match_year_pref, consent_given, consent_date,
      consent_age_confirmed, consent_policy_version, email_verified,
      email_verification_token, email_verification_sent_at, last_active_date
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateUserScan: db.prepare('UPDATE users SET archetype = ?, scores = ? WHERE id = ?'),
  updateUserActivity: db.prepare('UPDATE users SET last_active_date = ? WHERE id = ?'),
  updateUserPassword: db.prepare('UPDATE users SET password = ? WHERE id = ?'),
  insertPasswordResetToken: db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'),
  getPasswordResetToken: db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?'),
  getValidPasswordResetToken: db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used_at IS NULL AND expires_at > ?'),
  markPasswordResetTokenUsed: db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token = ?'),
  deleteExpiredPasswordResetTokens: db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?'),
  deleteUserPasswordResetTokens: db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?'),
  verifyUserEmail: db.prepare('UPDATE users SET email_verified = 1, email_verified_at = ? WHERE id = ?'),
  updateVerificationToken: db.prepare('UPDATE users SET email_verification_token = ?, email_verification_sent_at = ? WHERE id = ?'),
  anonymizeDeletedUser: db.prepare(`
    UPDATE users
    SET name = ?,
        email = ?,
        password = ?,
        college = 'Deleted account',
        college_normalized = 'deleted account',
        archetype = NULL,
        scores = NULL,
        email_verified = 0,
        email_verification_token = NULL,
        email_verification_sent_at = NULL,
        push_subscription = NULL,
        push_preferences = NULL,
        firebase_uid = NULL,
        profile_photo = NULL,
        auth_provider = 'deleted',
        account_status = 'deleted',
        deleted_at = ?,
        deleted_reason = ?,
        updated_at = ?
    WHERE id = ?
  `),
  updateUserConsent: db.prepare('UPDATE users SET consent_given = ?, consent_withdrawn_at = ? WHERE id = ?'),
  updateUserSwitch: db.prepare('UPDATE users SET switch_count = ? WHERE id = ?'),
  updateUserProfileBasics: db.prepare('UPDATE users SET college = ?, college_normalized = ?, year = ?, updated_at = ? WHERE id = ?'),
  updateUserProfile: db.prepare('UPDATE users SET name = ?, college = ?, college_normalized = ?, year = ?, updated_at = ? WHERE id = ?'),
  updatePushSub: db.prepare("UPDATE users SET push_subscription = ?, push_subscription_updated_at = datetime('now') WHERE id = ?"),
  updatePushPrefs: db.prepare("UPDATE users SET push_preferences = ?, updated_at = datetime('now') WHERE id = ?"),
  markPushSent: db.prepare("UPDATE users SET push_last_sent_at = datetime('now'), push_last_sent_type = ? WHERE id = ?"),
  updateFirebaseUserLogin: db.prepare(`
    UPDATE users
    SET firebase_uid = COALESCE(firebase_uid, ?),
        profile_photo = COALESCE(?, profile_photo),
        auth_provider = CASE
          WHEN auth_provider IS NULL OR auth_provider = '' THEN 'google'
          WHEN instr(auth_provider, 'google') = 0 THEN auth_provider || ',google'
          ELSE auth_provider
        END,
        email_verified = 1,
        email_verified_at = COALESCE(email_verified_at, ?),
        last_login_at = ?,
        updated_at = ?
    WHERE id = ?
  `),
  insertFirebaseUser: db.prepare(`
    INSERT INTO users (
      name, email, password, college, college_normalized, year, gender,
      match_gender_pref, match_year_pref, consent_given, consent_date,
      consent_age_confirmed, consent_policy_version, email_verified,
      email_verified_at, last_active_date, firebase_uid, profile_photo,
      auth_provider, last_login_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateLoginEmailTime: db.prepare('UPDATE users SET login_email_sent_at = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

  getMatch: db.prepare('SELECT * FROM matches WHERE user1_id = ? OR user2_id = ?'),
  insertMatch: db.prepare("INSERT INTO matches (user1_id, user2_id, matched_at) VALUES (?, ?, datetime('now'))"),
  deleteMatch: db.prepare('DELETE FROM matches WHERE id = ?'),
  updateMatchStart: db.prepare('UPDATE matches SET started_at = ? WHERE id = ?'),

  findCandidates: db.prepare(`
    SELECT * FROM users
    WHERE archetype = ?
      AND COALESCE(college_normalized, LOWER(college)) != ?
      AND id != ?
      AND COALESCE(account_status, 'active') != 'deleted'
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

  getWaitingEntry: db.prepare('SELECT * FROM waiting_entries WHERE user_id = ?'),
  upsertWaitingEntry: db.prepare(`
    INSERT INTO waiting_entries (user_id, text, mood, prompt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      text = excluded.text,
      mood = excluded.mood,
      prompt = excluded.prompt,
      updated_at = datetime('now')
  `),
  deleteWaitingEntry: db.prepare('DELETE FROM waiting_entries WHERE user_id = ?'),
  deleteUserWaitingEntries: db.prepare('DELETE FROM waiting_entries WHERE user_id = ?'),

  getReveal: db.prepare('SELECT * FROM reveals WHERE match_id = ? AND user_id = ?'),
  upsertReveal: db.prepare(`
    INSERT INTO reveals (match_id, user_id, choice)
    VALUES (?, ?, ?)
    ON CONFLICT(match_id, user_id) DO UPDATE SET choice = excluded.choice
  `),
  deleteUserReveals: db.prepare('DELETE FROM reveals WHERE user_id = ?'),
  insertRevealChoice: db.prepare('INSERT INTO reveals (match_id, user_id, choice, locked_at) VALUES (?, ?, ?, ?)'),

  getComments: db.prepare('SELECT * FROM comments WHERE match_id = ? AND (user_id = ? OR user_id = ?)'),
  getComment: db.prepare('SELECT * FROM comments WHERE user_id = ? AND match_id = ? AND day = ?'),
  upsertComment: db.prepare(`
    INSERT INTO comments (user_id, match_id, day, text)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id, day) DO UPDATE SET text = excluded.text, updated_at = datetime('now')
  `),
  deleteUserComments: db.prepare('DELETE FROM comments WHERE user_id = ?'),
  deleteMatchComments: db.prepare('DELETE FROM comments WHERE match_id = ?'),

  insertReport: db.prepare(`
    INSERT INTO reports (reporter_id, match_id, reported_user_id, entry_day, day, category, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))
  `),
  deleteUserReports: db.prepare('DELETE FROM reports WHERE reporter_id = ?'),
  deleteReportById: db.prepare('DELETE FROM reports WHERE id = ?'),
  getReportById: db.prepare('SELECT * FROM reports WHERE id = ?'),
  updateReportStatus: db.prepare('UPDATE reports SET status = ?, updated_at = datetime(\'now\') WHERE id = ?'),
  insertReportStatusHistory: db.prepare(`
    INSERT INTO report_status_history (report_id, actor, reason, old_status, new_status)
    VALUES (?, ?, ?, ?, ?)
  `),
  insertBlock: db.prepare(`
    INSERT INTO blocked_users (blocker_id, blocked_user_id, match_id, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(blocker_id, blocked_user_id) DO NOTHING
  `),
  insertRematchRequest: db.prepare('INSERT INTO rematch_requests (user_id, match_id, reason) VALUES (?, ?, ?)'),
  insertAnalyticsEvent: db.prepare('INSERT INTO analytics_events (user_id, event_name, metadata) VALUES (?, ?, ?)'),

  deleteUserMatches: db.prepare('DELETE FROM matches WHERE user1_id = ? OR user2_id = ?'),
  deleteMatchEntries: db.prepare('DELETE FROM entries WHERE match_id = ?'),
  deleteMatchReveals: db.prepare('DELETE FROM reveals WHERE match_id = ?'),
  deleteMatchById: db.prepare('DELETE FROM matches WHERE id = ?'),
  deleteUserPayments: db.prepare('DELETE FROM payments WHERE user_id = ?'),

  insertDeletionLog: db.prepare('INSERT INTO deletion_log (anonymised_id, reason) VALUES (?, ?)'),

  getReminderSignupByEmail: db.prepare('SELECT * FROM reminder_signups WHERE email = ?'),
  insertReminderSignup: db.prepare(`
    INSERT INTO reminder_signups (email)
    VALUES (?)
    ON CONFLICT(email) DO NOTHING
  `),
  getReminderEmails: db.prepare('SELECT email FROM reminder_signups ORDER BY created_at ASC'),

  insertPayment: db.prepare('INSERT INTO payments (user_id, provider, provider_order_id, amount, currency, product, status) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updatePayment: db.prepare('UPDATE payments SET provider_payment_id = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?'),
  getPayment: db.prepare('SELECT * FROM payments WHERE id = ?'),
  getPaymentByOrder: db.prepare('SELECT * FROM payments WHERE provider_order_id = ?'),
  getUserPayments: db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC'),

  getAllPushUsers: db.prepare('SELECT id, push_subscription, push_preferences, last_active_date, created_at, push_last_sent_at, push_last_sent_type FROM users WHERE push_subscription IS NOT NULL'),
  getActiveMatchUsers: db.prepare(`
    SELECT u.id, u.push_subscription, u.push_preferences, u.last_active_date, u.created_at, u.push_last_sent_at, u.push_last_sent_type, m.started_at, m.id as match_id
    FROM users u
    JOIN matches m ON (m.user1_id = u.id OR m.user2_id = u.id)
    WHERE u.push_subscription IS NOT NULL
  `),

  // Reactions
  upsertReaction: db.prepare(`
    INSERT INTO reactions (user_id, match_id, day, emoji)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id, day) DO UPDATE SET emoji = excluded.emoji
  `),
  getReactions: db.prepare('SELECT * FROM reactions WHERE match_id = ?'),
  deleteUserReactions: db.prepare('DELETE FROM reactions WHERE user_id = ?'),
  deleteMatchReactions: db.prepare('DELETE FROM reactions WHERE match_id = ?'),

  // Nudges
  insertNudge: db.prepare(`INSERT INTO nudges (user_id, match_id, type, message) VALUES (?, ?, ?, ?)`),
  getActiveNudges: db.prepare('SELECT * FROM nudges WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT 3'),
  dismissNudge: db.prepare('UPDATE nudges SET dismissed = 1 WHERE id = ? AND user_id = ?'),
  deleteUserNudges: db.prepare('DELETE FROM nudges WHERE user_id = ?'),
  deleteMatchNudges: db.prepare('DELETE FROM nudges WHERE match_id = ?'),
  getGhostNudge: db.prepare("SELECT id FROM nudges WHERE user_id = ? AND match_id = ? AND type = 'partner_still_writing' AND dismissed = 0 LIMIT 1"),
  clearGhostNudge: db.prepare("DELETE FROM nudges WHERE user_id = ? AND match_id = ? AND type = 'partner_still_writing'"),
  hasBlockReportRematch: db.prepare(`
    SELECT 1 FROM blocked_users WHERE (blocker_id = ? OR blocked_user_id = ?) AND match_id = ?
    UNION ALL
    SELECT 1 FROM reports WHERE match_id = ? AND status = 'open'
    UNION ALL
    SELECT 1 FROM rematch_requests WHERE match_id = ?
    LIMIT 1
  `),

  // Archetype snapshots
  insertSnapshot: db.prepare('INSERT INTO archetype_snapshots (user_id, match_id, day, scores, archetype) VALUES (?, ?, ?, ?, ?)'),
  getSnapshots: db.prepare('SELECT * FROM archetype_snapshots WHERE user_id = ? AND match_id = ? ORDER BY day ASC'),
  deleteMatchSnapshots: db.prepare('DELETE FROM archetype_snapshots WHERE match_id = ?'),

  // Daily notes
  getDailyNote: db.prepare('SELECT * FROM daily_notes WHERE user_id = ? AND day = ?'),
  getDailyNotesArchive: db.prepare('SELECT * FROM daily_notes WHERE user_id = ? ORDER BY day DESC'),
  upsertDailyNote: db.prepare(`
    INSERT INTO daily_notes (user_id, match_id, day, archetype, observation, permission, question)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET
      match_id = excluded.match_id,
      archetype = excluded.archetype,
      observation = excluded.observation,
      permission = excluded.permission,
      question = excluded.question
  `),
  updateNoteLanded: db.prepare("UPDATE daily_notes SET landed = ?, opened_at = COALESCE(opened_at, datetime('now')) WHERE user_id = ? AND day = ?"),
  markNoteOpened: db.prepare("UPDATE daily_notes SET opened_at = COALESCE(opened_at, datetime('now')) WHERE user_id = ? AND day = ?"),
  deleteUserDailyNotes: db.prepare('DELETE FROM daily_notes WHERE user_id = ?'),
  deleteMatchDailyNotes: db.prepare('DELETE FROM daily_notes WHERE match_id = ?'),

  // Sealed room picks
  upsertSealedPick: db.prepare(`
    INSERT INTO sealed_room_picks (user_id, match_id, day, color, weather, time_of_day)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, match_id, day) DO UPDATE SET
      color = excluded.color,
      weather = excluded.weather,
      time_of_day = excluded.time_of_day
  `),
  getSealedPicks: db.prepare('SELECT * FROM sealed_room_picks WHERE match_id = ? ORDER BY day ASC'),
  deleteUserSealedPicks: db.prepare('DELETE FROM sealed_room_picks WHERE user_id = ?'),
  deleteMatchSealedPicks: db.prepare('DELETE FROM sealed_room_picks WHERE match_id = ?'),

  // Tonight's Question
  getTonightsEntry: db.prepare('SELECT * FROM tonights_question_entries WHERE user_id = ? AND prompt_index = ?'),
  upsertTonightsEntry: db.prepare(`
    INSERT INTO tonights_question_entries (user_id, prompt_index, text, mood)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, prompt_index) DO UPDATE SET text = excluded.text, mood = excluded.mood
  `),
  getTonightsWhispers: db.prepare(`
    SELECT text, mood, created_at FROM tonights_question_entries
    WHERE prompt_index = ? AND user_id != ?
    ORDER BY created_at DESC LIMIT 12
  `),
  getTonightsCount: db.prepare('SELECT COUNT(*) as c FROM tonights_question_entries WHERE prompt_index = ?'),
  getUserTonightsCount: db.prepare('SELECT COUNT(*) as c FROM tonights_question_entries WHERE user_id = ?'),
  getUserTonightsHistory: db.prepare('SELECT * FROM tonights_question_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'),
  deleteUserTonightsEntries: db.prepare('DELETE FROM tonights_question_entries WHERE user_id = ?'),
};

// --- Helper: parse scores JSON ----------
function parseUser(row) {
  if (!row) return null;
  return { ...row, scores: row.scores ? JSON.parse(row.scores) : null };
}

const COLLEGE_ALIASES = new Map([
  ['du', 'university-of-delhi'],
  ['d u', 'university-of-delhi'],
  ['d.u', 'university-of-delhi'],
  ['d.u.', 'university-of-delhi'],
  ['delhi university', 'university-of-delhi'],
  ['delhi uni', 'university-of-delhi'],
  ['university of delhi', 'university-of-delhi'],
  ['miranda house', 'miranda-house-delhi'],
  ['miranda house delhi', 'miranda-house-delhi'],
  ['srcc', 'shri-ram-college-of-commerce'],
  ['shri ram college of commerce', 'shri-ram-college-of-commerce'],
  ['lsr', 'lady-shri-ram-college'],
  ['lady shri ram college', 'lady-shri-ram-college']
]);

function normalizeCollegeName(value) {
  const clean = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return COLLEGE_ALIASES.get(clean) || clean.replace(/\s+/g, '-');
}

(function backfillNormalizedColleges() {
  try {
    const rows = db.prepare('SELECT id, college FROM users WHERE college_normalized IS NULL OR college_normalized = ?').all('');
    const update = db.prepare('UPDATE users SET college_normalized = ? WHERE id = ?');
    const tx = db.transaction((items) => {
      for (const user of items) update.run(normalizeCollegeName(user.college), user.id);
    });
    tx(rows);
  } catch (e) {
    console.warn('College normalization backfill skipped:', e.message);
  }
})();

function trackEvent(userId, eventName, metadata = {}) {
  try {
    const allowed = new Set([
      'signup_started', 'signup_completed', 'email_verified', 'scan_started', 'scan_completed',
      'matched', 'day_1_written', 'day_2_returned', 'missed_day', 'report_clicked',
      'block_clicked', 'rematch_requested', 'reveal_choice_submitted', 'account_deleted',
      'crisis_keyword_triggered', 'signup_error', 'email_send_failed', 'login',
      'day_written', 'mutual_reveal', 'signup', 'first_reflection', 'day_2', 'day_3', 'day_7',
      'day_14', 'day_21', 'reveal_request', 'paid_conversion', 'partner_reminder_sent',
      'continue_solo_selected'
    ]);
    if (!allowed.has(eventName)) return;
    stmts.insertAnalyticsEvent.run(userId || null, eventName, JSON.stringify(metadata || {}));
  } catch (e) {
    console.warn('Analytics event skipped:', e.message);
  }
}

// --- Middleware --------------------------
function isFirebaseAuthHelperPath(req) {
  return req.path.startsWith('/__/auth/') || req.path === '/__/firebase/init.json';
}

const appSecurityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com", "https://www.gstatic.com", "https://apis.google.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://api.razorpay.com", "https://lumberjack-cx.razorpay.com", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com", "https://*.googleapis.com", "https://*.firebaseapp.com"],
      imgSrc: ["'self'", "data:", "https://lh3.googleusercontent.com"],
      frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com", "https://accounts.google.com", "https://*.firebaseapp.com"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
});

app.use((req, res, next) => {
  if (isFirebaseAuthHelperPath(req)) return next();
  return appSecurityHeaders(req, res, next);
});
// --- Stripe webhook MUST be registered BEFORE express.json() ---
// (Stripe needs the raw body for signature verification)
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('  ✦ Stripe configured');
}
if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
  const { registerStripeWebhook } = require('./routes/payments');
  registerStripeWebhook(app, { stripe, stmts, express });
}

const FIREBASE_AUTH_HELPER_ORIGIN = 'https://mentally-prepare.firebaseapp.com';

async function proxyFirebaseAuthHelper(req, res) {
  try {
    const targetUrl = new URL(req.originalUrl, FIREBASE_AUTH_HELPER_ORIGIN);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'accept-encoding'].includes(key.toLowerCase())) continue;
      headers[key] = value;
    }

    const init = {
      method: req.method,
      headers,
      redirect: 'manual'
    };

    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      init.body = req;
      init.duplex = 'half';
    }

    const upstream = await fetch(targetUrl, init);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (['content-encoding', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) return;
      res.setHeader(key, value);
    });

    const body = Buffer.from(await upstream.arrayBuffer());
    res.send(body);
  } catch (e) {
    console.error('Firebase auth helper proxy failed:', e);
    res.status(502).send('Firebase auth helper unavailable');
  }
}

app.all('/__/auth/*', proxyFirebaseAuthHelper);
app.get('/__/firebase/init.json', (req, res) => {
  const payload = getFirebaseWebConfig(req);
  if (!payload.enabled) return res.status(503).json({ error: 'Firebase web config is not enabled' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(payload.config);
});

app.use(express.json({ limit: '16kb' }));

// ── Noindex middleware for app, admin, and API routes ──
app.use(['/app', '/admin', '/api', '/signup', '/login', '/forgot', '/onboarding', '/scan', '/room'], (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Keep Railway health checks independent from session middleware.
app.get('/api/health', handleLiveness);
app.get('/health', handleLivenessText);
app.get('/api/ready', handleReadiness);
app.get('/ready', handleReadinessText);

function setStaticCacheHeaders(res, filePath) {
  if (/\.(html?)$/i.test(filePath) || /[\\/]sw\.js$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'no-store');
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
}

// --- HTTPS redirect (production) — BEFORE static files ---
if (IS_PROD) {
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/ready' || req.path === '/api/health' || req.path === '/api/ready') {
      return next();
    }
    const forwardedProto = req.header('x-forwarded-proto');
    const host = req.header('host');
    if (forwardedProto && forwardedProto !== 'https' && host) {
      return res.redirect('https://' + host + req.url);
    }
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
}

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve terms.html at /terms
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: setStaticCacheHeaders
}));

// Persist session secret
const SESSION_SECRET_PATH = path.join(DATA_DIR, '.session-secret');
const SESSION_DB_NAME = 'mentally-prepare-sessions.db';
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (IS_PROD) {
    console.warn(`SESSION_SECRET is not set. Falling back to ${SESSION_SECRET_PATH}. Set SESSION_SECRET in Railway for a permanent secret.`);
  }
  try {
    if (fs.existsSync(SESSION_SECRET_PATH)) return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SESSION_SECRET_PATH, secret);
  return secret;
}

function createSessionStore() {
  try {
    return new SQLiteStore({
      db: SESSION_DB_NAME,
      dir: DATA_DIR
    });
  } catch (e) {
    console.error('Session store unavailable:', e && e.stack ? e.stack : e);
    console.warn('Falling back to in-memory sessions. Logins will reset on restart until SQLite session storage is working again.');
    return null;
  }
}

const sessionConfig = {
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
};

const sessionStore = createSessionStore();
if (sessionStore) {
  sessionConfig.store = sessionStore;
  console.log('  ✦ Session store: SQLite');
} else {
  console.warn('  ⚠ Session store: IN-MEMORY (logins reset on restart)');
}

app.use(session(sessionConfig));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = stmts.getUserById.get(req.session.userId);
  if (!user || user.account_status === 'deleted') {
    if (req.session) req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not authenticated' });
  }
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
  stmts,
  sendLoginWelcome,
  normalizeCollegeName,
  trackEvent,
  verifyFirebaseIdToken,
  getFirebaseWebConfig
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
  generic: 'your local emergency services or a crisis line in your country',
  IN: {
    teleManas: '14416 or 1800 891 4416',
    iCall: '9152987821',
    vandrevala: '+91 9999 666 555',
    nimhans: '080-46110007'
  }
};

/** Detect India locale from request headers */
function isIndiaLocale(req) {
  const tz = req.headers['x-timezone'] || '';
  const lang = (req.headers['accept-language'] || '').toLowerCase();
  return tz.includes('Asia/Kolkata') || tz.includes('Asia/Calcutta')
    || lang.startsWith('hi') || lang.includes('en-in');
}

/** Build locale-appropriate crisis response fields */
function getCrisisPayload(req) {
  const india = isIndiaLocale(req);
  let message = 'If things feel like too much right now, please contact your local emergency services or a trusted person.';
  let helplines = { generic: HELPLINES.generic };

  if (india && HELPLINES.IN) {
    message += ` In India, you can reach Tele MANAS at ${HELPLINES.IN.teleManas}.`;
    helplines = { ...helplines, ...HELPLINES.IN };
  }
  return { message, helplines };
}

function scanForSafety(text) {
  const lower = text.toLowerCase();
  const crisis = SAFETY_KEYWORDS.some(kw => lower.includes(kw));
  const piiFlags = [];
  let pii = CONTENT_FLAGS.some(kw => lower.includes(kw));
  if (pii) piiFlags.push('personal_identifier_keyword');
  // Regex for +91-format phone numbers (10 digits, with or without spaces/dashes)
  const phoneRegex = /(?:\+91[- ]?)?(?:[6-9][0-9]{9})|(?:[0-9]{3}[- ]?[0-9]{3}[- ]?[0-9]{4})/g;
  if (phoneRegex.test(text)) { pii = true; piiFlags.push('phone_or_whatsapp'); }

  const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  if (emailRegex.test(text)) { pii = true; piiFlags.push('email'); }

  const linkRegex = /\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|in|org|net|edu|io|me)\b)/i;
  if (linkRegex.test(text)) { pii = true; piiFlags.push('external_link'); }

  const addressRegex = /\b(?:house|flat|room|block|sector|street|road|lane|hostel|pg|apartment|tower)\s+(?:no\.?\s*)?[a-z0-9-]{1,12}\b/i;
  if (addressRegex.test(text)) { pii = true; piiFlags.push('address_or_hostel'); }

  const collegeDeptBatchRegex = /\b(?:college|university|du|iit|iim|bits|vit|amity|department|dept|batch)\b.*\b(?:department|dept|batch|20\d{2}|1st|2nd|3rd|4th|5th)\b/i;
  if (collegeDeptBatchRegex.test(text)) { pii = true; piiFlags.push('college_department_batch_combo'); }

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
  if (socialRegexes.some(r => r.test(text))) { pii = true; piiFlags.push('social_or_messaging_handle'); }
  return { crisis, pii, piiFlags: Array.from(new Set(piiFlags)) };
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
  const userCollegeKey = user.college_normalized || normalizeCollegeName(user.college);

  let candidates = stmts.findCandidates.all(targetType, userCollegeKey, userId).map(parseUser);

  // Fallback if no complementary candidate is available: keep different-college rule hard.
  if (candidates.length === 0) {
    const fallbackStmt = db.prepare(`
      SELECT * FROM users
      WHERE archetype IS NOT NULL
        AND COALESCE(college_normalized, LOWER(college)) != ?
        AND id != ?
        AND id NOT IN (SELECT user1_id FROM matches UNION SELECT user2_id FROM matches)
    `);
    candidates = fallbackStmt.all(userCollegeKey, userId).map(parseUser);
  }

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

  let partner = candidates[0] || null;

  // Fallback: if no complementary match found, accept any unmatched user
  // from a different college (regardless of archetype). This prevents users
  // from waiting indefinitely when the pool is small.
  if (!partner) {
    let fallback = db.prepare(`
      SELECT * FROM users
      WHERE COALESCE(college_normalized, LOWER(college)) != ?
        AND id != ?
        AND archetype IS NOT NULL
        AND id NOT IN (SELECT user1_id FROM matches UNION SELECT user2_id FROM matches)
    `).all(userCollegeKey, userId).map(parseUser);

    // Respect gender preferences on fallback too
    if (user.match_gender_pref && user.match_gender_pref !== 'any') {
      const gf = fallback.filter(c => c.gender === user.match_gender_pref);
      if (gf.length > 0) fallback = gf;
    }
    fallback = fallback.filter(c => {
      if (!c.match_gender_pref || c.match_gender_pref === 'any') return true;
      return c.match_gender_pref === user.gender;
    });
    partner = fallback[0] || null;
  }

  if (partner) {
    const result = stmts.insertMatch.run(userId, partner.id);
    attachWaitingEntriesToMatch(result.lastInsertRowid, [userId, partner.id]);
    trackEvent(userId, 'matched', { matchId: result.lastInsertRowid });
    trackEvent(partner.id, 'matched', { matchId: result.lastInsertRowid });

    // Dispatch match found emails asynchronously
    sendMatchFoundNotification(user.email, user.name, partner.archetype).catch(err => console.error("Match email error:", err));
    sendMatchFoundNotification(partner.email, partner.name, user.archetype).catch(err => console.error("Match email error:", err));

    return result.lastInsertRowid;
  }
  return null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateAsUTC(value) {
  if (!value) return new Date(NaN);
  const raw = String(value).trim();
  if (!raw) return new Date(NaN);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw);
  return new Date(raw.replace(' ', 'T') + 'Z');
}

function getISTDate(value = new Date()) {
  const date = value instanceof Date ? value : parseDateAsUTC(value);
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function getISTDayIndex(value = new Date()) {
  const date = value instanceof Date ? value : parseDateAsUTC(value);
  return Math.floor((date.getTime() + IST_OFFSET_MS) / DAY_MS);
}

function getCurrentJourneyDayIST(startedAt, now = new Date(), { cap = true } = {}) {
  const started = parseDateAsUTC(startedAt);
  if (Number.isNaN(started.getTime())) return 1;
  const day = Math.max(getISTDayIndex(now) - getISTDayIndex(started) + 1, 1);
  return cap ? Math.min(day, 21) : day;
}

function getMatchDay(startedAt) {
  return getCurrentJourneyDayIST(startedAt);
}

function getNextUnsealAtIST(now = new Date()) {
  const date = now instanceof Date ? now : parseDateAsUTC(now);
  const nextIstMidnightUtcMs = (getISTDayIndex(date) + 1) * DAY_MS - IST_OFFSET_MS;
  return new Date(nextIstMidnightUtcMs).toISOString();
}

function isEntryUnlocked(entry, match, now = new Date()) {
  if (!entry || !match) return false;
  const unlockedJourneyDay = getCurrentJourneyDayIST(match.started_at, now, { cap: false });
  return Number(entry.day) < unlockedJourneyDay;
}

function findUserByIdentifier(identifier) {
  if (identifier === undefined || identifier === null) return null;
  const raw = String(identifier).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseUser(stmts.getUserById.get(Number(raw)));
  if (raw.includes('@')) return parseUser(stmts.getUserByEmail.get(raw.toLowerCase()));

  const matches = stmts.getUsersByName.all(raw).map(parseUser).filter(Boolean);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error('Multiple users share that name. Use email or ID instead.');
    err.statusCode = 400;
    throw err;
  }
  return null;
}

function attachWaitingEntriesToMatch(matchId, userIds) {
  for (const userId of userIds) {
    const waitingEntry = stmts.getWaitingEntry.get(userId);
    if (!waitingEntry) continue;
    stmts.upsertEntry.run(
      userId,
      matchId,
      1,
      waitingEntry.text,
      waitingEntry.mood || '??',
      waitingEntry.prompt || prompts[0]
    );
    stmts.deleteWaitingEntry.run(userId);
  }
}

function deleteMatchData(matchId) {
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

function runDeleteIfPossible(sql, params = []) {
  try {
    db.prepare(sql).run(...params);
  } catch (e) {
    if (!/no such table|no such column/i.test(e.message || '')) throw e;
  }
}

function deleteUserOwnedData(userId) {
  runDeleteIfPossible('DELETE FROM wall_chat_messages WHERE sender_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM wall_match_requests WHERE reactor_id = ? OR poster_id = ? OR post_id IN (SELECT id FROM wall_posts WHERE user_id = ?)', [userId, userId, userId]);
  runDeleteIfPossible('DELETE FROM wall_reactions WHERE user_id = ? OR post_id IN (SELECT id FROM wall_posts WHERE user_id = ?)', [userId, userId]);
  runDeleteIfPossible('DELETE FROM wall_posts WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM silent_resonance WHERE user_id = ? OR line_id IN (SELECT id FROM silent_lines WHERE user_id = ?)', [userId, userId]);
  runDeleteIfPossible('DELETE FROM crisis_review WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM silent_lines WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM blocked_users WHERE blocker_id = ? OR blocked_user_id = ?', [userId, userId]);
  runDeleteIfPossible('DELETE FROM rematch_requests WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM payments WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM waiting_entries WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM entries WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM reveals WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM comments WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM reactions WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM nudges WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM daily_notes WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM sealed_room_picks WHERE user_id = ?', [userId]);
  runDeleteIfPossible('DELETE FROM tonights_question_entries WHERE user_id = ?', [userId]);
}

const deleteUserDataTx = db.transaction((userId, reason = 'admin_removed') => {
  const existing = stmts.getUserById.get(userId);
  if (!existing) return { deleted: false };
  const matches = db.prepare('SELECT id FROM matches WHERE user1_id = ? OR user2_id = ?').all(userId, userId);
  for (const match of matches) deleteMatchData(match.id);
  const deletedAt = new Date().toISOString();
  const anonymisedId = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
  stmts.insertDeletionLog.run(
    anonymisedId,
    reason
  );
  deleteUserOwnedData(userId);
  const lockedPassword = `deleted:${crypto.randomBytes(32).toString('hex')}`;
  const deletedEmail = `deleted-${userId}-${Date.now()}-${anonymisedId}@deleted.local`;
  stmts.anonymizeDeletedUser.run(
    'Deleted user',
    deletedEmail,
    lockedPassword,
    deletedAt,
    reason,
    deletedAt,
    userId
  );
  return { deleted: true, anonymisedId };
});

function getPartnerId(match, userId) {
  return match.user1_id === userId ? match.user2_id : match.user1_id;
}

// --- Web Push Setup ---------------------
const VAPID_PATH = path.join(DATA_DIR, '.vapid-keys.json');
let vapidKeys;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    console.log('  ✓ VAPID keys loaded from environment variables');
  } else if (fs.existsSync(VAPID_PATH)) {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
    console.log('  ✓ VAPID keys loaded from file');
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2));
    console.log('  ✓ Generated new VAPID keys and saved to file');
  }
  if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
    throw new Error('VAPID keys missing public/private key');
  }
  webpush.setVapidDetails(
    'mailto:' + (process.env.CONTACT_EMAIL || 'hello@mentallyprepare.in'),
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
  console.log('  ✓ Webpush VAPID keys loaded');
} catch (e) {
  vapidKeys = null;
  console.error('  ✗ VAPID setup failed:', e && e.stack ? e.stack : e);
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

// Stripe was initialized above (before express.json) for webhook support

registerPaymentRoutes(app, {
  apiLimiter,
  requireAuth,
  express,
  crypto,
  razorpay,
  stripe,
  stmts,
  trackEvent
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
  getISTDate,
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
  IS_PROD,
  sendMatchFoundNotification
});
// Register waiting-entry route
registerWaitingEntryRoute(app, {
  apiLimiter,
  requireAuth,
  stmts,
  prompts,
  scanForSafety,
  HELPLINES,
  getCrisisPayload,
  trackEvent
});

// Register Tonight's Question routes
registerTonightsQuestionRoutes(app, {
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
});

// ─── Silent Room Routes ───────────────────────────────────────
registerSilentRoutes(app, {
  apiLimiter,
  requireAuth,
  db,
  scanForSafety,
  HELPLINES,
  getCrisisPayload
});
registerSilentAdminRoutes(app, {
  requireAdmin,
  db
});

// ─── Anonymous Wall Routes ───────────────────────────────────
if (process.env.WALL_ENABLED === 'true') {
  registerWallRoutes(app, {
    apiLimiter,
    requireAuth,
    db,
    scanForSafety,
    HELPLINES,
    getCrisisPayload,
    trackEvent
  });
}

// ─── Daily Note Generation ───────────────────────────────────
const { getNote } = require('./lib/note-library');

function generateDailyNoteForUser(userId, matchId, archetype, day) {
  const note = getNote(archetype, day, userId);
  stmts.upsertDailyNote.run(userId, matchId || null, day, archetype, note.observation, note.permission, note.question);
  return note;
}

// Generate notes for all active users (called at midnight)
function generateDailyNotesForAll() {
  const rows = stmts.getActiveMatchUsers.all();
  let generated = 0;
  for (const row of rows) {
    const user = parseUser(stmts.getUserById.get(row.id));
    if (!user || !user.archetype) continue;
    const day = getMatchDay(row.started_at);
    if (day < 1 || day > 21) continue;
    // Tomorrow's note
    const nextDay = Math.min(day + 1, 21);
    const existing = stmts.getDailyNote.get(user.id, nextDay);
    if (!existing) {
      generateDailyNoteForUser(user.id, row.match_id, user.archetype, nextDay);
      generated++;
    }
  }
  // Also generate for waiting (unmatched) users
  const waitingUsers = db.prepare(`SELECT u.id, u.archetype FROM users u LEFT JOIN matches m ON m.user1_id = u.id OR m.user2_id = u.id WHERE m.id IS NULL AND u.archetype IS NOT NULL`).all();
  for (const u of waitingUsers) {
    const existing = stmts.getDailyNote.get(u.id, 1);
    if (!existing) {
      generateDailyNoteForUser(u.id, null, u.archetype, 1);
      generated++;
    }
  }
  console.log(`  ✦ Generated ${generated} daily notes`);
}

// ─── API: Daily Note endpoints ────────────────────────────────
app.get('/api/daily-note', apiLimiter, requireAuth, (req, res) => {
  const user = parseUser(stmts.getUserById.get(req.session.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.archetype) return res.json({ note: null, reason: 'no_archetype' });

  const match = stmts.getMatch.get(user.id, user.id);
  const day = match ? getMatchDay(match.started_at) : 1;
  let note = stmts.getDailyNote.get(user.id, day);

  if (!note) {
    // Generate on-demand if missing
    generateDailyNoteForUser(user.id, match ? match.id : null, user.archetype, day);
    note = stmts.getDailyNote.get(user.id, day);
  }

  res.json({ note, archetype: user.archetype });
});

app.post('/api/daily-note/open', apiLimiter, requireAuth, (req, res) => {
  const user = parseUser(stmts.getUserById.get(req.session.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const match = stmts.getMatch.get(user.id, user.id);
  const day = match ? getMatchDay(match.started_at) : 1;
  stmts.markNoteOpened.run(user.id, day);
  res.json({ ok: true });
});

app.post('/api/daily-note/feedback', apiLimiter, requireAuth, (req, res) => {
  const { landed } = req.body;
  if (!['yes', 'no'].includes(landed)) return res.status(400).json({ error: 'landed must be yes or no' });
  const user = parseUser(stmts.getUserById.get(req.session.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const match = stmts.getMatch.get(user.id, user.id);
  const day = match ? getMatchDay(match.started_at) : 1;
  stmts.updateNoteLanded.run(landed, user.id, day);
  res.json({ ok: true });
});

app.get('/api/daily-notes/archive', apiLimiter, requireAuth, (req, res) => {
  const notes = stmts.getDailyNotesArchive.all(req.session.userId);
  res.json({ notes });
});

// ─── API: Sealed Room picks ───────────────────────────────────
app.post('/api/sealed-room/pick', apiLimiter, requireAuth, (req, res) => {
  const { color, weather, time_of_day } = req.body;
  const user = parseUser(stmts.getUserById.get(req.session.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const match = stmts.getMatch.get(user.id, user.id);
  if (!match) return res.status(400).json({ error: 'No active match' });
  const day = getMatchDay(match.started_at);
  stmts.upsertSealedPick.run(user.id, match.id, day, color || null, weather || null, time_of_day || null);
  res.json({ ok: true });
});

app.get('/api/sealed-room', apiLimiter, requireAuth, (req, res) => {
  const user = parseUser(stmts.getUserById.get(req.session.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const match = stmts.getMatch.get(user.id, user.id);
  if (!match) return res.json({ picks: [] });
  const currentDay = getMatchDay(match.started_at);
  const allPicks = stmts.getSealedPicks.all(match.id);
  const partnerId = getPartnerId(match, user.id);
  // Blur partner picks until Day 21
  const revealed = currentDay >= 21;
  const myPicks = allPicks.filter(p => p.user_id === user.id);
  const partnerPicks = allPicks.filter(p => p.user_id === partnerId).map(p => ({
    day: p.day,
    color: revealed ? p.color : null,
    weather: revealed ? p.weather : null,
    time_of_day: revealed ? p.time_of_day : null,
    blurred: !revealed
  }));
  res.json({ myPicks, partnerPicks, revealed, currentDay });
});

// ─── API: Partner wrote today ─────────────────────────────────
app.get('/api/partner-wrote-today', apiLimiter, requireAuth, (req, res) => {
  const user = parseUser(stmts.getUserById.get(req.session.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const match = stmts.getMatch.get(user.id, user.id);
  if (!match) return res.json({ partnerWrote: false });
  const partnerId = getPartnerId(match, user.id);
  const day = getMatchDay(match.started_at);
  const partnerEntry = stmts.getEntry.get(partnerId, match.id, day);
  res.json({ partnerWrote: !!partnerEntry });
});

// ─── Email Notification Scheduler Using Node-Cron ─────────────────────────────

// 9pm IST = 15:30 UTC — daily prompt reminder
const DEFAULT_PUSH_PREFERENCES = {
  enabled: true,
  morningReminder: true,
  eveningReminder: true,
  dailyReflection: true,
  streakReminder: true,
  silentRoomReminder: false
};

const PUSH_COPY = {
  morning: 'A small pause can change the day.',
  daily_reflection: "Today's reflection is open.",
  evening: 'Your reset is ready.',
  partner_waiting: 'Your next step is waiting.',
  daily_prompt_unlocked: "Today's reflection is open.",
  silent_room: 'Come back for two quiet minutes.',
  inactive_24: 'Your 21 day journey continues today.',
  inactive_48: 'A small reset is open when you are ready.'
};

function parsePushPreferences(raw) {
  let prefs = {};
  try { prefs = raw ? JSON.parse(raw) : {}; } catch { prefs = {}; }
  const merged = { ...DEFAULT_PUSH_PREFERENCES, ...prefs };
  merged.enabled = merged.enabled !== false;
  for (const key of ['morningReminder', 'eveningReminder', 'dailyReflection', 'streakReminder', 'silentRoomReminder']) {
    merged[key] = merged.enabled && merged[key] !== false;
  }
  return merged;
}

function sqliteDateToMs(value) {
  if (!value) return 0;
  const date = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function recentlySent(row, type, hours) {
  if (!row || row.push_last_sent_type !== type || !row.push_last_sent_at) return false;
  const last = sqliteDateToMs(row.push_last_sent_at);
  return last > 0 && Date.now() - last < hours * 60 * 60 * 1000;
}

async function sendGentlePush(row, type, body, url = '/app') {
  if (!vapidKeys || !row || !row.push_subscription || recentlySent(row, type, 6)) return false;
  let subscription;
  try {
    subscription = JSON.parse(row.push_subscription);
  } catch (e) {
    stmts.updatePushSub.run(null, row.id);
    console.warn('Push subscription invalid, cleared for user', row.id);
    return false;
  }

  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      title: 'Mentally Prepare',
      body: body || PUSH_COPY[type] || PUSH_COPY.evening,
      url,
      tag: `mp-${type}`
    }));
    stmts.markPushSent.run(type, row.id);
    console.log('Push notification sent', { userId: row.id, type });
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      stmts.updatePushSub.run(null, row.id);
      console.warn('Push subscription expired, cleared for user', row.id);
    } else {
      console.error('Push notification failed', { userId: row.id, type, reason: e && e.message ? e.message : e });
    }
    return false;
  }
}

function lastActiveHours(row) {
  if (!row || !row.last_active_date) return Infinity;
  const last = new Date(`${row.last_active_date}T00:00:00+05:30`).getTime();
  if (Number.isNaN(last)) return Infinity;
  return Math.max(0, (Date.now() - last) / 36e5);
}

async function sendMorningPushReminders() {
  const rows = stmts.getAllPushUsers.all();
  let sent = 0;
  for (const row of rows) {
    const prefs = parsePushPreferences(row.push_preferences);
    if (!prefs.enabled || !prefs.morningReminder) continue;
    if (await sendGentlePush(row, 'morning', PUSH_COPY.morning)) sent++;
  }
  console.log(`  -> Morning push reminders sent: ${sent}`);
}

async function sendSilentRoomPushReminders() {
  const rows = stmts.getAllPushUsers.all();
  let sent = 0;
  for (const row of rows) {
    const prefs = parsePushPreferences(row.push_preferences);
    if (!prefs.enabled || !prefs.silentRoomReminder) continue;
    if (await sendGentlePush(row, 'silent_room', PUSH_COPY.silent_room, '/app#silent-room')) sent++;
  }
  console.log(`  -> Silent Room push reminders sent: ${sent}`);
}

async function sendInactivePushReminders(hours, type) {
  const rows = stmts.getAllPushUsers.all();
  let sent = 0;
  for (const row of rows) {
    const prefs = parsePushPreferences(row.push_preferences);
    if (!prefs.enabled || !prefs.streakReminder || lastActiveHours(row) < hours) continue;
    if (await sendGentlePush(row, type, PUSH_COPY[type])) sent++;
  }
  console.log(`  -> ${hours}h inactive push reminders sent: ${sent}`);
}

// Admin broadcast — send a message to every saved push subscription.
// Mirrors sendGentlePush's dead-subscription cleanup (invalid JSON + 404/410).
async function broadcastPush(message) {
  if (!vapidKeys) return { ok: false, error: 'Push not configured', sent: 0, failed: 0, total: 0 };
  const rows = stmts.getAllPushUsers.all();
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    let subscription;
    try {
      subscription = JSON.parse(row.push_subscription);
    } catch (e) {
      stmts.updatePushSub.run(null, row.id);
      console.warn('Push subscription invalid, cleared for user', row.id);
      failed++;
      continue;
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: 'Mentally Prepare',
        body: message,
        url: '/app',
        tag: 'mp-broadcast'
      }));
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        stmts.updatePushSub.run(null, row.id);
        console.warn('Push subscription expired, cleared for user', row.id);
      } else {
        console.error('Broadcast push failed', { userId: row.id, reason: e && e.message ? e.message : e });
      }
      failed++;
    }
  }
  return { ok: true, sent, failed, total: rows.length };
}

function send9pmReminders() {
  const rows = stmts.getActiveMatchUsers.all();
  for (const row of rows) {
    const day = getMatchDay(row.started_at);
    if (day > 21) continue;
    // Only send if user hasn't written today
    const match = stmts.getMatch.get(row.id, row.id);
    if (!match) continue;
    const todayEntry = stmts.getEntry.get(row.id, match.id, day);
    if (!todayEntry) {
      const user = parseUser(stmts.getUserById.get(row.id));
      if (user) {
        sendDailyPromptReminder(user.email, user.name, day).catch(err => console.error('Failed to send daily prompt reminder', err));
      }
      const prefs = parsePushPreferences(row.push_preferences);
      if (prefs.enabled && (prefs.dailyReflection || prefs.eveningReminder)) {
        sendGentlePush(row, 'daily_reflection', PUSH_COPY.daily_reflection).catch(() => {});
      }
    }
  }
  console.log('  ✦ 9pm: Queued prompt email and push reminders');
}

// 10pm IST = 16:30 UTC — conditional "partner wrote" notification
function send10pmReminders() {
  // Rotate copy per night so the nudge never feels mechanical.
  const tenPmCopy = [
    "your person wrote today. you haven't. entries seal at midnight.",
    "they showed up today. the page is still blank on your side.",
    "it's 10pm. your match is waiting to be read."
  ];
  const body = tenPmCopy[Math.floor(Math.random() * tenPmCopy.length)];
  const rows = stmts.getActiveMatchUsers.all();
  for (const row of rows) {
    const day = getMatchDay(row.started_at);
    if (day > 21) continue;
    const match = stmts.getMatch.get(row.id, row.id);
    if (!match) continue;
    const todayEntry = stmts.getEntry.get(row.id, match.id, day);
    if (todayEntry) continue; // already wrote

    const partnerId = getPartnerId(match, row.id);
    const partnerEntry = stmts.getEntry.get(partnerId, match.id, day);
    if (partnerEntry) {
      const user = parseUser(stmts.getUserById.get(row.id));
      const partner = parseUser(stmts.getUserById.get(partnerId));
      if (user && partner) {
        sendPartnerWroteReminder(user.email, user.name, partner.name, day).catch(err => console.error('Failed to send partner wrote reminder', err));
      }
      const prefs = parsePushPreferences(row.push_preferences);
      if (prefs.enabled && prefs.eveningReminder) {
        sendGentlePush(row, 'partner_waiting', body).catch(() => {});
      }
    }
  }
  console.log('  ✦ 10pm: Queued partner-wrote email and push reminders');
}

function sendQuietPartnerNudges() {
  const rows = stmts.getActiveMatchUsers.all();
  let sent = 0;
  for (const row of rows) {
    const day = getMatchDay(row.started_at);
    if (day < 3 || day > 21) continue;
    const match = stmts.getMatch.get(row.id, row.id);
    if (!match) continue;
    const partnerId = getPartnerId(match, row.id);

    // Safety: skip if block, report, or rematch exists on this match
    if (stmts.hasBlockReportRematch.get(row.id, row.id, match.id, match.id, match.id)) continue;

    // Check: user missed last 2 days
    const userYesterday = stmts.getEntry.get(row.id, match.id, day - 1);
    const userToday = stmts.getEntry.get(row.id, match.id, day);
    if (userYesterday || userToday) continue;

    // Check: partner wrote at least one of those days
    const partnerYesterday = stmts.getEntry.get(partnerId, match.id, day - 1);
    const partnerToday = stmts.getEntry.get(partnerId, match.id, day);
    if (!partnerYesterday && !partnerToday) continue;

    // Dedup: one nudge per quiet spell (cleared when user seals an entry)
    if (stmts.getGhostNudge.get(row.id, match.id)) continue;

    const user = parseUser(stmts.getUserById.get(row.id));
    if (!user) continue;

    stmts.insertNudge.run(row.id, match.id, 'partner_still_writing', 'your partner is still writing. one honest line is enough.');
    sendPartnerStillWriting(user.email, user.name).catch(err => console.error('Ghost nudge email failed', err));
    const prefs = parsePushPreferences(row.push_preferences);
    if (prefs.enabled && prefs.eveningReminder) {
      sendGentlePush(row, 'partner_still_writing', 'your partner is still writing. one honest line is enough.').catch(() => {});
    }
    sent++;
  }
  console.log(`  ✦ Ghost nudge: sent ${sent} quiet-partner nudges`);
}

// Midnight IST = 18:30 UTC — unseal partner entry + note generation
function sendMidnightUnseals() {
  generateDailyNotesForAll();
  for (const row of stmts.getAllPushUsers.all()) {
    const prefs = parsePushPreferences(row.push_preferences);
    if (prefs.enabled && prefs.dailyReflection) {
      sendGentlePush(row, 'daily_prompt_unlocked', PUSH_COPY.daily_prompt_unlocked).catch(() => {});
    }
  }
  console.log('  ✦ Midnight: Generated daily notes');
}

// Schedule all notification slots using node-cron
function scheduleNotifications() {
  // 8:30 AM IST is 03:00 UTC
  cron.schedule('0 3 * * *', () => {
    console.log('Running morning push reminders...');
    sendMorningPushReminders();
  });

  // 9 PM IST is 15:30 UTC
  cron.schedule('30 15 * * *', () => {
    console.log('Running 9pm Reminders...');
    send9pmReminders();
    sendQuietPartnerNudges();
  });

  // 10 PM IST is 16:30 UTC
  cron.schedule('30 16 * * *', () => {
    console.log('Running 10pm Reminders...');
    send10pmReminders();
  });

  // Midnight IST is 18:30 UTC
  cron.schedule('30 18 * * *', () => {
    console.log('Running Midnight Tasks...');
    sendMidnightUnseals();
  });

  // 10:30 PM IST is 17:00 UTC
  cron.schedule('0 17 * * *', () => {
    console.log('Running Silent Room push reminders...');
    sendSilentRoomPushReminders();
  });

  // 11:00 AM IST is 05:30 UTC
  cron.schedule('30 5 * * *', () => {
    console.log('Running inactive push reminders...');
    sendInactivePushReminders(24, 'inactive_24');
    sendInactivePushReminders(48, 'inactive_48');
  });

  // 4:00 AM IST is 22:30 UTC — daily DB backup
  cron.schedule('30 22 * * *', () => {
    console.log('Running daily DB backup...');
    runBackup().then(r => console.log('Backup:', r.ok ? 'success' : 'failed', r.local || '')).catch(e => console.error('Backup error:', e.message));
  });

  console.log('  ✦ Cron schedules loaded for email and push reminders');
  console.log('  ✦ Daily DB backup scheduled (4am IST)');
}
scheduleNotifications();

// Generate notes for current day on startup (for users who already have a match)
setTimeout(() => {
  try { generateDailyNotesForAll(); } catch (e) { console.error('Note generation startup error:', e); }
}, 5000);

// --- Duplicate /privacy, /terms, /admin routes removed ---
// These are handled by registerStaticRoutes() and registerAdminRoutes()

// ---------------------------------------
// EMAIL REMINDER SIGNUP
// ---------------------------------------
app.post('/api/reminder-signup', apiLimiter, (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const emailClean = email.trim().toLowerCase();
    const existingSignup = stmts.getReminderSignupByEmail.get(emailClean);
    if (existingSignup) {
      return res.status(409).json({ error: 'Already signed up' });
    }
    stmts.insertReminderSignup.run(emailClean);

    // Send welcome reminder when an SMTP provider is configured. Signup is saved
    // either way so reminders never block users.
    const { sendEmail } = require('./lib/email');
    const subject = 'Mentally Prepare: Daily Reminder';
    const html = '<p>Welcome. You are signed up for gentle writing reminders from Mentally Prepare.</p><p>Take two quiet minutes today when you are ready.</p>';
    sendEmail(emailClean, subject, html)
      .then(() => {
        console.log('Sent welcome reminder to', emailClean);
      })
      .catch((err) => {
        console.warn('Welcome reminder email skipped:', err.message || err);
      });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save email' });
  }
});

function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const rawHeader = req.headers['x-admin-password'] || req.headers['x-admin-key'];
  const supplied = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!adminPassword || typeof supplied !== 'string' || !supplied) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Timing-safe comparison: hash both to fixed-length buffers so timingSafeEqual
  // never throws on length mismatch.
  const expectedHash = crypto.createHash('sha256').update(String(adminPassword)).digest();
  const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
  if (!crypto.timingSafeEqual(expectedHash, suppliedHash)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function getAdminStats() {
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE COALESCE(account_status, 'active') != 'deleted'").get().c;
  const verifiedUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE email_verified = 1 AND COALESCE(account_status, 'active') != 'deleted'").get().c;
  const activeMatches = db.prepare('SELECT COUNT(*) as c FROM matches').get().c;
  const blockedUsers = db.prepare('SELECT COUNT(*) as c FROM blocked_users').get().c;
  const rematchRequests = db.prepare("SELECT COUNT(*) as c FROM rematch_requests WHERE status = 'open'").get().c;
  const crisisTriggers = db.prepare('SELECT COUNT(*) as c FROM crisis_review').get().c;
  const failedEmailSends = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event_name = 'email_send_failed'").get().c;
  const signupErrors = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event_name = 'signup_error'").get().c;
  const entriesToday = db.prepare(`
    SELECT COUNT(*) as c
    FROM entries
    WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')
  `).get().c;
  const openReports = db.prepare("SELECT COUNT(*) as c FROM reports WHERE COALESCE(status, 'open') = 'open'").get().c;
  const reachedDay21 = db.prepare('SELECT started_at FROM matches').all()
    .filter(match => getMatchDay(match.started_at) >= 21).length;
  const bothRevealed = db.prepare(`
    SELECT COUNT(*) as c
    FROM (
      SELECT match_id
      FROM reveals
      WHERE choice IN ('first_name', 'name_college', 'contact_details')
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
    WHERE m.id IS NULL AND u.archetype IS NOT NULL AND COALESCE(u.account_status, 'active') != 'deleted'
    ORDER BY u.created_at ASC
  `).all().map(user => ({
    ...user,
    waitDays: Math.max(Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000), 0)
  }));

  return {
    totalUsers,
    verifiedUsers,
    activeMatches,
    waitingForMatch: waitingUsers.length,
    entriesToday,
    reachedDay21,
    bothRevealed,
    openReports,
    crisisTriggers,
    blockedUsers,
    rematchRequests,
    failedEmailSends,
    signupErrors,
    archetypes,
    waitingUsers
  };
}

registerAdminRoutes(app, {
  rootDir: __dirname,
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
  attemptMatch,
  broadcastPush
});

registerWaitlistRoutes(app, {
  apiLimiter,
  db,
  requireAdmin,
  sendWaitlistConfirmation
});

registerStaticRoutes(app, {
  baseUrl: BASE_URL,
  rootDir: __dirname
});

// 404 catch-all
// 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Silent Room: hard-delete expired lines daily at 3am IST (21:30 UTC)
(function scheduleSilentCleanup() {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(21, 30, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  setTimeout(() => {
    function doCleanup() {
      try {
        const r = db.prepare(`
          DELETE FROM silent_lines
          WHERE expires_at < datetime('now')
             OR (deleted_at IS NOT NULL AND deleted_at < datetime('now', '-1 day'))
        `).run();
        if (r.changes) console.log(`  ✦ Silent Room: deleted ${r.changes} expired lines`);
      } catch (e) { console.error('Silent cleanup error:', e); }
    }
    doCleanup();
    setInterval(doCleanup, 24 * 60 * 60 * 1000);
  }, target.getTime() - now.getTime());
  console.log(`  ✦ Silent Room cleanup scheduled (3am IST daily)`);
})();

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
if (SENTRY_ENABLED) {
  // Captures errors thrown inside Express routes. Must come after all routes.
  Sentry.setupExpressErrorHandler(app);
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

