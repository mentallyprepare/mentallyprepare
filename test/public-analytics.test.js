const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/public-analytics.js'), 'utf8');
const measurementId = 'G-8Y96FYSR01';

function link(href, id) {
  const attrs = { href, 'data-mp-cta': id };
  return {
    getAttribute: (key) => attrs[key] || null,
    setAttribute: (key, value) => { attrs[key] = value; },
    closest(selector) {
      return selector === 'a[href]' || (selector === 'a[data-mp-cta]' && id) ? this : null;
    }
  };
}

function page(pathname = '/', choice, options = {}) {
  const storage = new Map(Object.entries(options.storage || {}));
  if (choice) storage.set('mp_analytics_consent_v2', choice);
  const elements = [];
  const listeners = {};
  let reloads = 0;
  const document = {
    title: options.title || 'Public page',
    referrer: options.referrer || '',
    cookie: '',
    createElement(tag) {
      return {
        tag, attrs: {}, listeners: {},
        setAttribute(key, value) { this.attrs[key] = value; },
        getAttribute(key) { return this.attrs[key] || null; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        remove() { elements.splice(elements.indexOf(this), 1); }
      };
    },
    querySelector: () => options.signupScreen ? {} : null,
    querySelectorAll: () => options.links || [],
    addEventListener: (name, callback) => { listeners[name] = callback; },
    head: { appendChild: (element) => { elements.push(element); } },
    body: { appendChild: (element) => { elements.push(element); } }
  };
  const url = new URL('https://mymentallyprepare.com' + pathname + (options.search || ''));
  const window = { location: { pathname: url.pathname, search: url.search, href: url.href, origin: url.origin, reload: () => { reloads++; } } };
  vm.runInNewContext(source, {
    window, document, Date, URL, URLSearchParams,
    localStorage: {
      getItem(key) { if (options.storageBlocked) throw Error('blocked'); return storage.get(key) || null; },
      setItem(key, value) { if (options.storageBlocked) throw Error('blocked'); storage.set(key, value); }
    }
  });
  const banner = () => elements.find(e => e.className === 'mp-analytics-choice mp-cookie-choice');
  return {
    window, storage, elements, listeners, banner,
    choose: (value) => banner().listeners.click({ target: { getAttribute: () => value } }),
    settings: () => elements.find(e => e.className === 'mp-analytics-settings'),
    tags: () => elements.filter(e => e.tag === 'script'),
    events: (name) => (window.dataLayer || []).filter(e => e[0] === 'event' && e[1] === name),
    config: () => (window.dataLayer || []).find(e => e[0] === 'config')?.[2],
    reloads: () => reloads
  };
}

for (const pathname of ['/', '/app', '/app/', '/app.html', '/signup', '/scan', '/onboarding', '/blog/feeling-lonely-in-college', '/blog/author/anushka']) {
  const undecided = page(pathname);
  assert.ok(undecided.banner(), pathname + ' offers first-visit consent');
  assert.equal(undecided.tags().length, 0, 'no tag before consent');
  undecided.window.mpGaTrack('sign_up');
  assert.equal(undecided.window.dataLayer, undefined, 'milestones send nothing before consent');
  undecided.choose('denied');
  assert.equal(undecided.tags().length, 0, 'denial loads no tag');
  assert.equal(undecided.storage.get('mp_analytics_consent_v2'), 'denied');
  const accepted = page(pathname);
  accepted.choose('granted');
  assert.equal(accepted.tags().length, 1, 'grant loads exactly one tag');
  assert.equal(accepted.events('page_view').length, 1, 'grant sends one pageview');
}
assert.ok(page('/app', null, { storageBlocked: true }).banner(), 'storage restrictions do not hide consent');
assert.equal(page('/app', 'denied').tags().length, 0);
const changedMind = page('/app', 'denied');
changedMind.settings().listeners.click();
changedMind.choose('granted');
assert.equal(changedMind.window['ga-disable-' + measurementId], false, 'a prior denial can be changed to grant');
assert.equal(changedMind.events('app_open').length, 1);
assert.equal(page('/admin', 'granted').tags().length, 0, 'admin and unknown paths are excluded');
assert.equal(page('/blogs/private', 'granted').tags().length, 0);

for (const choice of [undefined, 'granted', 'denied']) {
  const target = link('/app?screen=s-signup', 'home-hero-signup');
  const outside = link('https://external.example/app');
  const qa = page('/', choice, { search: '?mp_test=1&utm_source=release_check&utm_medium=referral', links: [target, outside] });
  assert.equal(qa.tags().length, 0, 'QA visits never load Google Analytics, including with existing consent');
  assert.equal(qa.banner(), undefined, 'QA mode does not change the consent choice');
  qa.window.mpGaTrack('sign_up');
  qa.window.mpGaTrack('note_written');
  qa.listeners.click({ target });
  assert.equal(qa.window.dataLayer, undefined, 'QA clicks and conversions send nothing');
  assert.ok(target.getAttribute('href').includes('mp_test=1'), 'QA exclusion follows internal navigation');
  assert.equal(outside.getAttribute('href'), 'https://external.example/app');
  const dynamicQa = link('/blog/how-to-start-journaling');
  qa.listeners.contextmenu({ target: dynamicQa });
  assert.ok(dynamicQa.getAttribute('href').includes('mp_test=1'));
}
const qaWithoutCampaign = link('/app');
page('/', undefined, { search: '?mp_test=1', links: [qaWithoutCampaign] });
assert.equal(qaWithoutCampaign.getAttribute('href'), '/app?mp_test=1', 'QA exclusion also works without campaign labels');
assert.equal(page('/app', 'granted').tags().length, 1, 'QA mode does not persist into normal visits');

const accepted = page('/privacy.html', 'granted', { search: '?email=private&token=secret' });
assert.equal(accepted.config().page_location, 'https://mymentallyprepare.com/privacy');
assert.equal(accepted.config().send_page_view, false);
assert.equal(accepted.config().allow_google_signals, false);
assert.equal(accepted.config().allow_ad_personalization_signals, false);
const defaultConsent = accepted.window.dataLayer.find(e => e[0] === 'consent' && e[1] === 'default')[2];
assert.equal(defaultConsent.ad_storage, 'denied');
assert.equal(defaultConsent.ad_user_data, 'denied');
assert.equal(defaultConsent.ad_personalization, 'denied');
assert.ok(accepted.window.dataLayer.findIndex(e => e[0] === 'consent') < accepted.window.dataLayer.findIndex(e => e[0] === 'config'));

for (const referrer of ['https://www.google.com/search?q=private', 'https://l.instagram.com/?u=secret', 'https://example.org/private/path']) {
  const p = page('/', 'granted', { referrer });
  assert.equal(p.config().page_referrer, new URL(referrer).origin + '/', 'all web referrers retain only their origin');
}
for (const referrer of ['', 'invalid', 'javascript:secret', 'file:///private']) {
  assert.equal(page('/', 'granted', { referrer }).config().page_referrer, '');
}

const campaignSearch = '?utm_source=instagram&utm_medium=organic_social&utm_campaign=nov_student_pilot&utm_content=reel_one&utm_id=pilot-v1&email=private@example.com&token=secret&screen=s-reset&share=secret&utm_term=private-thoughts';
const campaign = page('/app', 'granted', { search: campaignSearch, title: 'Private account name', referrer: 'https://www.linkedin.com/feed?secret=yes' });
const campaignUrl = new URL(campaign.config().page_location);
assert.equal(campaignUrl.pathname, '/app');
assert.deepEqual([...campaignUrl.searchParams.keys()], ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_id']);
assert.equal(campaign.config().page_title, 'Mentally Prepare App');
assert.equal(campaign.events('app_open').length, 1);
campaign.window.mpGaTrack('signup_started');
campaign.window.mpGaTrack('signup_started');
campaign.window.mpGaTrack('sign_up');
campaign.window.mpGaTrack('sign_up');
campaign.window.mpGaTrack('journal_text', { text: 'private' });
campaign.window.mpGaTrack('quiz_started', { answers: 'private', account_id: 123 });
assert.equal(campaign.events('signup_started').length, 1);
assert.equal(campaign.events('sign_up').length, 1);
assert.equal(campaign.events('journal_text').length, 0, 'unknown milestones are ignored');
assert.equal(campaign.events('quiz_started')[0][2].answers, undefined, 'caller data cannot enter analytics');
for (const entry of campaign.window.dataLayer.filter(e => e[0] === 'event')) {
  assert.equal(entry[2].page_location, campaign.config().page_location);
  assert.equal(entry[2].page_title, 'Mentally Prepare App');
  assert.ok(!JSON.stringify(entry[2]).includes('secret'));
}
for (const value of ['rashmi@example.com', 'phone1234567890', 'two words', '<script>', 'https://example.com']) {
  assert.equal(page('/', 'granted', { search: '?utm_campaign=' + encodeURIComponent(value) }).config().page_location, 'https://mymentallyprepare.com/', 'unsafe labels are omitted');
}
const signup = page('/app', null, { signupScreen: true });
signup.choose('granted');
assert.equal(signup.events('signup_started').length, 1, 'granting on a signup screen counts the current screen');
assert.equal(page('/app', 'granted').events('signup_started').length, 0, 'opening the scan is not a signup start');

const internal = link('/app?screen=s-signup#continue', 'home-hero-signup');
const blog = link('/blog/how-to-start-journaling', 'home-blog');
const external = link('https://external.example/app');
const unknown = link('/api/reset?token=secret');
const anchor = link('#how-it-works');
const home = page('/', null, { search: campaignSearch, links: [internal, blog, external, unknown, anchor] });
assert.equal(new URL(internal.getAttribute('href'), home.window.location.href).searchParams.get('utm_source'), 'instagram', 'labels survive home to app before consent');
assert.ok(internal.getAttribute('href').includes('screen=s-signup'));
assert.ok(internal.getAttribute('href').endsWith('#continue'));
assert.ok(blog.getAttribute('href').includes('utm_campaign=nov_student_pilot'));
assert.equal(external.getAttribute('href'), 'https://external.example/app');
assert.equal(unknown.getAttribute('href'), '/api/reset?token=secret');
assert.equal(anchor.getAttribute('href'), '#how-it-works');
assert.equal(home.window.dataLayer, undefined);
assert.equal(home.storage.size, 1, 'no campaign is stored before consent; only retired Meta choice is cleared');
home.choose('granted');
home.listeners.click({ target: internal });
assert.equal(home.events('cta_click').length, 1);
assert.equal(home.events('sign_up_start').length, 0, 'CTA intent must not inflate signup starts');
assert.equal(home.events('signup_started').length, 0, 'signup starts only in app');
const dynamic = link('/app?screen=s-login');
home.listeners.click({ target: dynamic });
assert.ok(dynamic.getAttribute('href').includes('utm_source=instagram'), 'dynamic internal links also retain labels');
const contextLink = link('/app');
home.listeners.contextmenu({ target: contextLink });
assert.ok(contextLink.getAttribute('href').includes('utm_source=instagram'), 'open-in-new-tab retains labels');

campaign.settings().listeners.click();
campaign.choose('denied');
assert.equal(campaign.window['ga-disable-' + measurementId], true);
assert.equal(campaign.reloads(), 1, 'withdrawal reloads to stop the tag');
const before = campaign.events('note_written').length;
campaign.window.mpGaTrack('note_written');
assert.equal(campaign.events('note_written').length, before, 'withdrawal blocks events immediately');

const oldGrant = page('/', 'granted', { storage: { mp_public_clarity_consent_v1: 'granted', mp_public_meta_ads_consent_v1: 'granted' } });
assert.equal(oldGrant.storage.get('mp_public_meta_ads_consent_v1'), 'denied');
assert.equal(oldGrant.tags().length, 1);
assert.ok(oldGrant.tags()[0].src.startsWith('https://www.googletagmanager.com/gtag/js?'), 'no Meta or recording script loads');

for (const dir of ['public', 'content/blog']) {
  for (const filename of fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, dir, filename), 'utf8');
    if (html.includes('/public-analytics.js')) assert.ok(html.includes('/public-analytics.js?v=20261124-onboarding'), filename + ' must use the new version');
    assert.ok(!html.includes('/private-analytics.js'), 'retired tracker must not be loaded');
  }
}
const appHtml = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
assert.ok(appHtml.includes('/public-analytics.js?v=20261124-onboarding'));
assert.ok(appHtml.indexOf('/public-analytics.js') < appHtml.indexOf('/app.js?v='));
console.log('Analytics consent, attribution, navigation and funnel checks passed');
