'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const templates = require('../email-templates');
const { COPY } = require('../lib/notification-copy');

const html = [
  templates.waitlistConfirmationEmail('Sam', 4),
  templates.waitlistAcceptedEmail('Sam'),
  templates.loginWelcomeEmail('Sam', 3),
  templates.matchFoundEmail('Sam', 'reflective'),
  templates.dailyPromptReminderEmail('Sam', 3),
  templates.partnerWroteEmail('Sam', 'Private Partner Name', 3),
  templates.partnerStillWritingEmail('Sam')
].join('\n');

assert.doesNotMatch(html, /mentallyprepare\.in|\/journal|\/signup\b/i);
assert.match(html, /mymentallyprepare\.com/);
assert.doesNotMatch(html, /Private Partner Name|don't leave them waiting|within 24 hours|day 14 unlock/i);
assert.match(templates.dailyPromptReminderEmail('<script>alert(1)</script>', 3), /&lt;script&gt;/);
assert.doesNotMatch(templates.dailyPromptReminderEmail('<script>alert(1)</script>', 3), /<script>/);
for (const rows of Object.values(COPY)) {
  for (const row of rows) {
    assert.ok(['/app', '/'].includes(row.route), `unexpected route: ${row.route}`);
    assert.doesNotMatch(`${row.title} ${row.body}`, /partner name|don't leave|waiting for you|streak/i);
  }
}
for (const file of ['public/app.html', 'public/privacy.html', 'public/safety.html', 'public/terms.html']) {
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /@mentallyprepare\.in/i);
}
const privacy = fs.readFileSync(path.join(__dirname, '..', 'public/privacy.html'), 'utf8');
assert.doesNotMatch(privacy, /login and password reset only/i);
assert.match(privacy, /Nightly writing emails are off by default/);
console.log('Notification email copy checks passed');
