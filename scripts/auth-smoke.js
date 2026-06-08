#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://mymentallyprepare.com';

const baseUrl = normalizeBaseUrl(process.argv[2] || process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL);
const expectSameOriginAuth = process.env.EXPECT_SAME_ORIGIN_AUTH_DOMAIN === 'true';
const expectedScriptVersion = process.env.EXPECTED_APP_VERSION || process.env.EXPECT_APP_SCRIPT_VERSION || 'landing-tabs-fix-20260607';

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, '');
}

function pass(message) {
  console.log(`ok  - ${message}`);
}

function info(message) {
  console.log(`info - ${message}`);
}

function fail(message) {
  console.error(`fail - ${message}`);
  process.exitCode = 1;
}

async function getText(path) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  const text = await response.text();
  return { response, text };
}

async function getJson(path) {
  const { response, text } = await getText(path);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} did not return JSON. Status: ${response.status}`);
  }
  return { response, data };
}

function assertStatus(response, path, expectedStatus) {
  if (response.status !== expectedStatus) {
    fail(`${path} returned ${response.status}, expected ${expectedStatus}`);
    return false;
  }
  pass(`${path} returned ${expectedStatus}`);
  return true;
}

async function main() {
  console.log(`Mentally Prepare auth smoke check: ${baseUrl}`);

  const health = await getJson('/api/health');
  if (assertStatus(health.response, '/api/health', 200)) {
    if (health.data.status === 'ok') pass(`/api/health status is ok, version ${health.data.version || 'unknown'}`);
    else fail(`/api/health status is ${health.data.status || 'missing'}`);
  }

  const ready = await getJson('/api/ready');
  if (assertStatus(ready.response, '/api/ready', 200)) {
    if (ready.data.status === 'ready') pass('/api/ready status is ready');
    else fail(`/api/ready status is ${ready.data.status || 'missing'}`);
    info(`Firebase auth domain from readiness: ${ready.data.firebaseAuthDomain || 'not exposed'}`);
    info(`Same-origin Firebase auth enabled: ${ready.data.firebaseSameOriginAuthDomain === true}`);
  }

  const firebaseConfig = await getJson('/api/firebase-config');
  if (assertStatus(firebaseConfig.response, '/api/firebase-config', 200)) {
    if (firebaseConfig.data.enabled && firebaseConfig.data.config) pass('Firebase web config is enabled');
    else fail('Firebase web config is not enabled');
    const authDomain = firebaseConfig.data.config && firebaseConfig.data.config.authDomain;
    if (authDomain) pass(`Firebase authDomain is ${authDomain}`);
    else fail('Firebase authDomain is missing');

    if (expectSameOriginAuth) {
      const expectedHost = new URL(baseUrl).host.split(':')[0];
      if (authDomain === expectedHost) pass(`same-origin authDomain matches ${expectedHost}`);
      else fail(`same-origin authDomain mismatch: got ${authDomain}, expected ${expectedHost}`);
      if (ready.data.firebaseSameOriginAuthDomain === true) pass('same-origin auth flag is true');
      else fail('same-origin auth flag is not true');
    }
  }

  const authHandler = await getText('/__/auth/handler');
  if (assertStatus(authHandler.response, '/__/auth/handler', 200)) {
    if (authHandler.text.includes('handler.js')) pass('Firebase auth helper proxy returned handler page');
    else fail('Firebase auth helper proxy did not look like the Firebase handler page');
  }

  const app = await getText('/app');
  if (assertStatus(app.response, '/app', 200)) {
    if (app.text.includes(`/app.js?v=${expectedScriptVersion}`)) pass(`app loads ${expectedScriptVersion}`);
    else fail(`app does not load expected script version ${expectedScriptVersion}`);
  }

  if (process.exitCode) {
    console.error('Auth smoke check failed.');
    return;
  }
  console.log('Auth smoke check passed.');
}

main().catch((error) => {
  fail(error.message || error);
});
