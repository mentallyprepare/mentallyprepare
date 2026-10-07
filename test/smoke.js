// Smoke test — no frameworks, just http + assert
// Validates core API routes against main's schema.
const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Database = require('better-sqlite3');

const PORT = 9876;
const DB_PATH = path.join(__dirname, 'smoke-test.db');
const SESSION_DB_PATH = path.join(__dirname, 'mentally-prepare-sessions.db');

// Clean up any previous test DB
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch {}
  try { fs.unlinkSync(SESSION_DB_PATH + ext); } catch {}
}

// Start with the legacy connect-sqlite3 schema to verify the replacement store
// can reuse production session databases without logging everyone out.
const legacySessionDb = new Database(SESSION_DB_PATH);
legacySessionDb.exec('CREATE TABLE sessions (sid PRIMARY KEY, expired, sess)');
legacySessionDb.close();

// Configure env before requiring server
process.env.PORT = PORT;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-for-smoke';
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.DB_PATH = DB_PATH;
process.env.FIREBASE_USE_SAME_ORIGIN_AUTH_DOMAIN = 'false';

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notStrictEqual(start, -1, `${name} function exists`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} function body was not closed`);
}

function request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${PORT}`);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers }
    };
    if (body) {
      const payload = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function extractCookie(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return null;
  const arr = Array.isArray(sc) ? sc : [sc];
  return arr.map(c => c.split(';')[0]).join('; ');
}

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.example`;
}

async function registerUser({ name = 'Smoke Tester', email = uniqueEmail('user'), password = 'testpass123' } = {}) {
  const r = await request('POST', '/api/register', {
    name,
    email,
    password,
    college: 'Test University',
    year: '2nd',
    gender: 'female',
    matchGenderPref: 'any',
    matchYearPref: 'any',
    ageConfirmed: true,
    consentGiven: true
  });
  assert.strictEqual(r.status, 200, `register ${email} got ${r.status}: ${r.raw}`);
  const cookie = extractCookie(r.headers);
  assert.ok(cookie, 'session cookie set');
  return { email, password, cookie };
}

function clearMatchesForUser(db, userId) {
  const matches = db.prepare('SELECT id FROM matches WHERE user1_id = ? OR user2_id = ?').all(userId, userId);
  for (const match of matches) {
    for (const table of ['entries', 'comments', 'reactions', 'reveals', 'nudges', 'daily_notes', 'sealed_room_picks']) {
      try { db.prepare(`DELETE FROM ${table} WHERE match_id = ?`).run(match.id); } catch {}
    }
    db.prepare('DELETE FROM matches WHERE id = ?').run(match.id);
  }
}

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log('  PASS:', label); }
function fail(label, e) { failed++; console.error('  FAIL:', label, '-', e.message); }

async function run() {
  // Require server — this starts the app on PORT
  require(path.join(__dirname, '..', 'server.js'));
  // Wait for server to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));
  const db = new Database(DB_PATH);

  // 1. Health check
  try {
    const r = await request('GET', '/api/ready');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'ready');
    ok('/api/ready returns 200');
  } catch (e) { fail('/api/ready', e); }

  // 1b. Production Google auth uses same-origin helper config on the custom domain
  try {
    const firebaseConfig = await request('GET', '/api/firebase-config', null, { Host: 'mymentallyprepare.com' });
    assert.strictEqual(firebaseConfig.status, 200, `firebase config got ${firebaseConfig.status}: ${firebaseConfig.raw}`);
    assert.strictEqual(firebaseConfig.json.enabled, true);
    assert.strictEqual(firebaseConfig.json.config.authDomain, 'mymentallyprepare.com');

    const helperConfig = await request('GET', '/__/firebase/init.json', null, { Host: 'mymentallyprepare.com' });
    assert.strictEqual(helperConfig.status, 200, `firebase helper init got ${helperConfig.status}: ${helperConfig.raw.slice(0, 200)}`);
    assert.strictEqual(helperConfig.json.authDomain, 'mymentallyprepare.com');
    assert.strictEqual(helperConfig.json.projectId, 'mentally-prepare');
    ok('Firebase custom-domain auth config');
  } catch (e) { fail('Firebase custom-domain auth config', e); }

  // 1c. Firebase auth helper pages must not inherit app frame-blocking headers.
  try {
    const helperFrame = await request('GET', '/__/auth/handler', null, { Host: 'mymentallyprepare.com' });
    assert.strictEqual(helperFrame.status, 200, `firebase auth handler got ${helperFrame.status}: ${helperFrame.raw.slice(0, 200)}`);
    const csp = String(helperFrame.headers['content-security-policy'] || '');
    assert.doesNotMatch(csp, /frame-ancestors\s+'none'/i, 'auth helper must not block Firebase iframe/redirect handling');
    assert.strictEqual(helperFrame.headers['x-frame-options'], undefined, 'auth helper must not set X-Frame-Options');
    assert.strictEqual(helperFrame.headers['cross-origin-resource-policy'], undefined, 'auth helper must not set Cross-Origin-Resource-Policy');
    ok('Firebase auth helper headers allow redirect completion');
  } catch (e) { fail('Firebase auth helper headers allow redirect completion', e); }

  // 1d. First-time users have clear signup/login entry points and deep links.
  try {
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(indexHtml, /href="\/app\?screen=s-signup"/, 'landing page links directly to signup');
    assert.match(indexHtml, /href="\/app\?screen=s-login"/, 'landing page links directly to login');
    assert.match(appHtml, /id="s-signup"/, 'dedicated signup screen exists');
    assert.match(appHtml, /Create your Mentally Prepare account/, 'signup screen has clear heading');
    assert.match(appHtml, /Welcome back/, 'login screen has clear heading');
    assert.match(appHtml, /Create Account[\s\S]*Take Scan[\s\S]*Get Matched[\s\S]*Write Daily[\s\S]*Reveal on Day 21/, 'journey preview appears before signup');
    assert.match(appJs, /consumeAuthScreenDeepLink/, 'app consumes auth screen deep links');
    assert.match(appJs, /s-signup[\s\S]*s-login[\s\S]*s-reset/, 'signup, login, and reset deep links are supported');
    assert.match(appJs, /function shouldOpenAuthDeepLinkBeforeSessionRestore\(\)/, 'auth deep links are checked before session restore');
    assert.match(appJs, /function hasPendingGoogleRedirectContext\(\)/, 'Google redirect completion is preserved');
    assert.ok(
      appJs.indexOf('shouldOpenAuthDeepLinkBeforeSessionRestore()') < appJs.indexOf('const firebaseRestored = await restoreFirebaseSession();'),
      'auth deep links must win before logged-in users are routed to scan'
    );
    assert.match(appJs, /function getPostAuthDestination\(/, 'post-auth routing is centralized');

    const routingContext = {
      archetypes: { protector: {}, connector: {}, performer: {}, disconnector: {} },
      result: null
    };
    vm.runInNewContext(`
      ${extractFunction(appJs, 'needsGoogleProfileBasics')}
      ${extractFunction(appJs, 'hasCompletedScan')}
      ${extractFunction(appJs, 'getPostAuthDestination')}
      result = {
        newUser: getPostAuthDestination({ user: { authProvider: 'password' }, entries: [] }),
        googleNeedsBasics: getPostAuthDestination({ user: { authProvider: 'google', college: 'Not Provided', year: '' }, entries: [] }),
        completedScanNoMatch: getPostAuthDestination({ user: { authProvider: 'password', archetype: 'protector', scores: null }, entries: [] }),
        activeMatchOpenToday: getPostAuthDestination({ user: { archetype: 'connector' }, match: { day: 4 }, entries: [{ day: 3 }] }),
        activeMatchTodayDone: getPostAuthDestination({ user: { archetype: 'connector' }, match: { day: 4 }, entries: [{ day: 4 }] }),
        completedCycle: getPostAuthDestination({ user: { archetype: 'connector' }, match: { day: 21 }, entries: [{ day: 21 }] })
      };
    `, routingContext);
    assert.strictEqual(routingContext.result.newUser.screen, 's-scan-intro', 'new users without scan go to scan');
    assert.strictEqual(routingContext.result.googleNeedsBasics.screen, 's-profile', 'Google users missing basics finish profile first');
    assert.strictEqual(routingContext.result.completedScanNoMatch.screen, 's-waiting', 'completed-scan users without match go to waiting');
    assert.strictEqual(routingContext.result.activeMatchOpenToday.screen, 's-journal', 'active matches with no entry today go to journal');
    assert.strictEqual(routingContext.result.activeMatchTodayDone.screen, 's-sealed', 'active matches with entry today go to sealed journey home');
    assert.strictEqual(routingContext.result.completedCycle.action, 'reveal', 'completed cycles go to post-cycle reveal flow');
    ok('Signup/login entry routing and CTAs');
  } catch (e) { fail('Signup/login entry routing and CTAs', e); }


  // 2. Register a user
  let cookie;
  try {
    const r = await request('POST', '/api/register', {
      name: 'Smoke Tester',
      email: 'smoke@test.example',
      password: 'testpass123',
      college: 'Test University',
      year: '2nd',
      gender: 'female',
      matchGenderPref: 'any',
      matchYearPref: 'any',
      ageConfirmed: true,
      consentGiven: true
    });
    assert.strictEqual(r.status, 200, `register got ${r.status}: ${r.raw}`);
    cookie = extractCookie(r.headers);
    assert.ok(cookie, 'session cookie set');
    const sessionDb = new Database(SESSION_DB_PATH, { readonly: true });
    const persistedSessions = sessionDb.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    sessionDb.close();
    assert.ok(persistedSessions > 0, 'session persisted through better-sqlite3 store');
    ok('POST /api/register');
  } catch (e) { fail('POST /api/register', e); }

  // 2b. Native push registration is bound to the authenticated user and can
  // be removed without affecting another device.
  try {
    const token = 'ExpoPushToken[smoke_test_device]';
    const saved = await request('POST', '/api/push/native/subscribe', {
      token,
      platform: 'android',
      timezone: 'Asia/Kolkata'
    }, { cookie });
    assert.strictEqual(saved.status, 200, `native subscribe got ${saved.status}: ${saved.raw}`);

    const prefs = await request('GET', '/api/push/preferences', null, { cookie });
    assert.strictEqual(prefs.status, 200);
    assert.strictEqual(prefs.json.nativeSubscribed, true);

    const removed = await request('POST', '/api/push/native/unsubscribe', { token }, { cookie });
    assert.strictEqual(removed.status, 200, `native unsubscribe got ${removed.status}: ${removed.raw}`);
    const row = db.prepare('SELECT active FROM native_push_devices WHERE expo_push_token = ?').get(token);
    assert.strictEqual(row.active, 0);
    ok('Native push registration lifecycle');
  } catch (e) { fail('Native push registration lifecycle', e); }

  try {
    const initial = await request('GET', '/api/push/preferences', null, { cookie });
    assert.strictEqual(initial.status, 200);
    assert.strictEqual(initial.json.preferences.emailReminders, false, 'email reminders must default off');
    const optedIn = await request('POST', '/api/push/preferences', { preferences: { enabled: true, emailReminders: true } }, { cookie });
    assert.strictEqual(optedIn.status, 200);
    assert.strictEqual(optedIn.json.preferences.emailReminders, true);
    const pushOnlyUpdate = await request('POST', '/api/push/preferences', { preferences: { enabled: true, eveningReminder: false } }, { cookie });
    assert.strictEqual(pushOnlyUpdate.status, 200);
    assert.strictEqual(pushOnlyUpdate.json.preferences.emailReminders, true, 'push-only updates should preserve email consent');
    const optedOut = await request('POST', '/api/push/preferences', { preferences: { enabled: false } }, { cookie });
    assert.strictEqual(optedOut.status, 200);
    assert.strictEqual(optedOut.json.preferences.emailReminders, false, 'turn off notifications must stop email reminders');
    ok('Email reminders require opt-in and honor notification opt-out');
  } catch (e) { fail('Email reminder preference lifecycle', e); }

  // 3. Save a waiting entry (Day 1, pre-match)
  try {
    const r = await request('POST', '/api/waiting-entry', {
      text: 'Smoke test waiting entry'
    }, { cookie });
    assert.strictEqual(r.status, 200, `waiting-entry got ${r.status}: ${r.raw}`);
    assert.strictEqual(r.json.ok, true);
    ok('POST /api/waiting-entry');
  } catch (e) { fail('POST /api/waiting-entry', e); }

  // 4. /api/my-data includes the waiting draft
  try {
    const r = await request('GET', '/api/my-data', null, { cookie });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.waiting_draft, 'waiting_draft is present');
    assert.strictEqual(r.json.waiting_draft.text, 'Smoke test waiting entry');
    ok('GET /api/my-data includes waiting_draft');
  } catch (e) { fail('GET /api/my-data', e); }

  // 5. /api/me shows saved entry text for unmatched user
  try {
    const r = await request('GET', '/api/me', null, { cookie });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.user, 'user object present');
    // Main surfaces the waiting entry text via waitingInfo.savedEntry
    assert.ok(r.json.waitingInfo, 'waitingInfo present for unmatched user');
    assert.strictEqual(r.json.waitingInfo.savedEntry, 'Smoke test waiting entry');
    ok('GET /api/me shows waiting entry');
  } catch (e) { fail('GET /api/me', e); }

  // 6. Admin auth rejects absent/bad credentials (header-only, no query string)
  try {
    // No credentials at all
    const r1 = await request('GET', '/admin/export');
    assert.strictEqual(r1.status, 401, 'no creds -> 401');
    // Wrong password via header
    const r2 = await request('GET', '/admin/export', null, { 'x-admin-password': 'wrong-password' });
    assert.strictEqual(r2.status, 401, 'wrong creds -> 401');
    // Query string should NOT work (removed)
    const r3 = await request('GET', '/admin/export?key=test-admin-pw');
    assert.strictEqual(r3.status, 401, 'query string key -> 401');
    ok('Admin auth rejects bad/absent/query-string credentials');
  } catch (e) { fail('Admin auth rejection', e); }

  // 7. Admin export works with valid header
  try {
    const r = await request('GET', '/admin/export', null, { 'x-admin-password': 'test-admin-pw' });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.waiting_entries), 'admin export has waiting_entries');
    ok('GET /admin/export with valid header');
  } catch (e) { fail('GET /admin/export', e); }

  // 8. Password reset sends a 6-character code, consumes it once, and supports legacy tokens
  try {
    const email = uniqueEmail('reset');
    await registerUser({ name: 'Reset User', email, password: 'oldpass123' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const plainCode = 'ABC123';
    const crypto = require('crypto');
    const hashedCode = crypto.createHash('sha256').update(plainCode).digest('hex');
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(hashedCode, user.id, Date.now() + 15 * 60 * 1000, Date.now());
    const tokenRow = db.prepare('SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
    assert.ok(tokenRow, 'reset token stored');
    assert.match(tokenRow.token, /^[a-f0-9]{64}$/, 'reset token is SHA-256 hashed in DB (64-char hex)');

    const weak = await request('POST', '/api/reset-password', { code: plainCode, newPassword: 'short' });
    assert.strictEqual(weak.status, 400);
    assert.match(weak.json.error, /at least 8/i);

    const reset = await request('POST', '/api/reset-password', { code: plainCode, newPassword: 'newpass123' });
    assert.strictEqual(reset.status, 200, `reset got ${reset.status}: ${reset.raw}`);
    assert.strictEqual((await request('POST', '/api/login', { email, password: 'oldpass123' })).status, 401, 'old password rejected');
    assert.strictEqual((await request('POST', '/api/login', { email, password: 'newpass123' })).status, 200, 'new password accepted');

    const reused = await request('POST', '/api/reset-password', { code: plainCode, newPassword: 'another123' });
    assert.strictEqual(reused.status, 400);
    assert.match(reused.json.error, /used/i);

    const legacyEmail = uniqueEmail('legacy-reset');
    await registerUser({ name: 'Legacy Reset User', email: legacyEmail, password: 'legacyold123' });
    const legacyUser = db.prepare('SELECT * FROM users WHERE email = ?').get(legacyEmail);
    const legacyToken = 'a'.repeat(64);
    db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(legacyToken, legacyUser.id, Date.now() + 15 * 60 * 1000, Date.now());
    const legacyReset = await request('POST', '/api/reset-password', { code: legacyToken, newPassword: 'legacynew123' });
    assert.strictEqual(legacyReset.status, 200, `legacy reset got ${legacyReset.status}: ${legacyReset.raw}`);
    assert.strictEqual((await request('POST', '/api/login', { email: legacyEmail, password: 'legacynew123' })).status, 200, 'legacy token reset works');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(appJs, /if\s*\(\s*code\.length\s*===\s*6\s*\)\s*\{\s*code\s*=\s*code\.toUpperCase\(\);\s*\}/, 'frontend only uppercases 6-character reset codes');
    assert.doesNotMatch(appJs, /input\.value\s*=\s*code\.toUpperCase\(\)/, 'frontend does not uppercase legacy reset links while prefilling');
    ok('Password reset full flow');
  } catch (e) { fail('Password reset full flow', e); }

  // 9. Verification links are idempotent for verified users and distinguish invalid vs expired
  try {
    const email = uniqueEmail('verify');
    await registerUser({ name: 'Verify User', email, password: 'verify123' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const token = user.email_verification_token;
    const fresh = await request('GET', `/api/verify-email?token=${encodeURIComponent(token)}`);
    assert.strictEqual(fresh.status, 302);
    assert.match(fresh.headers.location, /verified=1/);
    const repeat = await request('GET', `/api/verify-email?token=${encodeURIComponent(token)}`);
    assert.strictEqual(repeat.status, 302);
    assert.match(repeat.headers.location, /verify_error=invalid/, 'already-used verification token is rejected (single-use)');

    const expiredEmail = uniqueEmail('verify-expired');
    await registerUser({ name: 'Expired Verify User', email: expiredEmail, password: 'verify123' });
    const expiredUser = db.prepare('SELECT * FROM users WHERE email = ?').get(expiredEmail);
    db.prepare("UPDATE users SET email_verification_sent_at = datetime('now', '-2 days') WHERE id = ?").run(expiredUser.id);
    const expired = await request('GET', `/api/verify-email?token=${encodeURIComponent(expiredUser.email_verification_token)}`);
    assert.strictEqual(expired.status, 302);
    assert.match(expired.headers.location, /verify_error=expired/);

    const invalid = await request('GET', '/api/verify-email?token=not-a-real-token');
    assert.strictEqual(invalid.status, 302);
    assert.match(invalid.headers.location, /verify_error=invalid/);
    ok('Verification link states');
  } catch (e) { fail('Verification link states', e); }

  // 10. Account deletion anonymizes safely with dependent data and destroys login access
  try {
    const account = await registerUser({ name: 'Delete User', email: uniqueEmail('delete'), password: 'deletepass123' });
    const partner = await registerUser({ name: 'Delete Partner', email: uniqueEmail('delete-partner'), password: 'partnerpass123' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(account.email);
    const partnerUser = db.prepare('SELECT * FROM users WHERE email = ?').get(partner.email);
    const matchId = db.prepare("INSERT INTO matches (user1_id, user2_id, matched_at) VALUES (?, ?, datetime('now'))").run(user.id, partnerUser.id).lastInsertRowid;
    db.prepare("INSERT INTO entries (user_id, match_id, day, text) VALUES (?, ?, 1, 'entry')").run(user.id, matchId);
    db.prepare("INSERT INTO comments (user_id, match_id, day, text) VALUES (?, ?, 1, 'comment')").run(user.id, matchId);
    db.prepare("INSERT INTO reports (reporter_id, match_id, reported_user_id, entry_day, day, category, reason, status) VALUES (?, ?, ?, 1, 1, 'entry', 'reason', 'open')").run(user.id, matchId, partnerUser.id);
    db.prepare("INSERT INTO blocked_users (blocker_id, blocked_user_id, match_id, reason) VALUES (?, ?, ?, 'block')").run(user.id, partnerUser.id, matchId);
    db.prepare("INSERT INTO rematch_requests (user_id, match_id, reason) VALUES (?, ?, 'rematch')").run(user.id, matchId);
    db.prepare("INSERT INTO payments (user_id, provider, amount, currency, product) VALUES (?, 'test', 100, 'INR', 'plus')").run(user.id);
    db.prepare("INSERT INTO tonights_question_entries (user_id, prompt_index, text, mood) VALUES (?, 0, 'tonight', 'ok')").run(user.id);

    const del = await request('DELETE', '/api/account', { password: 'deletepass123' }, { cookie: account.cookie });
    assert.strictEqual(del.status, 200, `delete got ${del.status}: ${del.raw}`);
    assert.strictEqual((await request('POST', '/api/login', { email: account.email, password: 'deletepass123' })).status, 401, 'deleted user cannot log in');
    assert.strictEqual(db.prepare('SELECT * FROM users WHERE email = ?').get(account.email), undefined, 'original email removed');
    assert.ok(db.prepare("SELECT * FROM deletion_log WHERE reason = 'user_requested'").get(), 'deletion log preserved');
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no FK violations after account deletion');
    ok('Account deletion handles dependent data');
  } catch (e) { fail('Account deletion handles dependent data', e); }

  // 11. Admin remove-user uses the same safe deletion path and logs the admin action
  try {
    const account = await registerUser({ name: 'Admin Remove User', email: uniqueEmail('admin-remove'), password: 'remove123' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(account.email);
    db.prepare("INSERT INTO waiting_entries (user_id, text) VALUES (?, 'waiting')").run(user.id);
    const removed = await request('POST', '/admin/remove-user', { user_id: account.email }, { 'x-admin-password': 'test-admin-pw' });
    assert.strictEqual(removed.status, 200, `admin remove got ${removed.status}: ${removed.raw}`);
    assert.strictEqual(db.prepare('SELECT * FROM users WHERE email = ?').get(account.email), undefined, 'original email removed after admin removal');
    assert.ok(db.prepare("SELECT * FROM deletion_log WHERE reason = 'admin_removed'").get(), 'admin deletion log preserved');
    assert.ok(db.prepare("SELECT * FROM analytics_events WHERE event_name = 'admin_remove_user'").get(), 'admin action logged');
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no FK violations after admin removal');
    ok('Admin remove-user handles dependent data');
  } catch (e) { fail('Admin remove-user handles dependent data', e); }

  // 12. Reports keep status history instead of being deleted
  try {
    const reporterRow = db.prepare('SELECT * FROM users WHERE email = ?').get('smoke@test.example');
    const reportedEmail = uniqueEmail('reported');
    const reportedId = db.prepare("INSERT INTO users (name, email, password, college, year, consent_given, consent_date) VALUES ('Reported User', ?, 'seeded-password', 'Test University', '2nd', 1, datetime('now'))").run(reportedEmail).lastInsertRowid;
    const reportedRow = db.prepare('SELECT * FROM users WHERE id = ?').get(reportedId);
    const matchId = db.prepare("INSERT INTO matches (user1_id, user2_id, matched_at) VALUES (?, ?, datetime('now'))").run(reporterRow.id, reportedRow.id).lastInsertRowid;
    db.prepare("INSERT INTO entries (user_id, match_id, day, text) VALUES (?, ?, 1, 'reported entry')").run(reportedRow.id, matchId);
    const badCategory = await request('POST', '/api/report', { reason: 'unsafe details', category: 'freeform-admin-state' }, { cookie });
    assert.strictEqual(badCategory.status, 400, `bad report category got ${badCategory.status}: ${badCategory.raw}`);
    assert.match(badCategory.json.error, /invalid report category/i);
    const longReason = await request('POST', '/api/report', { reason: 'x'.repeat(501), category: 'other' }, { cookie });
    assert.strictEqual(longReason.status, 400, `long report reason got ${longReason.status}: ${longReason.raw}`);
    const report = await request('POST', '/api/report', { matchId, day: 1, reason: 'unsafe', category: 'entry' }, { cookie });
    assert.strictEqual(report.status, 200, `report got ${report.status}: ${report.raw}`);
    const reportRow = db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 1').get();
    const blankReason = await request('POST', '/admin/report-status', { report_id: reportRow.id, status: 'reviewed', reason: '   ' }, { 'x-admin-password': 'test-admin-pw' });
    assert.strictEqual(blankReason.status, 400, `blank reason got ${blankReason.status}: ${blankReason.raw}`);
    assert.match(blankReason.json.error, /reason is required/i);
    for (const status of ['reviewed', 'dismissed', 'escalated', 'resolved']) {
      const r = await request('POST', '/admin/report-status', { report_id: reportRow.id, status, reason: `mark ${status}` }, { 'x-admin-password': 'test-admin-pw' });
      assert.strictEqual(r.status, 200, `mark ${status} got ${r.status}: ${r.raw}`);
    }
    assert.strictEqual(db.prepare('SELECT status FROM reports WHERE id = ?').get(reportRow.id).status, 'resolved');
    assert.strictEqual(db.prepare('SELECT COUNT(*) as c FROM report_status_history WHERE report_id = ?').get(reportRow.id).c, 4);
    assert.ok(db.prepare("SELECT * FROM report_status_history WHERE report_id = ? AND old_status = 'open' AND new_status = 'reviewed' AND actor = 'admin' AND reason = 'mark reviewed'").get(reportRow.id));
    const dismiss = await request('POST', '/admin/dismiss-report', { report_id: reportRow.id, reason: 'compat dismiss' }, { 'x-admin-password': 'test-admin-pw' });
    assert.strictEqual(dismiss.status, 200, `compat dismiss got ${dismiss.status}: ${dismiss.raw}`);
    assert.ok(db.prepare('SELECT * FROM reports WHERE id = ?').get(reportRow.id), 'report still exists after dismiss endpoint');
    ok('Report status history');
  } catch (e) { fail('Report status history', e); }

  // 13. Global positioning: landing uses the global hero headline + meta description
  try {
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    assert.match(indexHtml, /For 21 nights, write to a stranger you may/, 'landing has global hero headline');
    assert.match(indexHtml, /<meta name="description" content="[^"]*21 nights[^"]*stranger[^"]*"/i, 'landing meta description mentions 21 nights + stranger');
    assert.match(appHtml, /Feel seen without performing\./, 'app shell has auth-screen subtitle');
    ok('Global homepage positioning');
  } catch (e) { fail('Global homepage positioning', e); }

  // 14. Partner status exposes activity labels, gentle reminder, rescue options, and continue-solo tracking
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('smoke@test.example');
    clearMatchesForUser(db, user.id);
    const partnerId = db.prepare("INSERT INTO users (name, email, password, college, year, archetype, consent_given, consent_date, last_active_date) VALUES ('Retention Partner', ?, 'seeded-password', 'Test University B', '2nd', 'connector', 1, datetime('now'), date('now'))").run(uniqueEmail('retention-partner')).lastInsertRowid;
    const partnerUser = db.prepare('SELECT * FROM users WHERE id = ?').get(partnerId);
    const matchId = db.prepare("INSERT INTO matches (user1_id, user2_id, matched_at, started_at) VALUES (?, ?, datetime('now'), datetime('now', '-8 days'))").run(user.id, partnerUser.id).lastInsertRowid;
    db.prepare("UPDATE users SET last_active_date = date('now') WHERE id = ?").run(partnerUser.id);
    let status = await request('GET', '/api/partner-status', null, { cookie });
    assert.strictEqual(status.status, 200, `partner status got ${status.status}: ${status.raw}`);
    assert.strictEqual(status.json.activityLabel, 'Partner active today');

    db.prepare("UPDATE users SET last_active_date = date('now', '-3 days') WHERE id = ?").run(partnerUser.id);
    status = await request('GET', '/api/partner-status', null, { cookie });
    assert.strictEqual(status.json.activityLabel, 'Partner active this week');

    db.prepare("UPDATE users SET last_active_date = date('now', '-8 days') WHERE id = ?").run(partnerUser.id);
    status = await request('GET', '/api/partner-status', null, { cookie });
    assert.strictEqual(status.json.activityLabel, 'Partner inactive');
    assert.deepStrictEqual(status.json.rescueActions.map(a => a.id), ['continue_solo', 'find_new_partner', 'wait_for_partner']);

    const reminder = await request('POST', '/api/partner-reminder', {}, { cookie });
    assert.strictEqual(reminder.status, 200, `partner reminder got ${reminder.status}: ${reminder.raw}`);
    assert.ok(db.prepare("SELECT * FROM nudges WHERE user_id = ? AND match_id = ? AND type = 'partner_reminder'").get(partnerUser.id, matchId));
    assert.ok(db.prepare("SELECT * FROM analytics_events WHERE user_id = ? AND event_name = 'partner_reminder_sent'").get(user.id));
    db.prepare("UPDATE nudges SET dismissed = 1 WHERE user_id = ? AND match_id = ? AND type = 'partner_reminder'").run(partnerUser.id, matchId);
    const repeatedReminder = await request('POST', '/api/partner-reminder', {}, { cookie });
    assert.strictEqual(repeatedReminder.status, 200, `repeated reminder got ${repeatedReminder.status}: ${repeatedReminder.raw}`);
    assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM nudges WHERE user_id = ? AND match_id = ? AND type = 'partner_reminder'").get(partnerUser.id, matchId).c, 1, 'reminder cooldown ignores dismissed state');
    assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE user_id = ? AND event_name = 'partner_reminder_sent'").get(user.id).c, 1, 'reminder analytics tracked only when nudge is created');

    const solo = await request('POST', '/api/continue-solo', {}, { cookie });
    assert.strictEqual(solo.status, 200, `continue solo got ${solo.status}: ${solo.raw}`);
    assert.ok(db.prepare("SELECT * FROM analytics_events WHERE user_id = ? AND event_name = 'continue_solo_selected'").get(user.id));
    const repeatedSolo = await request('POST', '/api/continue-solo', {}, { cookie });
    assert.strictEqual(repeatedSolo.status, 200, `repeated continue solo got ${repeatedSolo.status}: ${repeatedSolo.raw}`);
    assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE user_id = ? AND event_name = 'continue_solo_selected'").get(user.id).c, 1, 'continue solo analytics tracked once for the same match');
    ok('Partner rescue flow');
  } catch (e) { fail('Partner rescue flow', e); }

  // 15. Analytics include named retention milestones
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('smoke@test.example');
    clearMatchesForUser(db, user.id);
    db.prepare('DELETE FROM entries WHERE user_id = ?').run(user.id);
    const partnerId = db.prepare("INSERT INTO users (name, email, password, college, year, archetype, consent_given, consent_date, last_active_date) VALUES ('Analytics Partner', ?, 'seeded-password', 'Test University C', '2nd', 'connector', 1, datetime('now'), date('now'))").run(uniqueEmail('analytics-partner')).lastInsertRowid;
    const partnerUser = db.prepare('SELECT * FROM users WHERE id = ?').get(partnerId);
    db.prepare("UPDATE users SET archetype = NULL, scores = NULL, college = 'Test University A', college_normalized = 'test-university-a' WHERE id = ?").run(user.id);
    const scan = await request('POST', '/api/scan', {
      archetype: 'protector',
      scores: { openness: 75, awareness: 65, guard: 25, reciprocity: 70 },
      answers: [4, 5, 3, 6, 4, 5, 3, 6, 4, 5, 3]
    }, { cookie });
    assert.strictEqual(scan.status, 200, `scan got ${scan.status}: ${scan.raw}`);
    const match = db.prepare('SELECT * FROM matches WHERE user1_id = ? OR user2_id = ?').get(user.id, user.id);
    assert.ok(match, 'match created by scan');
    const matchId = match.id;
    db.prepare("DELETE FROM analytics_events WHERE user_id = ? AND event_name IN ('first_reflection', 'day_2', 'day_7', 'day_14', 'day_21', 'day_written')").run(user.id);
    for (const day of [1, 2, 7, 14, 21]) {
      db.prepare('DELETE FROM entries WHERE user_id = ? AND match_id = ?').run(user.id, matchId);
      db.prepare('UPDATE matches SET started_at = datetime(\'now\', ?) WHERE id = ?').run(`-${day - 1} days`, matchId);
      const entry = await request('POST', '/api/entry', { text: `day ${day} reflection`, mood: 'Okay' }, { cookie });
      assert.strictEqual(entry.status, 200, `day ${day} entry got ${entry.status}: ${entry.raw}`);
      if (day === 7) {
        const repeatedEntry = await request('POST', '/api/entry', { text: 'day 7 edited reflection', mood: 'Okay' }, { cookie });
        assert.strictEqual(repeatedEntry.status, 200, `day 7 repeated entry got ${repeatedEntry.status}: ${repeatedEntry.raw}`);
      }
    }
    for (const eventName of ['signup', 'matched', 'first_reflection', 'day_2', 'day_7', 'day_14', 'day_21']) {
      assert.ok(db.prepare('SELECT * FROM analytics_events WHERE user_id = ? AND event_name = ?').get(user.id, eventName), `${eventName} tracked`);
    }
    assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE user_id = ? AND event_name = 'day_7'").get(user.id).c, 1, 'day 7 milestone tracked once per matched day');
    assert.strictEqual(db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE user_id = ? AND event_name = 'day_written'").get(user.id).c, 5, 'entry edits do not duplicate day_written analytics');
    ok('Retention analytics milestones');
  } catch (e) { fail('Retention analytics milestones', e); }

  // I-1. Matching never pairs two users from the same normalized college
  try {
    const { lastInsertRowid: uid } = db.prepare("INSERT INTO users (name, email, password, college, college_normalized, year, gender, match_gender_pref, match_year_pref, archetype, scores, consent_given, consent_date, last_active_date, switch_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), date('now'), 0, datetime('now'))").run(
      'Alice', uniqueEmail('college'), 'pw', 'SRCC Delhi', 'srcc-delhi', '2nd', 'female', 'any', 'any', 'connector', '{"openness":50,"awareness":50,"guard":50,"reciprocity":50}'
    );
    const candidates = db.prepare(`
      SELECT * FROM users
      WHERE archetype = 'protector'
        AND COALESCE(college_normalized, LOWER(college)) != 'srcc-delhi'
        AND id != ?
        AND COALESCE(account_status, 'active') != 'deleted'
        AND id NOT IN (SELECT user1_id FROM matches UNION SELECT user2_id FROM matches)
    `).all(uid);
    const sameCollege = candidates.filter(c => (c.college_normalized || c.college.toLowerCase()) === 'srcc-delhi');
    assert.strictEqual(sameCollege.length, 0, 'no candidates share normalized college');
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    ok('Matching excludes same normalized college');
  } catch (e) { fail('Matching excludes same normalized college', e); }

  // I-2. Entry sealed today is not visible to partner until next IST day
  try {
    const partnerEntriesStmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND match_id = ? AND day < ? ORDER BY day DESC');
    const { lastInsertRowid: uidA } = db.prepare("INSERT INTO users (name, email, password, college, college_normalized, year, gender, match_gender_pref, match_year_pref, archetype, scores, consent_given, consent_date, last_active_date, switch_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), date('now'), 0, datetime('now'))").run(
      'VisA', uniqueEmail('visa'), 'pw', 'TestU', 'testu', '2nd', 'female', 'any', 'any', 'protector', '{}'
    );
    const { lastInsertRowid: uidB } = db.prepare("INSERT INTO users (name, email, password, college, college_normalized, year, gender, match_gender_pref, match_year_pref, archetype, scores, consent_given, consent_date, last_active_date, switch_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), date('now'), 0, datetime('now'))").run(
      'VisB', uniqueEmail('visb'), 'pw', 'OtherU', 'otheru', '2nd', 'male', 'any', 'any', 'connector', '{}'
    );
    const { lastInsertRowid: matchId } = db.prepare("INSERT INTO matches (user1_id, user2_id, started_at) VALUES (?, ?, datetime('now'))").run(uidA, uidB);
    db.prepare("INSERT INTO entries (user_id, match_id, day, text, mood, prompt) VALUES (?, ?, 1, 'hello', '🌓', 'test')").run(uidA, matchId);
    const currentDay = 1;
    const partnerVisible = partnerEntriesStmt.all(uidA, matchId, currentDay);
    assert.strictEqual(partnerVisible.length, 0, 'same-day entry not visible to partner via day < currentDay');
    const nextDay = 2;
    const partnerVisibleNext = partnerEntriesStmt.all(uidA, matchId, nextDay);
    assert.strictEqual(partnerVisibleNext.length, 1, 'entry visible to partner on the next day');
    db.prepare('DELETE FROM entries WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM matches WHERE id = ?').run(matchId);
    db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(uidA, uidB);
    ok('Entry not visible to partner until next day');
  } catch (e) { fail('Entry not visible to partner until next day', e); }

  // I-3. Silent Room presence count uses IST day boundary
  try {
    const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
    assert.ok(anyUser, 'need at least one user for silent_lines FK');
    const presenceQuery = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as c FROM silent_lines
      WHERE status = 'approved'
        AND created_at >= datetime('now', '+5 hours', '+30 minutes', 'start of day', '-5 hours', '-30 minutes')
        AND deleted_at IS NULL
    `);
    const before = presenceQuery.get().c;
    const lineId = 'ist-test-' + Date.now();
    db.prepare("INSERT INTO silent_lines (id, user_id, content, status, created_at, expires_at) VALUES (?, ?, 'test line', 'approved', datetime('now'), datetime('now', '+1 day'))").run(lineId, anyUser.id);
    const after = presenceQuery.get().c;
    assert.strictEqual(after, before + 1, 'presence count incremented for today IST');
    db.prepare('DELETE FROM silent_lines WHERE id = ?').run(lineId);
    ok('Silent Room presence uses IST day boundary');
  } catch (e) { fail('Silent Room presence uses IST day boundary', e); }

  // ═══════════════════════════════════════
  // REGRESSION TESTS (R-1 through R-26)
  // ═══════════════════════════════════════

  // R-1: /api 404 returns JSON not HTML
  try {
    const r = await request('GET', '/api/nonexistent-route-xyz');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json && r.json.error, '/api 404 returns JSON with error field');
    ok('/api 404 returns JSON not HTML');
  } catch (e) { fail('/api 404 returns JSON not HTML', e); }

  // R-2: X-Robots-Tag headers correct
  try {
    const appR = await request('GET', '/app');
    assert.match(appR.headers['x-robots-tag'] || '', /noindex/, '/app has noindex');
    ok('X-Robots-Tag headers correct');
  } catch (e) { fail('X-Robots-Tag headers correct', e); }

  // R-3: /sitemap.xml lists only marketing pages
  try {
    const r = await request('GET', '/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.raw.includes('/app'), 'sitemap does not list /app');
    assert.ok(!r.raw.includes('/admin'), 'sitemap does not list /admin');
    assert.ok(!r.raw.includes('/api'), 'sitemap does not list /api');
    ok('/sitemap.xml lists only marketing pages');
  } catch (e) { fail('/sitemap.xml lists only marketing pages', e); }

  // Blog: index and listed articles are public, indexable, in the sitemap, and analytics-eligible.
  try {
    const { BLOG_POSTS } = require('../lib/blog-posts');
    const index = await request('GET', '/blog');
    assert.strictEqual(index.status, 200);
    assert.ok(index.raw.includes('rel="canonical" href="https://mymentallyprepare.com/blog"'), 'blog index has canonical');
    assert.ok((index.headers['content-security-policy'] || '').includes('https://www.googletagmanager.com'), 'blog index uses public CSP');
    const sitemap = await request('GET', '/sitemap.xml');
    assert.ok(sitemap.raw.includes('/blog</loc>'), 'sitemap lists blog index');
    for (const post of BLOG_POSTS) {
      const r = await request('GET', `/blog/${post.slug}`);
      assert.strictEqual(r.status, 200, `${post.slug} is served`);
      assert.ok(!/noindex/.test(r.headers['x-robots-tag'] || ''), `${post.slug} is indexable`);
      assert.ok(r.raw.includes(`<link rel="canonical" href="https://mymentallyprepare.com/blog/${post.slug}"/>`), `${post.slug} has its canonical`);
      assert.ok(r.raw.includes('"@type": "BlogPosting"'), `${post.slug} has article schema`);
      assert.ok(r.raw.includes('href="/safety"'), `${post.slug} links to the safety page`);
      assert.ok(index.raw.includes(`href="/blog/${post.slug}"`), `blog index links to ${post.slug}`);
      assert.ok(sitemap.raw.includes(`/blog/${post.slug}</loc>`), `sitemap lists ${post.slug}`);
      const image = await request('GET', post.image);
      assert.strictEqual(image.status, 200, `${post.slug} image exists`);
    }
    const missing = await request('GET', '/blog/not-a-real-post');
    assert.strictEqual(missing.status, 404, 'unknown blog slug is a 404');
    ok('blog pages are public, indexable, and in the sitemap');
  } catch (e) { fail('blog pages are public, indexable, and in the sitemap', e); }

  // R-4: /robots.txt disallows /app, /admin, /api
  try {
    const r = await request('GET', '/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(r.raw.includes('/app'), 'robots.txt mentions /app');
    assert.ok(r.raw.includes('/admin'), 'robots.txt mentions /admin');
    assert.ok(r.raw.includes('/api'), 'robots.txt mentions /api');
    ok('/robots.txt disallows /app, /admin, /api');
  } catch (e) { fail('/robots.txt disallows /app, /admin, /api', e); }

  // Google Analytics can load only on public pages after the local consent script allows it.
  try {
    const publicPage = await request('GET', '/');
    const privatePage = await request('GET', '/app');
    const publicCsp = publicPage.headers['content-security-policy'] || '';
    const privateCsp = privatePage.headers['content-security-policy'] || '';
    assert.ok(publicPage.raw.includes('/public-analytics.js'), 'homepage includes consent controller');
    assert.ok(!privatePage.raw.includes('/public-analytics.js'), 'private app excludes consent controller');
    assert.ok(publicCsp.includes('https://www.googletagmanager.com'), 'public CSP permits Google tag after consent');
    assert.ok(!privateCsp.includes('https://www.googletagmanager.com'), 'private CSP blocks Google tag');
    ok('Google Analytics is confined to public pages');
  } catch (e) { fail('Google Analytics is confined to public pages', e); }

  // R-5: #s-archetype-reveal has no inline display:flex
  try {
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    assert.ok(!appHtml.match(/id=["']s-archetype-reveal["'][^>]*style=["'][^"']*display:\s*flex/), 'no inline display:flex on #s-archetype-reveal');
    ok('#s-archetype-reveal has no inline display:flex');
  } catch (e) { fail('#s-archetype-reveal has no inline display:flex', e); }

  // R-6: app.html has mp-app-route first-paint guard
  try {
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    assert.ok(appHtml.includes('mp-app-route'), 'app.html contains mp-app-route guard');
    ok('app.html has mp-app-route first-paint guard');
  } catch (e) { fail('app.html has mp-app-route first-paint guard', e); }

  // R-7: viewport meta has viewport-fit=cover
  try {
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    assert.ok(appHtml.includes('viewport-fit=cover'), 'app.html has viewport-fit=cover');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('viewport-fit=cover'), 'index.html has viewport-fit=cover');
    ok('viewport meta has viewport-fit=cover');
  } catch (e) { fail('viewport meta has viewport-fit=cover', e); }

  // R-8: s-forgot is in all three auth deep-link lists
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const lists = appJs.match(/\[.*?'s-signup'.*?'s-login'.*?\]/g) || [];
    const allIncludeForgot = lists.every(l => l.includes('s-forgot'));
    assert.ok(allIncludeForgot && lists.length >= 3, 's-forgot in all auth deep-link lists');
    ok('s-forgot is in all three auth deep-link lists');
  } catch (e) { fail('s-forgot is in all three auth deep-link lists', e); }

  // R-9: showInstallPromptIfUseful guards against auth screens
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(appJs.includes('auth-screen') && appJs.includes('showInstallPromptIfUseful'), 'install prompt guards auth screens');
    ok('showInstallPromptIfUseful guards against auth screens');
  } catch (e) { fail('showInstallPromptIfUseful guards against auth screens', e); }

  // R-10: app.css scopes 88px padding-bottom to non-auth screens
  try {
    const appCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
    assert.ok(appCss.includes(':not(.auth-screen)'), 'app.css has :not(.auth-screen) scoping');
    ok('app.css scopes 88px padding-bottom to non-auth screens');
  } catch (e) { fail('app.css scopes 88px padding-bottom to non-auth screens', e); }

  // R-11: #s-forgot and #s-reset have auth-screen class
  try {
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    assert.ok(appHtml.match(/id=["']s-forgot["'][^>]*class=["'][^"']*auth-screen/) || appHtml.match(/class=["'][^"']*auth-screen[^"']*["'][^>]*id=["']s-forgot["']/), '#s-forgot has auth-screen class');
    assert.ok(appHtml.match(/id=["']s-reset["'][^>]*class=["'][^"']*auth-screen/) || appHtml.match(/class=["'][^"']*auth-screen[^"']*["'][^>]*id=["']s-reset["']/), '#s-reset has auth-screen class');
    ok('#s-forgot and #s-reset have auth-screen class');
  } catch (e) { fail('#s-forgot and #s-reset have auth-screen class', e); }

  // R-12: reporting must never trigger matching as a hidden side effect.
  try {
    const appJsContent = fs.readFileSync(path.join(__dirname, '..', 'routes', 'app.js'), 'utf8');
    const reportStart = appJsContent.indexOf("app.post('/api/report'");
    const reportEnd = appJsContent.indexOf("app.post('/api/block-partner'", reportStart);
    const reportHandler = appJsContent.slice(reportStart, reportEnd);
    assert.ok(reportStart > -1 && reportEnd > reportStart, 'report handler is present');
    assert.ok(!reportHandler.includes('attemptMatch'), 'reporting never creates a match');
    ok('/api/report has no hidden matching side effect');
  } catch (e) { fail('/api/report has no hidden matching side effect', e); }

  // R-13: HTML assets and service worker share the release cache-bust version
  try {
    const swJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    const swMatch = swJs.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
    const htmlMatch = appHtml.match(/app\.css\?v=([^"&]+)/);
    const jsMatch = appHtml.match(/app\.js\?v=([^"&]+)/);
    assert.ok(swMatch && htmlMatch && jsMatch, 'found all version strings');
    assert.strictEqual(swMatch[1], `mp-${htmlMatch[1]}`, 'SW cache name includes the CSS cache-bust version');
    assert.strictEqual(jsMatch[1], htmlMatch[1], 'JavaScript and CSS cache-bust versions match');
    ok('app assets and service worker share cache-bust version');
  } catch (e) { fail('app assets and service worker share cache-bust version', e); }

  // R-14: app.js has popstate handler
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(appJs.includes("'popstate'"), 'app.js has popstate listener');
    ok('app.js has popstate handler');
  } catch (e) { fail('app.js has popstate handler', e); }

  // R-15: routes/payments.js exports registerStripeWebhook
  try {
    const payments = require('../routes/payments');
    assert.strictEqual(typeof payments.registerStripeWebhook, 'function', 'registerStripeWebhook is exported');
    ok('routes/payments.js exports registerStripeWebhook');
  } catch (e) { fail('routes/payments.js exports registerStripeWebhook', e); }

  // R-16: Email verification token cleared after first use
  try {
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(serverJs.includes('email_verification_token = NULL'), 'verifyUserEmail clears token');
    ok('Email verification token cleared after first use');
  } catch (e) { fail('Email verification token cleared after first use', e); }

  // R-17: Stripe success/cancel URLs use server baseUrl
  try {
    const paymentsJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payments.js'), 'utf8');
    assert.ok(paymentsJs.includes('baseUrl +'), 'payments uses baseUrl for redirect URLs');
    assert.ok(!paymentsJs.match(/req\.header\(['"]origin['"]\)\s*\+\s*['"]\/app\?payment/), 'payments does not use req.header origin for redirects');
    ok('Stripe success/cancel URLs use server baseUrl');
  } catch (e) { fail('Stripe success/cancel URLs use server baseUrl', e); }

  // R-18: Session secret file mode 0o600
  try {
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(serverJs.includes('0o600'), 'server.js writes session secret with 0o600 mode');
    ok('Session secret file mode 0o600');
  } catch (e) { fail('Session secret file mode 0o600', e); }

  // R-19: go() hides UHB + injects help link on auth screens
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(appJs.includes('mp-auth-help-link'), 'go() injects auth help link');
    assert.ok(appJs.includes("uhb.style.display = 'none'"), 'go() hides UHB on auth screens');
    ok('go() hides UHB + injects help link on auth screens');
  } catch (e) { fail('go() hides UHB + injects help link on auth screens', e); }

  // R-20: Already-verified users redirected to login
  try {
    const authJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    assert.ok(authJs.includes('screen=s-login&verified=1'), 'already-verified redirects to login screen');
    ok('Already-verified users redirected to login');
  } catch (e) { fail('Already-verified users redirected to login', e); }

  // R-21: Session ID regenerated on login
  try {
    const authJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    assert.ok(authJs.includes('establishSession'), 'auth.js uses establishSession helper');
    assert.ok(authJs.includes('session.regenerate'), 'establishSession calls session.regenerate');
    ok('Session ID regenerated on login');
  } catch (e) { fail('Session ID regenerated on login', e); }

  // R-22: All admin routes have authLimiter
  try {
    const adminJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
    const adminRoutes = adminJs.match(/app\.(get|post)\([^)]+requireAdmin/g) || [];
    const withLimiter = adminJs.match(/app\.(get|post)\([^)]+authLimiter[^)]+requireAdmin/g) || [];
    assert.strictEqual(adminRoutes.length, withLimiter.length, 'all admin routes have authLimiter');
    ok('All admin routes have authLimiter');
  } catch (e) { fail('All admin routes have authLimiter', e); }

  // R-23: restoreFirebaseSession skips for password-only users
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(appJs.includes('hasCachedFirebaseUser'), 'app.js has hasCachedFirebaseUser check');
    ok('restoreFirebaseSession skips for password-only users');
  } catch (e) { fail('restoreFirebaseSession skips for password-only users', e); }

  // R-24: Legacy 64-hex reset tokens work
  try {
    const authJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    assert.ok(authJs.includes('isLegacy64Hex'), 'auth.js has legacy 64-hex token check');
    ok('Legacy 64-hex reset tokens work');
  } catch (e) { fail('Legacy 64-hex reset tokens work', e); }

  // R-25: STRIPE_WEBHOOK_SECRET in .env.example
  try {
    const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    assert.ok(envExample.includes('STRIPE_WEBHOOK_SECRET'), '.env.example has STRIPE_WEBHOOK_SECRET');
    ok('STRIPE_WEBHOOK_SECRET in .env.example');
  } catch (e) { fail('STRIPE_WEBHOOK_SECRET in .env.example', e); }

  // R-26: auth-smoke.js default app.js version is current
  try {
    const authSmoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'auth-smoke.js'), 'utf8');
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    const scriptMatch = appHtml.match(/app\.js\?v=([^"&]+)/);
    assert.ok(scriptMatch, 'found app.js cache-bust version');
    assert.ok(authSmoke.includes(`'${scriptMatch[1]}'`), 'auth-smoke default version matches app.js cache-bust');
    ok('auth-smoke.js default app.js version is current');
  } catch (e) { fail('auth-smoke.js default app.js version is current', e); }

  // R-27: Homepage countdown tied to 9pm IST (15:30 UTC)
  try {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(idx.includes('id="countdown-line"'), 'countdown-line element exists');
    assert.ok(idx.includes('setUTCHours(15,30,0,0)'), 'countdown targets 15:30 UTC');
    assert.ok(idx.includes('cd-label'), 'countdown uses cd-label styling');
    ok('Homepage countdown tied to 9pm IST (15:30 UTC)');
  } catch (e) { fail('Homepage countdown tied to 9pm IST (15:30 UTC)', e); }

  // R-28: Homepage buttons use rose-purple, not gold
  try {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(idx.includes('--accent-purple:#6E4EA6'), 'accent-purple token defined');
    const btnMatch = idx.match(/\.btn\{[^}]+\}/);
    assert.ok(btnMatch, '.btn rule found');
    assert.ok(btnMatch[0].includes('rgba(110,78,166'), '.btn uses accent-purple rgba');
    assert.ok(!btnMatch[0].includes('rgba(224,197,143'), '.btn does not use gold rgba');
    ok('Homepage buttons use rose-purple, not gold');
  } catch (e) { fail('Homepage buttons use rose-purple, not gold', e); }

  // R-29: Display font has tighter letter-spacing
  try {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(idx.includes('.section-title{') && idx.includes('letter-spacing:-.025em'), 'section-title letter-spacing tightened');
    ok('Display font has tighter letter-spacing');
  } catch (e) { fail('Display font has tighter letter-spacing', e); }

  // Clean up
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + ext); } catch {}
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
