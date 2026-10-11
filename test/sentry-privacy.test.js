'use strict';

const assert = require('assert');
const { discardBreadcrumb, sanitizeCrashEvent } = require('../lib/sentry-privacy');

const privateUrl = 'https://fcm.googleapis.com/fcm/send/private-device-token';
const event = {
  exception: { values: [{ type: 'Error', value: 'Parse Error' }] },
  request: { method: 'POST', url: 'https://mymentallyprepare.com/app?private=1' },
  user: { id: '123', email: 'private@example.com' },
  breadcrumbs: [{ category: 'http', data: { url: privateUrl } }],
  extra: { note: 'private journal content' },
  tags: { url: privateUrl },
};

assert.strictEqual(discardBreadcrumb({ category: 'http', data: { url: privateUrl } }), null);
assert.strictEqual(discardBreadcrumb({ category: 'console', message: 'private content' }), null);

const sanitized = sanitizeCrashEvent(event);
assert.deepStrictEqual(sanitized, {
  exception: { values: [{ type: 'Error', value: 'Parse Error' }] },
});
assert.ok(!JSON.stringify(sanitized).includes('private-device-token'));
console.log('Sentry crash-event privacy checks passed');
