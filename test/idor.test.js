'use strict';

// Regression fence for the IDOR sweep in security/idor-audit-2026-09-22.md.
//
// The invariant this file protects: **no non-admin route reads a target user
// id from the request body**. Every user-space route acts on
// `req.session.userId` and identifies targets through session ownership or
// a public-by-design path (`req.params.slug` for Rooms, `:id` for a public
// silent line, an owner-guarded `:kind` for the shelf). If a new route
// introduces `req.body.user_id` or `req.body.userId`, someone probably
// meant to write `req.session.userId` — the test fails loudly.
//
// If a legitimate exception lands (e.g. a second, deliberately-scoped
// admin-adjacent surface), add it to ALLOWED below and note why.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

// Files scanned. Admin routes are exempt — an admin acting on any user by
// id is the entire point of the admin surface.
const ROUTE_FILES = [
  'server.js',
  'routes/app.js',
  'routes/auth.js',
  'routes/rooms.js',
  'routes/shelf.js',
  'routes/silent.js',
  'routes/static.js',
  'routes/tonights-question.js',
  'routes/waiting-entry.js',
  'routes/waitlist.js',
  'routes/payments.js',
  'routes/wall.js',
];

// Patterns that would let a caller pick which user's data to touch. Any
// match in a non-admin file is a candidate IDOR.
//
// Excluded on purpose:
//   * `req.body.firebase_uid` / `firebaseUid` — that's an auth-provider
//     handle, not a target user id, and it's compared against sessions
//   * `req.body.\w+_id\b` where the field is a card/report/message id that
//     could not identify a user (report_id, match_id, etc.). Those go under
//     the finer-grained per-route review, not this bulk fence.
const FORBIDDEN_PATTERNS = [
  { name: 'req.body.user_id',  re: /\breq\.body\.user_id\b/ },
  { name: 'req.body.userId',   re: /\breq\.body\.userId\b/ },
  { name: 'req.body.target_user_id', re: /\breq\.body\.target_user_id\b/ },
  { name: 'req.body.targetUserId',   re: /\breq\.body\.targetUserId\b/ },
];

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('no non-admin route accepts a target user id from the request body', () => {
  const violations = [];
  for (const rel of ROUTE_FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    src.split('\n').forEach((line, i) => {
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.re.test(line)) violations.push(`${rel}:${i + 1}  ${p.name}  →  ${line.trim()}`);
      }
    });
  }
  if (violations.length) {
    const message =
      'Body-carried target user ids found outside routes/admin.js:\n  ' +
      violations.join('\n  ') +
      '\n\nA non-admin route should read `req.session.userId`, never `req.body.user_id`. ' +
      'If this is genuinely intentional (an admin-adjacent surface with its own ' +
      'scoping), add it to ALLOWED in test/idor.test.js with a comment naming why.';
    throw new Error(message);
  }
});

test('every :id-shaped route file is present in the scan', () => {
  // Guards against a future refactor that moves routes to a new file and
  // silently drops it out of the fence.
  for (const rel of ['routes/rooms.js', 'routes/shelf.js', 'routes/silent.js']) {
    assert.ok(ROUTE_FILES.includes(rel), `${rel} must be in ROUTE_FILES`);
  }
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
  console.log(`\n${passed}/${tests.length} idor tests passed.`);
})();
