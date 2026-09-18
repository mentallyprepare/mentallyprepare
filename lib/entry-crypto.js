'use strict';

// Encryption at rest for the four sensitive text columns.
//
// What this protects: `entries.text`, `waiting_entries.text`,
// `tonights_question_entries.text`, `crisis_review.content` — every place a
// person's own words are stored in the database. A snapshot of the DB file
// (backup theft, provider incident, dev laptop compromise) yields ciphertext,
// not plaintext journal entries.
//
// What this does not protect: text while it lives in memory during a request,
// text in HTTP logs (routes should never log entry bodies), text served over
// TLS to the owner. Encryption at rest is not encryption end-to-end.
//
// Format · versioned single-string so the existing TEXT columns can hold it
// without a schema change:
//
//   v1:<base64url(iv 12 bytes)>:<base64url(tag 16 bytes)>:<base64url(ciphertext)>
//
// Backward-compat · `decrypt()` returns any input that does not match the v1
// format unchanged, so a database that still holds plaintext rows (before the
// one-time migration in scripts/encrypt-existing-entries.js runs) reads
// correctly. Once every row is encrypted, that branch is dead weight to
// remove — but harmless to keep.
//
// Key · one master key in `ENTRIES_ENCRYPTION_KEY` — 32 bytes, base64. The
// startup check in server.js REFUSES to boot in production without one, the
// same shape as SESSION_SECRET. In dev the helper becomes an identity map so
// nothing changes for local work that does not want a key.

const crypto = require('crypto');

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey = null;
let cachedKeyRaw = null;

function loadKey() {
  const raw = process.env.ENTRIES_ENCRYPTION_KEY;
  if (raw === cachedKeyRaw) return cachedKey;
  cachedKeyRaw = raw;
  if (!raw) {
    cachedKey = null;
    return null;
  }
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('ENTRIES_ENCRYPTION_KEY is set but not valid base64');
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `ENTRIES_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${buf.length}`,
    );
  }
  cachedKey = buf;
  return buf;
}

/** True iff a usable key is present. Startup check calls this to gate prod. */
function hasKey() {
  return loadKey() !== null;
}

/**
 * True iff `value` looks like a v1 encrypted payload. Used by the migration
 * script to skip rows that are already encrypted, and by tests.
 */
function isEncrypted(value) {
  if (typeof value !== 'string') return false;
  return value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

/**
 * Encrypt a plaintext string. If no key is configured, returns the plaintext
 * unchanged so dev environments and pre-migration deploys keep working — the
 * startup check is what forbids that state in production.
 *
 * Passing null / undefined / a non-string returns the value unchanged.
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') return plaintext;
  const key = loadKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

/**
 * Decrypt a v1 payload. Anything that does not match the v1 format is
 * returned unchanged so callers can wrap every read blindly — that lets a
 * database mid-migration serve rows in both formats without branching at
 * every call site.
 *
 * A tampered payload (bad auth tag) throws — callers can catch that if they
 * want, but a thrown error is the right signal: the row was corrupted or the
 * key rotated without a re-encrypt.
 */
function decrypt(payload) {
  if (!isEncrypted(payload)) return payload;
  const key = loadKey();
  if (!key) {
    // Ciphertext in the DB but no key present — either the deploy is broken
    // or the key was rotated away without a re-encrypt. Fail loud so this
    // does not silently render as gibberish in the UI.
    throw new Error('Encrypted payload found but ENTRIES_ENCRYPTION_KEY is not set');
  }
  const [, ivB64, tagB64, ctB64] = payload.split(':');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ct = Buffer.from(ctB64, 'base64url');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Generate a fresh key encoded the way ENTRIES_ENCRYPTION_KEY expects.
 * Ops helper — call from a REPL or a one-liner script when setting up a new
 * environment: `node -e "console.log(require('./lib/entry-crypto').generateKey())"`
 */
function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}

/** For tests that flip the key between assertions. */
function _resetKeyCacheForTests() {
  cachedKey = null;
  cachedKeyRaw = null;
}

module.exports = {
  VERSION,
  encrypt,
  decrypt,
  isEncrypted,
  hasKey,
  generateKey,
  _resetKeyCacheForTests,
};
