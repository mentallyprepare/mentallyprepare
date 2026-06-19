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

// support_need is one of: listen, think, share, encourage, quiet
const SEED_CARDS = {
  night: [
    ['listen', "It's 2am and my brain decided now is the time to replay every awkward thing I've ever said."],
    ['share', "Anyone else lie in the dark doing the math on how behind they are, then get up more tired than before?"],
    ['quiet', "I don't need advice tonight. I just didn't want to be the only one awake with this."],
    ['encourage', "Trying to convince myself that the thoughts feel huge because it's dark, not because they're true."],
    ['think', "Why does everything I'm scared of feel solvable at noon and impossible at midnight?"],
  ],
  studies: [
    ['listen', "Failed a paper I studied weeks for. I keep refreshing the result like the number will change."],
    ['encourage', "Everyone in my batch seems three steps ahead and I can't tell if that's real or just the panic talking."],
    ['share', "I work hard mostly so nobody asks how I'm actually doing. So far it's working, which is the worst part."],
    ['think', "Somewhere my CGPA stopped being a grade and became whether I'm allowed to feel okay. Not sure when that happened."],
    ['quiet', "Just need to put this down somewhere: I'm so tired of being scared of falling behind."],
  ],
  lonely: [
    ['listen', "I'm surrounded by people all day and still feel like I'm watching my own life through a window."],
    ['share', "Everyone here found their group already. I keep wondering what they figured out that I missed."],
    ['encourage', "Moved cities for college and I haven't had a real conversation in days. Telling myself it gets easier."],
    ['quiet', "I miss my mom's cooking, but if I call she'll hear it in my voice. So I just don't call."],
    ['think', "Is it normal to feel lonelier in a crowded room than when you're actually alone?"],
  ],
};

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
  VALUES (?, ?, ?, ?, 0, 1, datetime('now', ?), datetime('now', ?, '+12 hours'))
`);

let total = 0;
const seed = db.transaction(() => {
  for (const [slug, cards] of Object.entries(SEED_CARDS)) {
    const room = getRoom.get(slug);
    if (!room) { console.warn('Missing room:', slug); continue; }
    clearSeed.run(room.id);
    cards.forEach(([need, body], i) => {
      // Stagger creation times so the wall looks lived-in (and TTL is fresh).
      const minutesAgo = (cards.length - i) * 7;
      const offset = '-' + minutesAgo + ' minutes';
      insertCard.run(room.id, founderUser.id, need, body, offset, offset);
      total++;
    });
  }
});

seed();
console.log('Seeded ' + total + ' starter cards across ' + Object.keys(SEED_CARDS).length + ' rooms.');
process.exit(0);
