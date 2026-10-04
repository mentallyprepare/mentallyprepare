const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'public-analytics.js'), 'utf8');

function page(pathname, storedChoice) {
  const storage = new Map(storedChoice ? [['mp_public_analytics_consent_v1', storedChoice]] : []);
  const elements = [];
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
  const document = { title: 'Public page', cookie: '', createElement: makeElement, head: { appendChild }, body: { appendChild } };
  vm.runInNewContext(source, {
    window,
    document,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    Date
  });
  return {
    window, storage, elements,
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

for (const name of ['index', 'safety', 'privacy', 'terms']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
  assert.ok(html.includes('/public-analytics.js'), `${name} must include the consent script`);
}
assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8').includes('/public-analytics.js'), 'private app must not include the consent script');

console.log('public analytics consent checks passed');
