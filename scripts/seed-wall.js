// scripts/seed-wall.js — Seed the anonymous wall with Night 1 posts.
// Run: WALL_ENABLED=true node scripts/seed-wall.js

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

const SEED_POSTS = [
  "Everyone thinks I have it together because I answer fast in class. I just talk before the panic catches up to me.",
  "I haven't told my parents I changed my mind about the degree. Every call I pretend I'm still sure.",
  "I smile in the group photos and then don't open the chat for three days. Nobody's noticed yet.",
  "My roommate is asleep and I've been staring at the ceiling doing the math on how behind I am again.",
  "I keep a folder of texts I typed out to friends and never sent. It felt safer to keep them than to risk the silence.",
  'Everyone back home thinks I\'m the one who "made it out." I don\'t have the heart to tell them I cry in the library bathroom.',
  "I'm not sad exactly. I just feel like I'm watching my own life through a window most days.",
  "I said I was fine so many times today that I almost believed it. Almost.",
  "The thing I'm carrying is a number — a CGPA — and somewhere it stopped being a grade and became whether I'm allowed to feel okay.",
  "I miss my mom's cooking but if I call her she'll hear it in my voice, so I just don't call.",
  "I act like the breakup didn't touch me. I still take the long way so I don't pass the chai spot we used to go to.",
  "Everyone around me seems to have found their group. I keep wondering what they all figured out that I missed.",
  "I work hard so nobody asks how I'm actually doing. So far it's working, which is the worst part.",
  "I haven't really slept in a week and I've started treating that as normal. I don't think it's normal.",
  "My parents sacrificed a lot to send me here. Some nights that love feels exactly like a weight on my chest.",
  "I'm scared that this — the tiredness, the pretending — is just what being an adult is, and it doesn't get lighter.",
  "I got the thing I wanted and I still felt nothing. I didn't know who to even say that to.",
  "Honestly? I just wanted to see if anyone else out there feels like this too. That's the whole reason I'm here tonight.",
];

// Check wall_questions table exists
try {
  db.prepare('SELECT 1 FROM wall_questions LIMIT 1').get();
} catch (e) {
  console.error('wall_questions table does not exist. Start the server with WALL_ENABLED=true first.');
  process.exit(1);
}

// Ensure a system/founder user exists for seeding
let founderUser = db.prepare("SELECT id FROM users WHERE email = 'founder@mentallyprepare.app'").get();
if (!founderUser) {
  console.log('Creating founder seed account...');
  const info = db.prepare(
    "INSERT INTO users (name, email, password, college, year, consent_given, consent_date) VALUES ('Mentally Prepare', 'founder@mentallyprepare.app', '', 'System', 'N/A', 1, datetime('now'))"
  ).run();
  founderUser = { id: info.lastInsertRowid };
}

const question = db.prepare('SELECT id FROM wall_questions WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
if (!question) {
  console.error('No active wall question found.');
  process.exit(1);
}

// Clear existing seed posts for this question
db.prepare('DELETE FROM wall_posts WHERE question_id = ? AND is_seed = 1').run(question.id);

const insert = db.prepare(`
  INSERT INTO wall_posts (question_id, user_id, content, match_opt_in, is_seed, flagged, expire_at, created_at)
  VALUES (?, ?, ?, 0, 1, 0, datetime('now', ?, '+36 hours'), datetime('now', ?))
`);

const seed = db.transaction(() => {
  SEED_POSTS.forEach((content, i) => {
    const hoursAgo = Math.round((SEED_POSTS.length - i) * 0.6 * 10) / 10;
    const offset = '-' + hoursAgo + ' hours';
    insert.run(question.id, founderUser.id, content, offset, offset);
  });
});

seed();
console.log('Seeded ' + SEED_POSTS.length + ' posts for wall question #' + question.id);
process.exit(0);
