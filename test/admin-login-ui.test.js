'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const source = html.split(/\r?\n/).find(line => line.startsWith('function tryLogin('));
assert(source, 'tryLogin function exists');

const elements = new Map([
  ['admin-key', { value: 'secret' }],
  ['login-error', { style: { display: 'none' }, textContent: '' }],
  ['login-overlay', { style: { display: 'block' } }],
  ['dashboard', { style: { display: 'none' } }]
]);
let dashboardLoads = 0;
const context = {
  ADMIN_KEY: '',
  document: { getElementById: id => elements.get(id) },
  fetch: async url => url === '/api/health'
    ? { json: async () => ({ status: 'ok' }) }
    : { status: 500, ok: false },
  loadAll: () => { dashboardLoads += 1; },
  clearInterval() {},
  setInterval() {}
};
vm.createContext(context);
vm.runInNewContext(source, context);

(async () => {
  context.tryLogin();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(elements.get('login-overlay').style.display, 'block');
  assert.strictEqual(elements.get('dashboard').style.display, 'none');
  assert.strictEqual(dashboardLoads, 0);
  assert.strictEqual(elements.get('login-error').style.display, 'block');
  console.log('1/1 admin login UI tests passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
