'use strict';

// One prompt a week — the blog capture point.
//
// What this fence protects: the endpoint answers the same way for a new and a
// known address (no enumeration), a bad address is rejected, the table keeps
// one row per address with one unsubscribe token, the admin view is guarded,
// and no email address can reach analytics or a log line.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const { registerPromptListRoutes, normaliseEmail, normaliseSource } = require('../routes/prompt-list');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(read('migrations', '0002_prompt_list.sql'));
  return db;
}

function makeApp() {
  const routes = {};
  const app = {
    post(route, ...chain) { routes['POST ' + route] = chain; },
    get(route, ...chain) { routes['GET ' + route] = chain; },
  };
  return { app, routes };
}

// Run a registered chain the way express would, so a missing guard fails here.
function invoke(chain, req, res) {
  let index = 0;
  const next = () => {
    const fn = chain[index];
    index += 1;
    if (fn) fn(req, res, next);
  };
  next();
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    type() { return this; },
    send(payload) { this.body = payload; return this; },
  };
}

const db = makeDb();
const { app, routes } = makeApp();
registerPromptListRoutes(app, {
  db,
  requireAdmin: (req, res, next) => next(),
  authLimiter: (req, res, next) => next(),
  promptLimiter: (req, res, next) => next(),
});

const subscribe = routes['POST /api/prompt-subscribe'];
const unsubscribe = routes['GET /prompts/unsubscribe'];
const adminList = routes['GET /admin/prompt-list'];
assert.ok(subscribe && unsubscribe && adminList, 'all three routes register');

// 1. A bad address is rejected and stores nothing.
{
  const res = makeRes();
  invoke(subscribe, { body: { email: 'not-an-email', source: 'blog' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_subscribers').get().n, 0);
}

// 2. A good address is stored once, normalised, with a source and a token.
{
  const res = makeRes();
  invoke(subscribe, { body: { email: 'Reader@Example.COM ', source: 'how-to-start-journaling' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  const row = db.prepare('SELECT * FROM prompt_subscribers').get();
  assert.equal(row.email, 'reader@example.com', 'addresses are normalised before storage');
  assert.equal(row.source, 'how-to-start-journaling');
  assert.match(row.token, /^[a-f0-9]{48}$/);
}

// 3. The same address twice looks identical to the client and creates no second row.
{
  const res = makeRes();
  invoke(subscribe, { body: { email: 'reader@example.com', source: 'some-other-article' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true }, 'a known address answers exactly like a new one');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_subscribers').get().n, 1);
}

// 4. An unknown source falls back instead of being stored raw.
{
  const res = makeRes();
  invoke(subscribe, { body: { email: 'second@example.com', source: 'DROP TABLE users' } }, res);
  const row = db.prepare("SELECT source FROM prompt_subscribers WHERE email = 'second@example.com'").get();
  assert.equal(row.source, 'blog');
}

// 5. Unsubscribing needs the token, and works exactly once.
{
  const token = db.prepare("SELECT token FROM prompt_subscribers WHERE email = 'reader@example.com'").get().token;

  const noToken = makeRes();
  invoke(unsubscribe, { query: {} }, noToken);
  assert.equal(noToken.statusCode, 400);

  const wrongToken = makeRes();
  invoke(unsubscribe, { query: { token: 'f'.repeat(48) } }, wrongToken);
  assert.equal(wrongToken.statusCode, 404);

  const ok = makeRes();
  invoke(unsubscribe, { query: { token } }, ok);
  assert.equal(ok.statusCode, 200);
  const row = db.prepare("SELECT unsubscribed_at FROM prompt_subscribers WHERE email = 'reader@example.com'").get();
  assert.ok(row.unsubscribed_at, 'the row is marked unsubscribed, not deleted');
}

// 6. The admin list is behind the admin guard and carries no journal data.
{
  let guarded = false;
  const { app: guardedApp, routes: guardedRoutes } = makeApp();
  registerPromptListRoutes(guardedApp, {
    db,
    requireAdmin: (req, res, next) => { guarded = true; next(); },
    authLimiter: (req, res, next) => next(),
    promptLimiter: (req, res, next) => next(),
  });
  const res = makeRes();
  invoke(guardedRoutes['GET /admin/prompt-list'], {}, res);
  assert.equal(guarded, true, 'the admin list goes through requireAdmin');
  assert.ok(Array.isArray(res.body));
  assert.deepEqual(Object.keys(res.body[0]).sort(),
    ['created_at', 'email', 'id', 'source', 'unsubscribed_at']);
}

// 7. The article pages carry the form, tagged with their own slug.
{
  const { BLOG_POSTS } = require('../lib/blog-posts');
  const renderer = require('../lib/blog-renderer');
  const html = renderer.renderPost(BLOG_POSTS[0], root);
  assert.ok(html.includes('class="prompt-list-form"'), 'the article has the form');
  assert.ok(html.includes('data-source="' + BLOG_POSTS[0].slug + '"'), 'the form knows which article it came from');
  assert.ok(html.includes('/prompt-list.js'), 'the article loads the client');
}

// 8. The client posts to the endpoint and sends nothing else.
{
  const client = read('public', 'prompt-list.js');
  assert.ok(client.includes("'/api/prompt-subscribe'"), 'the client posts to the endpoint');
  assert.ok(!/gtag|mpGaTrack|localStorage/.test(client), 'the address never reaches analytics or storage');
  const route = read('routes', 'prompt-list.js');
  assert.ok(!/console\.(log|error)\([^)]*email/i.test(route), 'no email address in a log line');
}

console.log('Prompt list: capture, dedupe, unsubscribe and admin guard checks passed');
