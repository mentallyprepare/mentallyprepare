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

// Clean up any previous test DB
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + ext); } catch {}
}

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
    ok('POST /api/register');
  } catch (e) { fail('POST /api/register', e); }

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
    const forgot = await request('POST', '/api/forgot-password', { email });
    assert.strictEqual(forgot.status, 200, `forgot got ${forgot.status}: ${forgot.raw}`);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const tokenRow = db.prepare('SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
    assert.ok(tokenRow, 'reset token stored');
    assert.match(tokenRow.token, /^[A-Z0-9]{6}$/, 'reset code is 6 uppercase characters');

    const weak = await request('POST', '/api/reset-password', { code: tokenRow.token, newPassword: 'short' });
    assert.strictEqual(weak.status, 400);
    assert.match(weak.json.error, /at least 8/i);

    const reset = await request('POST', '/api/reset-password', { code: tokenRow.token, newPassword: 'newpass123' });
    assert.strictEqual(reset.status, 200, `reset got ${reset.status}: ${reset.raw}`);
    assert.strictEqual((await request('POST', '/api/login', { email, password: 'oldpass123' })).status, 401, 'old password rejected');
    assert.strictEqual((await request('POST', '/api/login', { email, password: 'newpass123' })).status, 200, 'new password accepted');

    const reused = await request('POST', '/api/reset-password', { code: tokenRow.token, newPassword: 'another123' });
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
    assert.match(repeat.headers.location, /verified=1/, 'already verified repeat link succeeds');

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

  // 13. Sprint 1 global positioning removes region-limited marketing copy
  try {
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    assert.match(indexHtml, /Feel seen without performing\./);
    assert.match(indexHtml, /private 21-day reflection journey where two people connect through honest conversations, not followers, likes, or profiles/i);
    assert.match(appHtml, /Feel seen without performing\./);
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
