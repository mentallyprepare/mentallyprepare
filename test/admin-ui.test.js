'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const lines = html.split(/\r?\n/);

function loadFunction(name, context) {
  const source = lines.find(line => line.startsWith(`function ${name}(`));
  assert(source, `${name} function exists`);
  vm.runInNewContext(source, context);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, classList: { add() {} } });
  return elements.get(id);
}

const malicious = 'Alice" onmouseover="alert(1)';
const context = {
  document: { getElementById: element },
  escHtml: escapeHtml,
  timeAgo: () => 'today',
  archetypeEmoji: {},
  localStorage: { getItem: () => '{}' },
  reVisible: () => [{ id: 1, name: 'Alice', email: 'alice@example.test', college: 'College',
    status: 'active_today', suggestedSubject: malicious, suggestedEmailBody: malicious }],
  reUsers: [],
  reChip: () => '<span>Active</span>'
};
vm.createContext(context);
loadFunction('renderUsersTable', context);
loadFunction('renderReengagement', context);

context.renderUsersTable([{ id: 1, name: malicious, college: 'College', year: '1st', created_at: 'today' }]);
const userHtml = element('users-tbody').innerHTML;
assert.match(userHtml, /onclick="confirmRemoveUser\(1,&quot;Alice/);
assert.doesNotMatch(userHtml, /onclick="confirmRemoveUser\(1,"/);
assert.doesNotMatch(userHtml, /onmouseover="alert\(1\)"/);

context.renderReengagement();
const reHtml = element('re-list').innerHTML;
assert.match(reHtml, /onclick="copyText\(&quot;Alice/);
assert.doesNotMatch(reHtml, /onclick="copyText\("/);
assert.doesNotMatch(reHtml, /onmouseover="alert\(1\)"/);

console.log('2/2 admin rendering tests passed.');
