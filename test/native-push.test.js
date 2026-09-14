'use strict';

const assert = require('assert');
const {
  EXPO_PUSH_URL,
  isExpoPushToken,
  normalizePlatform,
  sendExpoPush,
} = require('../lib/native-push');
const { COPY, selectNotificationCopy } = require('../lib/notification-copy');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('accepts current Expo token formats only', () => {
  assert.strictEqual(isExpoPushToken('ExpoPushToken[abc_123-xyz]'), true);
  assert.strictEqual(isExpoPushToken('ExponentPushToken[abc123]'), true);
  assert.strictEqual(isExpoPushToken('https://example.com/not-a-token'), false);
});

test('accepts only native mobile platforms', () => {
  assert.strictEqual(normalizePlatform('android'), 'android');
  assert.strictEqual(normalizePlatform('ios'), 'ios');
  assert.strictEqual(normalizePlatform('web'), null);
});

test('sends neutral payload through Expo without sound', async () => {
  let captured;
  const result = await sendExpoPush({
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({ data: { status: 'ok', id: 'ticket-1' } }),
      };
    },
    token: 'ExpoPushToken[abc123]',
    title: 'Tonight is open.',
    body: 'One question is ready.',
    data: { route: '/rooms', type: 'night_open' },
  });
  assert.deepStrictEqual(result, { ok: true, terminal: false, ticketId: 'ticket-1' });
  assert.strictEqual(captured.url, EXPO_PUSH_URL);
  assert.strictEqual(captured.body.sound, null);
  assert.strictEqual(captured.body.data.route, '/rooms');
});

test('marks DeviceNotRegistered as terminal', async () => {
  const result = await sendExpoPush({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: {
          status: 'error',
          details: { error: 'DeviceNotRegistered' },
        },
      }),
    }),
    token: 'ExpoPushToken[deadDevice]',
    title: 'Mentally Prepare',
    body: 'Something is ready.',
    data: {},
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.terminal, true);
});

test('reviewed copy is deterministic and contains no private payload fields', () => {
  assert.deepStrictEqual(
    selectNotificationCopy('daily_reflection', 'user-1:2026-07-29'),
    selectNotificationCopy('daily_reflection', 'user-1:2026-07-29'),
  );
  for (const rows of Object.values(COPY)) {
    for (const row of rows) {
      assert.deepStrictEqual(Object.keys(row).sort(), ['body', 'route', 'title']);
      assert.ok(row.title.length <= 60);
      assert.ok(row.body.length <= 140);
    }
  }
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   -', name);
      passed += 1;
    } catch (error) {
      console.error('FAIL -', name);
      console.error('      ', error.message);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} native push tests passed.`);
})();
