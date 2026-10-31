const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'public-analytics.js'), 'utf8');

function page(pathname, storedChoice, storedRecording, search = '', storedMeta = null, referrer = '') {
  const storage = new Map();
  if (storedChoice) storage.set('mp_analytics_consent_v2', storedChoice);
  if (storedRecording) storage.set('mp_public_clarity_consent_v1', storedRecording);
  if (storedMeta) storage.set('mp_public_meta_ads_consent_v1', storedMeta);
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
  const window = { location: { pathname, search, hash: '', reload: () => { reloads++; } } };
  const document = { title: 'Public page', referrer, cookie: '', createElement: makeElement, head: { appendChild }, body: { appendChild }, addEventListener: (name, callback) => { documentListeners[name] = callback; } };
  vm.runInNewContext(source, {
    window,
    document,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    Date,
    URL
  });
  return {
    window, storage, elements, documentListeners,
    tags: () => elements.filter((element) => element.tag === 'script' && element.src && element.src.includes('googletagmanager.com')),
    clarityTags: () => elements.filter((element) => element.tag === 'script' && element.src && element.src.includes('clarity.ms/tag/')),
    metaTags: () => elements.filter((element) => element.tag === 'script' && element.src && element.src.includes('connect.facebook.net/en_US/fbevents.js')),
    metaBanner: () => elements.find((element) => element.className === 'mp-analytics-choice mp-meta-choice'),
    metaSettings: () => elements.find((element) => element.className === 'mp-analytics-settings mp-meta-settings'),
    banner: () => elements.find((element) => element.className === 'mp-analytics-choice mp-cookie-choice'),
    settings: () => elements.find((element) => element.className === 'mp-analytics-settings'),
    reloads: () => reloads
  };
}

const undecided = page('/');
assert.equal(undecided.tags().length, 0, 'Google tag must not load before consent');
assert.equal(undecided.clarityTags().length, 0, 'session recordings must never load');
assert.equal(undecided.metaTags().length, 0, 'Meta must not load');
assert.equal(undecided.metaBanner(), undefined, 'homepage must not show a Meta prompt');
assert.equal(undecided.metaSettings(), undefined, 'homepage must not show Meta settings');
assert.ok(undecided.banner(), 'undecided visitors see a choice');
assert.ok(undecided.banner().innerHTML.includes('<h2>This website uses cookies</h2>'), 'banner clearly identifies cookie choices');
assert.ok(undecided.banner().innerHTML.includes('Deny optional cookies'), 'banner offers an explicit denial choice');
assert.ok(!undecided.banner().innerHTML.includes('recording'), 'cookie banner offers no recording choice');
undecided.banner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.equal(undecided.metaBanner(), undefined, 'rejecting analytics must not reveal a second prompt');
assert.equal(undecided.tags().length, 0, 'declining must not load Google');
assert.equal(undecided.clarityTags().length, 0, 'declining must not load recordings');
assert.equal(undecided.storage.get('mp_analytics_consent_v2'), 'denied');

const accepted = page('/privacy.html', 'granted', null, '?private=do-not-send');
assert.equal(accepted.tags().length, 1, 'accepted public page loads one Google tag');
assert.equal(accepted.clarityTags().length, 0, 'prior Google consent does not enable recordings');
assert.equal(accepted.banner(), undefined, 'prior Google consent does not prompt for recordings');
const config = accepted.window.dataLayer.find((entry) => entry[0] === 'config');
assert.equal(config[2].page_location, 'https://mymentallyprepare.com/privacy', 'GA URL must omit query data and normalize the path');
assert.equal(config[2].send_page_view, false, 'automatic page views must stay disabled');
assert.equal(config[2].allow_google_signals, false, 'Google signals must stay disabled');
const organic = page('/', 'granted', null, '', null, 'https://www.google.com/search?q=private+query');
const organicConfig = organic.window.dataLayer.find((entry) => entry[0] === 'config');
assert.equal(organicConfig[2].page_referrer, 'https://www.google.com/', 'organic referrer keeps the search engine but drops the query');
const unrelated = page('/', 'granted', null, '', null, 'https://example.org/private/path');
assert.equal(unrelated.window.dataLayer.find((entry) => entry[0] === 'config')[2].page_referrer, '', 'unrelated referrers remain hidden');
accepted.settings().listeners.click();
accepted.banner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.equal(accepted.storage.get('mp_analytics_consent_v2'), 'denied', 'choice can be withdrawn');
assert.equal(accepted.reloads(), 1, 'withdrawal reloads to stop the tag');

