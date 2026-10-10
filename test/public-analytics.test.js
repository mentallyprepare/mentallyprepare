const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'public-analytics.js'), 'utf8');

function page(pathname, storedChoice, storedRecording, search = '', storedMeta = null) {
  const storage = new Map();
  if (storedChoice) storage.set('mp_public_analytics_consent_v1', storedChoice);
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
    clarityTags: () => elements.filter((element) => element.tag === 'script' && element.src && element.src.includes('clarity.ms/tag/')),
    metaTags: () => elements.filter((element) => element.tag === 'script' && element.src && element.src.includes('connect.facebook.net/en_US/fbevents.js')),
    metaBanner: () => elements.find((element) => element.className === 'mp-analytics-choice mp-meta-choice'),
    metaSettings: () => elements.find((element) => element.className === 'mp-analytics-settings mp-meta-settings'),
    banner: () => elements.find((element) => element.className === 'mp-analytics-choice'),
    settings: () => elements.find((element) => element.className === 'mp-analytics-settings'),
    reloads: () => reloads
  };
}

const undecided = page('/');
assert.equal(undecided.tags().length, 0, 'Google tag must not load before consent');
assert.equal(undecided.clarityTags().length, 0, 'Clarity must not load before separate consent');
assert.equal(undecided.metaTags().length, 0, 'Meta must not load before separate consent');
assert.ok(undecided.banner(), 'undecided visitors see a choice');
undecided.banner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.ok(undecided.metaBanner(), 'homepage asks separately for Meta advertising consent');
undecided.metaBanner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.equal(undecided.metaTags().length, 0, 'declining Meta keeps its script unloaded');
assert.equal(undecided.tags().length, 0, 'declining must not load Google');
assert.equal(undecided.clarityTags().length, 0, 'declining must not load Clarity');
assert.equal(undecided.storage.get('mp_public_analytics_consent_v1'), 'denied');

const accepted = page('/privacy.html', 'granted', null, '?private=do-not-send');
assert.equal(accepted.tags().length, 1, 'accepted public page loads one Google tag');
assert.equal(accepted.clarityTags().length, 0, 'prior Google consent does not enable recordings');
assert.ok(accepted.banner(), 'prior Google consent prompts for the new recording choice');
assert.ok(accepted.banner().innerHTML.includes('You already allow Google Analytics'), 'prior consent is described accurately');
const config = accepted.window.dataLayer.find((entry) => entry[0] === 'config');
assert.equal(config[2].page_location, 'https://mymentallyprepare.com/privacy', 'GA URL must omit query data and normalize the path');
assert.equal(config[2].send_page_view, false, 'automatic page views must stay disabled');
assert.equal(config[2].allow_google_signals, false, 'Google signals must stay disabled');
accepted.banner().listeners.click({ target: { getAttribute: () => 'granted' } });
assert.equal(accepted.clarityTags().length, 0, 'choosing no recordings keeps prior analytics only');
accepted.settings().listeners.click();
accepted.banner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.equal(accepted.storage.get('mp_public_analytics_consent_v1'), 'denied', 'choice can be withdrawn');
assert.equal(accepted.reloads(), 1, 'withdrawal reloads to stop the tag');

const recordings = page('/', 'granted', 'granted');
assert.equal(recordings.tags().length, 1, 'recording consent retains Google Analytics');
assert.equal(recordings.clarityTags().length, 1, 'separate recording consent loads Clarity');
assert.equal(recordings.metaTags().length, 0, 'analytics and recording consent never grants Meta');
assert.equal(recordings.clarityTags()[0].src, 'https://www.clarity.ms/tag/yujdrgc251');
assert.equal(recordings.window.clarity.q[0][0], 'consentv2', 'Clarity receives explicit consent');
assert.equal(recordings.window.clarity.q[0][1].ad_Storage, 'denied', 'advertising consent remains denied');
recordings.settings().listeners.click();
recordings.banner().listeners.click({ target: { getAttribute: () => 'granted' } });
assert.equal(recordings.storage.get('mp_public_clarity_consent_v1'), 'denied', 'recording consent can be withdrawn');
assert.equal(recordings.reloads(), 1, 'withdrawal reloads to stop recording');

const newConsent = page('/');
newConsent.banner().listeners.click({ target: { getAttribute: () => 'granted-recording' } });
assert.equal(newConsent.tags().length, 1, 'new analytics consent loads Google');
assert.equal(newConsent.clarityTags().length, 1, 'new recording consent loads Clarity');

const queryPage = page('/blog', 'granted', 'granted', '?email=private');
assert.equal(queryPage.clarityTags().length, 0, 'Clarity skips URLs with query details');
assert.equal(queryPage.metaTags().length, 0, 'blog pages never load Meta');

const metaAllowed = page('/', 'denied', 'denied');
metaAllowed.metaBanner().listeners.click({ target: { getAttribute: () => 'granted' } });
assert.equal(metaAllowed.metaTags().length, 1, 'only explicit Meta grant loads its script');
assert.equal(metaAllowed.window.fbq.queue.find((entry) => entry[0] === 'track')[1], 'PageView', 'only a homepage PageView is sent');
metaAllowed.metaSettings().listeners.click();
metaAllowed.metaBanner().listeners.click({ target: { getAttribute: () => 'denied' } });
assert.equal(metaAllowed.reloads(), 1, 'withdrawing Meta consent reloads to stop the tag');

for (const path of ['/about', '/safety', '/privacy', '/terms', '/app', '/blog/feeling-lonely-in-college']) {
  assert.equal(page(path, 'denied', 'denied', '', 'granted').metaTags().length, 0, `${path} must not load Meta even with stored consent`);
}
assert.equal(page('/', 'denied', 'denied', '?email=private', 'granted').metaTags().length, 0, 'Meta skips homepage URLs with query details');
assert.equal(page('/', 'denied', 'denied', '', 'granted').metaTags().length, 1, 'stored Meta consent loads on the clean homepage');
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

console.log('public analytics consent checks passed');
