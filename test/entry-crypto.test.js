'use strict';

// Encryption at rest for journal entries.
//
// Two invariants matter here:
//   1. Round-trip: encrypt(plaintext) then decrypt returns the original bytes.
//   2. Backward-compat: decrypt(plaintext-that-was-never-encrypted) returns
//      the input unchanged, so a database mid-migration serves both formats.
// Plus the ordinary AEAD guarantees — tampering rejected, key required in
// production, wrong key rejected.

const assert = require('assert');
const {
  VERSION,
  encrypt,
  decrypt,
  isEncrypted,
  hasKey,
  generateKey,
  _resetKeyCacheForTests,
} = require('../lib/entry-crypto');

const TEST_KEY = generateKey();
const OTHER_KEY = generateKey();

function withKey(key, fn) {
  const prev = process.env.ENTRIES_ENCRYPTION_KEY;
  if (key === null) delete process.env.ENTRIES_ENCRYPTION_KEY;
  else process.env.ENTRIES_ENCRYPTION_KEY = key;
  _resetKeyCacheForTests();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ENTRIES_ENCRYPTION_KEY;
    else process.env.ENTRIES_ENCRYPTION_KEY = prev;
    _resetKeyCacheForTests();
  }
}

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('round-trip: encrypt then decrypt returns the original bytes', () => {
  withKey(TEST_KEY, () => {
    const plain = 'A quiet sentence. Tonight I noticed the room was warmer.';
    const ct = encrypt(plain);
    assert.notStrictEqual(ct, plain, 'ciphertext must not equal plaintext');
    assert.ok(isEncrypted(ct), 'output must be recognised as encrypted');
    assert.strictEqual(decrypt(ct), plain);
  });
});

test('round-trip handles unicode, newlines, and empty strings', () => {
  withKey(TEST_KEY, () => {
    for (const input of ['', 'बेचैन रात', 'line one\nline two\r\nend', '🌙 ✦ ⛧']) {
      assert.strictEqual(decrypt(encrypt(input)), input, `round-trip: ${JSON.stringify(input)}`);
    }
  });
});

test('two encryptions of the same plaintext produce different ciphertexts', () => {
  withKey(TEST_KEY, () => {
    const a = encrypt('same words twice');
    const b = encrypt('same words twice');
    assert.notStrictEqual(a, b, 'IV must be random per encrypt');
    assert.strictEqual(decrypt(a), decrypt(b));
  });
});

test('decrypt returns plaintext-shaped input unchanged (backward-compat)', () => {
  withKey(TEST_KEY, () => {
    // A row written before the migration ran — decrypt must pass it through.
    assert.strictEqual(decrypt('this is not encrypted'), 'this is not encrypted');
    assert.strictEqual(decrypt(''), '');
    assert.strictEqual(decrypt(null), null);
    assert.strictEqual(decrypt(undefined), undefined);
  });
});

test('encrypt with no key present becomes an identity function (dev-only path)', () => {
  withKey(null, () => {
    assert.strictEqual(hasKey(), false);
    assert.strictEqual(encrypt('still plaintext'), 'still plaintext');
  });
});

test('decrypt with no key present throws if it sees ciphertext — never renders as gibberish', () => {
  const ciphertext = withKey(TEST_KEY, () => encrypt('secret'));
  withKey(null, () => {
    assert.throws(() => decrypt(ciphertext), /ENTRIES_ENCRYPTION_KEY/);
  });
});

test('wrong key rejects the ciphertext', () => {
  const ciphertext = withKey(TEST_KEY, () => encrypt('secret'));
  withKey(OTHER_KEY, () => {
    assert.throws(() => decrypt(ciphertext));
  });
});

test('tampered payload rejects (auth tag catches it)', () => {
  const ciphertext = withKey(TEST_KEY, () => encrypt('secret'));
  withKey(TEST_KEY, () => {
    // Flip one byte in the ciphertext segment.
    const parts = ciphertext.split(':');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString('base64url');
    assert.throws(() => decrypt(parts.join(':')));
  });
});

test('key format: rejects non-base64 and wrong-length keys at read time', () => {
  withKey('not$$$base64', () => {
    // node accepts sloppy base64; length is what really guards this.
    assert.throws(() => encrypt('x'), /32 bytes|base64/);
  });
  withKey(Buffer.alloc(16).toString('base64'), () => {
    assert.throws(() => encrypt('x'), /32 bytes/);
  });
});

test('isEncrypted recognises the v1 shape and nothing else', () => {
  assert.strictEqual(isEncrypted(`${VERSION}:iv:tag:ct`), true);
  assert.strictEqual(isEncrypted('v1:'), false);
  assert.strictEqual(isEncrypted('v2:iv:tag:ct'), false);
  assert.strictEqual(isEncrypted(''), false);
  assert.strictEqual(isEncrypted(null), false);
  assert.strictEqual(isEncrypted(42), false);
});

test('generateKey produces something the module accepts', () => {
  const key = generateKey();
  withKey(key, () => {
    assert.strictEqual(hasKey(), true);
    assert.strictEqual(decrypt(encrypt('ok')), 'ok');
  });
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   -', name);
      passed++;
    } catch (err) {
      console.error('FAIL -', name);
      console.error('      ', err && err.message ? err.message : err);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} entry-crypto tests passed.`);
})();
