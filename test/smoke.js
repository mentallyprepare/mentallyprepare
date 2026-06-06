// Smoke test — no frameworks, just http + assert
// Validates core API routes against main's schema.
const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

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

function request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${PORT}`);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
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

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log('  PASS:', label); }
function fail(label, e) { failed++; console.error('  FAIL:', label, '-', e.message); }

async function run() {
  // Require server — this starts the app on PORT
  require(path.join(__dirname, '..', 'server.js'));
  // Wait for server to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 1. Health check
  try {
    const r = await request('GET', '/api/ready');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'ready');
    ok('/api/ready returns 200');
  } catch (e) { fail('/api/ready', e); }

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

  // Clean up
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
