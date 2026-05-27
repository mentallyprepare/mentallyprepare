#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  'server.js',
  'routes/admin.js',
  'routes/app.js',
  'routes/auth.js',
  'routes/payments.js',
  'routes/silent.js',
  'routes/static.js',
  'routes/tonights-question.js',
  'routes/waiting-entry.js',
  'routes/waitlist.js',
  'public/app.js',
  'public/sw.js',
  'scripts/auth-smoke.js'
];

let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  if (result.status === 0) {
    console.log(`ok  - ${file}`);
    continue;
  }

  failed = true;
  console.error(`fail - ${file}`);
  if (result.stdout) console.error(result.stdout.trim());
  if (result.stderr) console.error(result.stderr.trim());
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('Syntax check passed.');
}