const recordings = page('/', 'granted', 'granted');
assert.equal(recordings.tags().length, 1, 'new analytics consent loads Google Analytics');
assert.equal(recordings.clarityTags().length, 0, 'old recording consent no longer loads Clarity');
assert.equal(recordings.banner(), undefined, 'old recording consent does not trigger a prompt');
assert.equal(recordings.metaTags().length, 0, 'old recording consent never grants Meta');

const newConsent = page('/');
newConsent.banner().listeners.click({ target: { getAttribute: () => 'granted' } });
assert.equal(newConsent.tags().length, 1, 'new analytics consent loads Google');
assert.equal(newConsent.clarityTags().length, 0, 'new analytics consent does not load recordings');

const queryPage = page('/blog', 'granted', 'granted', '?email=private');
assert.equal(queryPage.clarityTags().length, 0, 'Clarity skips URLs with query details');
assert.equal(queryPage.metaTags().length, 0, 'blog pages never load Meta');

for (const path of ['/', '/about', '/safety', '/privacy', '/terms', '/app', '/blog/feeling-lonely-in-college']) {
  const oldGrant = page(path, 'denied', 'denied', '', 'granted');
  assert.equal(oldGrant.metaTags().length, 0, `${path} must not load Meta even with a stored grant`);
  assert.equal(oldGrant.metaBanner(), undefined, `${path} must not show a Meta prompt`);
  if (path !== '/app') assert.equal(oldGrant.storage.get('mp_public_meta_ads_consent_v1'), 'denied', `${path} clears an old Meta grant`);
}
assert.equal(page('/', 'denied', 'denied', '?email=private', 'granted').metaTags().length, 0, 'query URLs never load Meta');
assert.equal(page('/about', 'granted', 'denied').tags().length, 1, 'About uses the public analytics consent');

const privateApp = page('/app', 'granted', 'granted');
assert.equal(privateApp.tags().length, 0, 'private app never loads Google Analytics');
assert.equal(privateApp.clarityTags().length, 0, 'private app never loads Clarity');
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

const home = page('/', 'granted');
home.documentListeners.click(ctaLink('/app?screen=s-signup', 'home-hero-signup'));
home.documentListeners.click(ctaLink('/app', 'home-hero-scan'));
assert.equal(eventsNamed(home, 'cta_click').length, 2, 'both homepage entry choices are measured');
assert.equal(eventsNamed(home, 'sign_up_start').length, 1, 'only direct signup is counted as a signup start');

const blogUndecided = page('/blog/feeling-lonely-in-college');
blogUndecided.documentListeners.click(ctaLink('/app?screen=s-signup', 'blog-nav'));
assert.equal(blogUndecided.window.dataLayer, undefined, 'CTA clicks send nothing before consent');

const unknownPath = page('/blogs/feeling-lonely-in-college', 'granted');
assert.equal(unknownPath.tags().length, 0, 'unlisted paths never load Google');
assert.equal(unknownPath.clarityTags().length, 0, 'unlisted paths never load Clarity');

for (const name of ['index', 'about', 'safety', 'privacy', 'terms']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
  assert.ok(html.includes('/public-analytics.js'), `${name} must include the consent script`);
}
for (const name of ['index', 'feeling-lonely-in-college']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'content', 'blog', `${name}.html`), 'utf8');
  assert.ok(html.includes('/public-analytics.js'), `blog ${name} must include the consent script`);
}
assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8').includes('/public-analytics.js'), 'private app must not include the consent script');
assert.ok(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8').includes('/private-analytics.js'), 'app includes consent-gated milestone tracking');

const privateSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'private-analytics.js'), 'utf8');
function privatePage(choice) {
  const scripts = [];
  const window = {};
  const document = { head: { appendChild: (script) => scripts.push(script) }, createElement: () => ({}) };
  vm.runInNewContext(privateSource, { window, document, localStorage: { getItem: () => choice }, Date, Set });
  return { window, scripts };
}
const privateDenied = privatePage('denied');
assert.equal(privateDenied.scripts.length, 0, 'private app sends nothing without consent');
const privateGranted = privatePage('granted');
assert.equal(privateGranted.scripts.length, 1, 'private app loads one tag with consent');
privateGranted.window.mpGaTrack('sign_up');
privateGranted.window.mpGaTrack('journal_text');
assert.equal(privateGranted.window.dataLayer.filter((entry) => entry[0] === 'event').length, 1, 'private app sends only allowlisted milestone names');

console.log('public analytics consent checks passed');
