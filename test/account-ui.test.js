'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const deleteAccountSource = source.match(/async function deleteAccount\(\) \{[\s\S]*?\n\}/);
assert(deleteAccountSource, 'deleteAccount function exists');

async function submitFor(provider, answer) {
  let request;
  let promptText;
  const context = {
    state: { user: { authProvider: provider } },
    prompt(text) { promptText = text; return answer; },
    confirm: () => true,
    fetch: async (_url, options) => { request = options; return { json: async () => ({ ok: false, error: 'test' }) }; },
    toast() {},
    sessionStorage: { removeItem() {} },
    showLanding() {}
  };
  vm.createContext(context);
  vm.runInNewContext(deleteAccountSource[0], context);
  await context.deleteAccount();
  return { promptText, body: JSON.parse(request.body) };
}

(async () => {
  const google = await submitFor('google', 'DELETE');
  assert.match(google.promptText, /DELETE/);
  assert.strictEqual(google.body.confirm, 'DELETE');

  const password = await submitFor('password', 'secret123');
  assert.match(password.promptText, /password/i);
  assert.strictEqual(password.body.password, 'secret123');
  console.log('2/2 account deletion UI tests passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
