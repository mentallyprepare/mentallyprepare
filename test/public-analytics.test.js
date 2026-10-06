const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'public-analytics.js'), 'utf8');

function page(pathname, storedChoice) {
  const storage = new Map(storedChoice ? [['mp_public_analytics_consent_v1', storedChoice]] : []);
  const elements = [];
  const documentListeners = {};
  let reloads = 0;
  const makeElement = (tag) => {
    const element = {
      tag,
      attrs: {},
      listeners: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      getAttribute(name) { return this.attrs[name] || null; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      remove() { elements.splice(elements.indexOf(this), 1); }
    };
    return element;
  };
  const appendChild = (element) => { elements.push(element); return element; };
  const window = { location: { pathname, search: '?private=do-not-send', reload: () => { reloads++; } } };
  const document = { title: 'Public page', cookie: '', createElement: makeElement, head: { appendChild }, body: { appendChild }, addEventListener: (name, callback) => { documentListeners[name] = callback; } };
  vm.runInNewContext(source, {
    window,
    document,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    Date
  });
  return {
    window, storage, elements, documentListeners,
    tags: () => elements.filter((element) => element.tag === 'script' && element.src && element.src.includes('googletagmanager.com')),
    banner: () => elements.find((element) => element.className === 'mp-analytics-choice'),
    settings: () => elements.find((element) => element.className === 'mp-analytics-settings'),
    reloads: () => reloads
  };
}

const undecided = page('/');
assert.equal(undecided.tags().length, 0, 'Google tag must not load before consent');
assert.ok(undecided.banner(), 'undecided visitors see a choice');
undecided.banner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.equal(undecided.tags().length, 0, 'declining must not load Google');
assert.equal(undecided.storage.get('mp_public_analytics_consent_v1'), 'denied');

const accepted = page('/privacy.html', 'granted');
assert.equal(accepted.tags().length, 1, 'accepted public page loads one Google tag');
const config = accepted.window.dataLayer.find((entry) => entry[0] === 'config');
assert.equal(config[2].page_location, 'https://mymentallyprepare.com/privacy', 'GA URL must omit query data and normalize the path');
assert.equal(config[2].send_page_view, false, 'automatic page views must stay disabled');
assert.equal(config[2].allow_google_signals, false, 'Google signals must stay disabled');
accepted.settings().listeners.click();
accepted.banner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.equal(accepted.storage.get('mp_public_analytics_consent_v1'), 'denied', 'choice can be withdrawn');
assert.equal(accepted.reloads(), 1, 'withdrawal reloads to stop the tag');

const privateApp = page('/app', 'granted');
assert.equal(privateApp.tags().length, 0, 'private app never loads Google Analytics');
assert.equal(privateApp.banner(), undefined, 'private app has no public analytics UI');

const blogPost = page('/blog/feeling-lonely-in-college/', 'granted');
assert.equal(blogPost.tags().length, 1, 'blog articles load the Google tag after consent');
const blogConfig = blogPost.window.dataLayer.find((entry) => entry[0] === 'config');
assert.equal(blogConfig[2].page_location, 'https://mymentallyprepare.com/blog/feeling-lonely-in-college', 'blog URL is normalized without a trailing slash');
assert.ok(page('/blog', 'granted').tags().length === 1, 'blog index is a public page');

function ctaLink(href, id) {
  const link = { getAttribute: (name) => ({ href, 'data-mp-cta': id })[name] || null };
  return { target: { closest: (selector) => (selector === 'a[data-mp-cta]' ? link : null) } };
}
const eventsNamed = (p, name) => p.window.dataLayer.filter((entry) => entry[0] === 'event' && entry[1] === name);
blogPost.documentListeners.click(ctaLink('/app?screen=s-signup', 'blog-feeling-lonely-in-college'));
assert.equal(eventsNamed(blogPost, 'cta_click').length, 1, 'CTA click is recorded');
assert.equal(eventsNamed(blogPost, 'cta_click')[0][2].cta_id, 'blog-feeling-lonely-in-college');
assert.equal(eventsNamed(blogPost, 'sign_up_start').length, 1, 'sign-up CTA records sign_up_start');
blogPost.documentListeners.click(ctaLink('/safety', 'safety-link'));
assert.equal(eventsNamed(blogPost, 'sign_up_start').length, 1, 'non-sign-up CTA does not record sign_up_start');

const blogUndecided = page('/blog/feeling-lonely-in-college');
blogUndecided.documentListeners.click(ctaLink('/app?screen=s-signup', 'blog-nav'));
assert.equal(blogUndecided.window.dataLayer, undefined, 'CTA clicks send nothing before consent');

const unknownPath = page('/blogs/feeling-lonely-in-college', 'granted');
assert.equal(unknownPath.tags().length, 0, 'unlisted paths never load Google');

for (const name of ['index', 'safety', 'privacy', 'terms']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
  assert.ok(html.includes('/public-analytics.js'), `${name} must include the consent script`);
}
for (const name of ['index', 'feeling-lonely-in-college']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'content', 'blog', `${name}.html`), 'utf8');
  assert.ok(html.includes('/public-analytics.js'), `blog ${name} must include the consent script`);
}
assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8').includes('/public-analytics.js'), 'private app must not include the consent script');

console.log('public analytics consent checks passed');
