// scripts/seed-rooms.js — Seed each room with warm starter cards.
// Run: ROOMS_ENABLED=true node scripts/seed-rooms.js
// Start the server once with ROOMS_ENABLED=true first so the tables exist.

require('dotenv').config({ quiet: true });

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const IS_PROD = process.env.NODE_ENV === 'production';
const FALLBACK_DATA_DIR = IS_PROD ? '/tmp/mentally-prepare-data' : __dirname + '/..';
const requestedDataDir = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (IS_PROD ? '/data/db' : __dirname + '/..');

let DATA_DIR;
try {
  if (fs.existsSync(requestedDataDir) && fs.statSync(requestedDataDir).isDirectory()) {
    DATA_DIR = requestedDataDir;
  } else {
    DATA_DIR = FALLBACK_DATA_DIR;
  }
} catch (e) {
  DATA_DIR = FALLBACK_DATA_DIR;
}

const dbPath = path.join(DATA_DIR, 'mentally-prepare.db');
console.log('DB path:', dbPath);

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// Starter cards live in their own module (one entry = { support_need, body }).
// support_need is one of: listen, think, share, encourage, quiet
const SEED_CARDS = require('./rooms-seed-cards');

// Openers should not all fade on day one — give them a far-out expiry.
// (Re-run this script to refresh them; it clears is_seed = 1 first.)
const SEED_EXPIRES = "+365 days";

// Tables must exist
try {
  db.prepare('SELECT 1 FROM rooms LIMIT 1').get();
  db.prepare('SELECT 1 FROM room_cards LIMIT 1').get();
} catch (e) {
  console.error('rooms tables do not exist. Start the server with ROOMS_ENABLED=true first.');
  process.exit(1);
}

// Ensure rooms exist (the server seeds these, but be safe for a fresh DB)
const ensureRoom = db.prepare('INSERT OR IGNORE INTO rooms (slug, name, subtitle) VALUES (?, ?, ?)');
ensureRoom.run('night', 'Night Thoughts', 'for racing thoughts that get loud after dark');
ensureRoom.run('studies', 'Studies', 'exams, pressure, the fear of falling behind');
ensureRoom.run('lonely', 'Loneliness', 'feeling alone, even with people around');

// Founder/system account for seed authorship
let founderUser = db.prepare("SELECT id FROM users WHERE email = 'founder@mentallyprepare.app'").get();
if (!founderUser) {
  console.log('Creating founder seed account...');
  const info = db.prepare(
    "INSERT INTO users (name, email, password, college, year, consent_given, consent_date) VALUES ('Mentally Prepare', 'founder@mentallyprepare.app', '', 'System', 'N/A', 1, datetime('now'))"
  ).run();
  founderUser = { id: info.lastInsertRowid };
}

const getRoom = db.prepare('SELECT id FROM rooms WHERE slug = ?');
const clearSeed = db.prepare('DELETE FROM room_cards WHERE room_id = ? AND is_seed = 1');
const insertCard = db.prepare(`
  INSERT INTO room_cards (room_id, author_id, support_need, body, is_held, is_seed, created_at, expires_at)
  VALUES (?, ?, ?, ?, 0, 1, datetime('now', ?), datetime('now', ?))
`);

let total = 0;
const seed = db.transaction(() => {
  for (const [slug, cards] of Object.entries(SEED_CARDS)) {
    const room = getRoom.get(slug);
    if (!room) { console.warn('Missing room:', slug); continue; }
    clearSeed.run(room.id);
    cards.forEach((card, i) => {
      const need = card.support_need;
      const body = card.body;
      if (!need || !body) { console.warn('Skipping malformed seed card in', slug, 'at index', i); return; }
      // Stagger creation so the wall looks lived-in: array order = display order
      // (newest first), so index 0 sits at the top.
      const minutesAgo = i * 5;
      const createdOffset = '-' + minutesAgo + ' minutes';
      insertCard.run(room.id, founderUser.id, need, body, createdOffset, SEED_EXPIRES);
      total++;
    });
  }
});

seed();
console.log('Seeded ' + total + ' starter cards across ' + Object.keys(SEED_CARDS).length + ' rooms.');
process.exit(0);
