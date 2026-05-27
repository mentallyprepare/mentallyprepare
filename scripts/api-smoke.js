#!/usr/bin/env node

const { mkdtemp, rm } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.SMOKE_PORT) || 18000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;

let server = null;
let dataDir = null;
let output = '';

function log(message) {
  console.log(message);
}

function fail(message) {
  throw new Error(message);
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  fail(`Server did not become healthy. Output:\n${output.slice(-4000)}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { response, text, data };
}

function assertStatus(result, expected, label) {
  if (result.response.status !== expected) {
    fail(`${label} returned ${result.response.status}, expected ${expected}: ${result.text}`);
  }
  log(`ok  - ${label}`);
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie');
  if (!header) return '';
  return header.split(',').map(part => part.split(';')[0]).join('; ');
}

async function main() {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mp-api-smoke-'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: 'test',
      SESSION_SECRET: 'api-smoke-session-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });

  await waitForServer();
  log(`ok  - local server started on ${baseUrl}`);

  const health = await request('/api/health');
  assertStatus(health, 200, '/api/health');
  if (!health.data || health.data.status !== 'ok') fail('/api/health did not return ok');

  const ready = await request('/api/ready');
  assertStatus(ready, 200, '/api/ready');
  if (!ready.data || ready.data.status !== 'ready') fail('/api/ready did not return ready');

  const email = `api-smoke-${Date.now()}@example.com`;
  const register = await request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'API Smoke',
      college: 'Not provided',
      email,
      password: 'api-smoke-password',
      year: '3rd',
      gender: 'prefer_not_to_say',
      matchGenderPref: 'any',
      matchYearPref: 'any',
      consentGiven: true,
      ageConfirmed: true
    })
  });
  assertStatus(register, 200, '/api/register');
  if (!register.data || register.data.ok !== true) fail('/api/register did not return ok');

  const cookie = cookieFrom(register.response);
  if (!cookie) fail('/api/register did not set a session cookie');
  log('ok  - registration returned a session cookie');

  const profile = await request('/api/profile/basics', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({ college: 'University of Delhi', year: '2nd' })
  });
  assertStatus(profile, 200, '/api/profile/basics');
  if (!profile.data || profile.data.ok !== true) fail('/api/profile/basics did not return ok');

  const me = await request('/api/me', { headers: { Cookie: cookie } });
  assertStatus(me, 200, '/api/me');
  if (!me.data || !me.data.user) fail('/api/me did not return a user');
  if (me.data.user.college !== 'University of Delhi') fail(`/api/me returned wrong college: ${me.data.user.college}`);
  if (me.data.user.year !== '2nd') fail(`/api/me returned wrong year: ${me.data.user.year}`);
  log('ok  - profile basics persisted');

  const secondProfileUpdate = await request('/api/profile/basics', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({ college: 'Different College', year: '4th' })
  });
  assertStatus(secondProfileUpdate, 409, '/api/profile/basics second update');
  log('ok  - completed profile basics cannot be overwritten');

  log('API smoke check passed.');
}

async function cleanup() {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

main()
  .catch((error) => {
    console.error(`fail - ${error.message || error}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
