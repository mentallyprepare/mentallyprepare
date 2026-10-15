'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script, 'admin dashboard script exists');

const elements = new Map();
for (const id of ['admin-email', 'admin-password', 'admin-key', 'admin-login-submit',
  'admin-login-switch', 'named-admin-login', 'legacy-admin-login', 'login-error',
  'login-overlay', 'dashboard', 'admin-refresh']) {
  elements.set(id, { value: '', style: { display: id === 'dashboard' ? 'none' : 'grid' },
    hidden: id === 'legacy-admin-login', disabled: false, textContent: '' });
}

const requests = [];
let namedResult = { ok: true, status: 200 };
let legacyResult = { ok: false, status: 401 };
let loads = 0;
const context = {
  document: { getElementById: id => elements.get(id) },
  fetch: async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/admin/login') return namedResult;
    if (url === '/admin/me') return legacyResult;
    return { ok: true, status: 200 };
  },
  clearInterval() {},
  setInterval() { return 1; },
  console
};
vm.createContext(context);
vm.runInContext(script, context);
const realLoadAll = context.loadAll;

(async () => {
  // Let the initial session-restore probe settle before exercising login.
  await new Promise(resolve => setImmediate(resolve));
  context.loadAll = () => { loads += 1; };

  elements.get('admin-email').value = 'founder@example.com';
  elements.get('admin-password').value = 'correct-password';
  await context.tryLogin();
  assert.strictEqual(elements.get('dashboard').style.display, 'block');
  assert.strictEqual(elements.get('login-overlay').style.display, 'none');
  assert.strictEqual(elements.get('admin-password').value, '');
  assert.strictEqual(loads, 1);
  const namedRequest = requests.find(r => r.url === '/admin/login');
  assert(namedRequest, 'named login reaches the session endpoint');
  assert.strictEqual(namedRequest.options.credentials, 'same-origin');
  assert.strictEqual(JSON.parse(namedRequest.options.body).email, 'founder@example.com');
  assert(!Object.hasOwn(context.adminHeaders(), 'x-admin-key'));

  await context.logoutAdmin();
  assert(requests.some(r => r.url === '/admin/logout'), 'session logout reaches the server');
  assert.strictEqual(elements.get('login-overlay').style.display, 'grid');

  namedResult = { ok: false, status: 401 };
  elements.get('admin-email').value = 'founder@example.com';
  elements.get('admin-password').value = 'wrong-password';
  await context.tryLogin();
  assert.strictEqual(elements.get('dashboard').style.display, 'none');
  assert.match(elements.get('login-error').textContent, /incorrect/);
  assert.strictEqual(elements.get('admin-password').value, '');

  context.toggleAdminLoginMode();
  assert.strictEqual(elements.get('legacy-admin-login').hidden, false);
  assert.strictEqual(elements.get('named-admin-login').hidden, true);
  legacyResult = { ok: true, status: 200 };
  elements.get('admin-key').value = 'shared-secret';
  await context.tryLogin();
  assert.strictEqual(elements.get('dashboard').style.display, 'block');
  assert.strictEqual(context.adminHeaders()['x-admin-key'], 'shared-secret');
  assert.strictEqual(elements.get('admin-key').value, '');
  await context.logoutAdmin();
  assert(!Object.hasOwn(context.adminHeaders(), 'x-admin-key'));

  const starts = [];
  for (const name of ['loadHealth', 'loadReports', 'loadStats', 'loadUsers',
    'loadMatchDebug', 'loadReengagement', 'loadWaitlist', 'loadActivityFeed',
    'loadLogs', 'loadSilentPending', 'loadSilentCrisis']) {
    context[name] = async () => { starts.push(name); return null; };
  }
  context.showAlerts = () => {};
  await Promise.all([realLoadAll(), realLoadAll()]);
  assert.strictEqual(starts.length, 11, 'overlapping refreshes share one load');
  assert.strictEqual(elements.get('admin-refresh').disabled, false);

  console.log('6/6 admin login and refresh UI checks passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
