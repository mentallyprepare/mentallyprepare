// API smoke test — no frameworks, just http + assert
const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const PORT = 9876;
const DB_PATH = path.join(__dirname, 'smoke-test.db');

// Clean up any previous test DB
try { fs.unlinkSync(DB_PATH); } catch {}
try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}

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
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(resolve => setTimeout(resolve, 1500));

  // 1. Health check
  try {
    const r = await request('GET', '/api/ready');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'ready');
    ok('/api/ready');
  } catch (e) { fail('/api/ready', e); }

  // 2. Register
  let cookie;
  try {
    const r = await request('POST', '/api/register', {
      name: 'Smoke Tester',
      email: 'smoke@test.example',
      password: 'testpass123',
      college: 'Test University',
      year: '2nd',
      consentGiven: true
    });
    assert.strictEqual(r.status, 200, `got ${r.status}: ${r.raw}`);
    cookie = extractCookie(r.headers);
    assert.ok(cookie, 'session cookie');
    ok('POST /api/register');
  } catch (e) { fail('POST /api/register', e); }

  // 3. Save waiting entry
  try {
    const r = await request('POST', '/api/waiting-entry', {
      text: 'Smoke test waiting entry'
    }, { cookie });
    assert.strictEqual(r.status, 200, `got ${r.status}: ${r.raw}`);
    assert.strictEqual(r.json.ok, true);
    ok('POST /api/waiting-entry');
  } catch (e) { fail('POST /api/waiting-entry', e); }

  // 4. /api/my-data includes waiting_entries
  try {
    const r = await request('GET', '/api/my-data', null, { cookie });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.waiting_entries), 'waiting_entries is array');
    assert.ok(r.json.waiting_entries.length > 0, 'waiting_entries not empty');
    const found = r.json.waiting_entries.find(e => e.text === 'Smoke test waiting entry');
    assert.ok(found, 'our entry is in the export');
    ok('GET /api/my-data includes waiting_entries');
  } catch (e) { fail('GET /api/my-data waiting_entries', e); }

  // 5. /api/me shows waiting entries when unmatched
  try {
    const r = await request('GET', '/api/me', null, { cookie });
    assert.strictEqual(r.status, 200);
    const found = r.json.entries.find(e => e.text === 'Smoke test waiting entry');
    assert.ok(found, 'waiting entries shown in /api/me');
    ok('GET /api/me shows waiting entries');
  } catch (e) { fail('GET /api/me waiting entries', e); }

  // 6. Admin export requires auth
  try {
    const r = await request('GET', '/admin/export');
    assert.strictEqual(r.status, 401);
    ok('GET /admin/export rejects unauthenticated');
  } catch (e) { fail('GET /admin/export auth check', e); }

  // 7. Admin export includes waiting_entries
  try {
    const r = await request('GET', '/admin/export', null, { 'x-admin-password': 'test-admin-pw' });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.waiting_entries), 'admin export has waiting_entries');
    ok('GET /admin/export includes waiting_entries');
  } catch (e) { fail('GET /admin/export waiting_entries', e); }

  // Clean up
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
