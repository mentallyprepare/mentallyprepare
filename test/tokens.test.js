'use strict';

// Unit tests for lib/tokens.js — the bearer-token core.
// Run: node test/tokens.test.js  (exit 0 = pass, 1 = fail)

process.env.AUTH_TOKEN_SECRET = 'test-secret-value-do-not-use-in-prod-1234567890';

const assert = require('assert');
const tokens = require('../lib/tokens');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error('       ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

test('sign + verify round-trips and carries sub/type', () => {
  const t = tokens.signToken({ sub: 42, type: 'access' });
  assert.ok(t && typeof t === 'string', 'token should be a string');
  assert.strictEqual(t.split('.').length, 3, 'token has 3 segments');
  const r = tokens.verifyToken(t, { type: 'access' });
  assert.strictEqual(r.valid, true, 'should be valid');
  assert.strictEqual(r.payload.sub, 42);
  assert.strictEqual(r.payload.typ, 'access');
});

test('a tampered payload is rejected', () => {
  const t = tokens.signToken({ sub: 1 });
  const [ver, , sig] = t.split('.');
  // Forge a payload that claims sub:999 but keep the original signature.
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 999, typ: 'access', iat: 1, exp: 9999999999 })).toString('base64url');
  const forged = `${ver}.${forgedPayload}.${sig}`;
  const r = tokens.verifyToken(forged);
  assert.strictEqual(r.valid, false, 'forged token must be rejected');
  assert.strictEqual(r.reason, 'bad_signature');
});

test('a token signed with a different secret is rejected', () => {
  // Craft a token with the wrong secret by hand and confirm verify rejects it.
  const crypto = require('crypto');
  const payload = Buffer.from(JSON.stringify({ sub: 7, typ: 'access', iat: 1, exp: 9999999999 })).toString('base64url');
  const signingInput = `v1.${payload}`;
  const wrongSig = crypto.createHmac('sha256', 'the-wrong-secret').update(signingInput).digest('base64url');
  const r = tokens.verifyToken(`${signingInput}.${wrongSig}`);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'bad_signature');
});

test('an expired token is rejected', () => {
  const t = tokens.signToken({ sub: 5, ttlSeconds: -10 }); // already expired
  const r = tokens.verifyToken(t);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'expired');
});

test('type mismatch is rejected (access token used where refresh required)', () => {
  const t = tokens.signToken({ sub: 5, type: 'access' });
  const r = tokens.verifyToken(t, { type: 'refresh' });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'wrong_type');
});

test('malformed input is rejected without throwing', () => {
  for (const bad of ['', 'notatoken', 'a.b', 'a.b.c.d', null, undefined, 123]) {
    const r = tokens.verifyToken(bad);
    assert.strictEqual(r.valid, false, `"${bad}" should be invalid`);
  }
});

test('issueTokenPair returns an access + refresh pair', () => {
  const pair = tokens.issueTokenPair(11);
  assert.ok(pair.accessToken && pair.refreshToken, 'both tokens present');
  assert.strictEqual(tokens.verifyToken(pair.accessToken, { type: 'access' }).valid, true);
  assert.strictEqual(tokens.verifyToken(pair.refreshToken, { type: 'refresh' }).valid, true);
  assert.strictEqual(pair.expiresIn, tokens.ACCESS_TTL_SECONDS);
});

test('bearerFromRequest parses the Authorization header', () => {
  assert.strictEqual(tokens.bearerFromRequest({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.strictEqual(tokens.bearerFromRequest({ headers: { authorization: 'bearer xyz' } }), 'xyz');
  assert.strictEqual(tokens.bearerFromRequest({ headers: {} }), null);
  assert.strictEqual(tokens.bearerFromRequest({ headers: { authorization: 'Basic zzz' } }), null);
});

if (process.exitCode === 1) {
  console.error(`\n${passed} passed, some FAILED`);
} else {
  console.log(`\nAll ${passed} token tests passed.`);
}
