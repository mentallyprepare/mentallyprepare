(function () {
  'use strict';

  const measurementId = 'G-8Y96FYSR01';
  const consentKey = 'mp_analytics_consent_v2';
  const publicPaths = {
    '/': '/',
    '/index.html': '/',
    '/about': '/about',
    '/about.html': '/about',
    '/safety': '/safety',
    '/safety.html': '/safety',
    '/privacy': '/privacy',
    '/privacy.html': '/privacy',
    '/terms': '/terms',
    '/terms.html': '/terms'
  };
  const appPaths = new Set(['/app', '/app/', '/app.html', '/signup', '/login', '/forgot', '/onboarding', '/scan', '/room']);
  const isApp = appPaths.has(window.location.pathname);
  const blogMatch = /^\/blog(\/[a-z0-9-]+)?\/?$/.exec(window.location.pathname);
  const canonicalPath = isApp ? '/app' : publicPaths[window.location.pathname] || (blogMatch ? '/blog' + (blogMatch[1] || '') : null);
  if (!canonicalPath) return;

  let tagLoaded = false;
  let analyticsAllowed = false;
  let banner;
  const trackedMilestones = new Set();
  const allowedMilestones = new Set(['app_open', 'signup_started', 'sign_up', 'quiz_started', 'quiz_completed', 'note_written']);
  const oncePerPage = new Set(['app_open', 'signup_started', 'sign_up']);

  // Only explicit campaign labels may accompany the canonical URL. Authentication
  // tokens, scan sharing codes and all other query parameters stay out of GA4.
  const campaign = new URLSearchParams();
  const incoming = new URLSearchParams(window.location.search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_id']) {
    const value = incoming.get(key) || '';
    if (/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value) && !/\d{7}/.test(value)) {
      campaign.set(key, value);
    }
  }
  const pageLocation = 'https://mymentallyprepare.com' + canonicalPath + (campaign.size ? '?' + campaign.toString() : '');
  const pageReferrer = (function () {
    try {
      const referrer = new URL(document.referrer);
      if (referrer.protocol === 'https:' || referrer.protocol === 'http:') return referrer.origin + '/';
    } catch {}
    return '';
  })();

  window.mpGaTrack = function (name) {
    if (!analyticsAllowed || !tagLoaded || !allowedMilestones.has(name)) return;
    if (oncePerPage.has(name) && trackedMilestones.has(name)) return;
    trackedMilestones.add(name);
    window.gtag('event', name, {
      page_location: pageLocation,
      page_title: isApp ? 'Mentally Prepare App' : document.title,
      page_referrer: pageReferrer,
      transport_type: 'beacon'
    });
  };

  function readChoice(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function saveChoice(key, choice) {
    try { localStorage.setItem(key, choice); } catch {}
  }

  function clearAnalyticsCookies() {
    document.cookie.split(';').forEach(function (part) {
      const name = part.split('=')[0].trim();
      if (!/^_ga(?:_|$)/.test(name)) return;
      document.cookie = name + '=; Max-Age=0; Path=/; SameSite=Lax';
      document.cookie = name + '=; Max-Age=0; Path=/; Domain=.mymentallyprepare.com; SameSite=Lax';
    });
  }

  function retireMetaPixel() {
    // An old grant must not reactivate a cached copy of the retired loader.
    saveChoice('mp_public_meta_ads_consent_v1', 'denied');
    document.cookie.split(';').forEach(function (part) {
      const name = part.split('=')[0].trim();
      if (name !== '_fbp' && name !== '_fbc') return;
      document.cookie = name + '=; Max-Age=0; Path=/; SameSite=Lax';
      document.cookie = name + '=; Max-Age=0; Path=/; Domain=.mymentallyprepare.com; SameSite=Lax';
    });
  }

  function loadTag() {
    if (tagLoaded) return;
    analyticsAllowed = true;
    window['ga-disable-' + measurementId] = false;
    tagLoaded = true;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    window.gtag('js', new Date());
    window.gtag('config', measurementId, {
      send_page_view: false,
      page_location: pageLocation,
      page_title: isApp ? 'Mentally Prepare App' : document.title,
      page_referrer: pageReferrer,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
    window.gtag('event', 'page_view', {
      page_title: isApp ? 'Mentally Prepare App' : document.title,
      page_location: pageLocation,
      page_referrer: pageReferrer
    });
    if (isApp) {
      window.mpGaTrack('app_open');
      if (document.querySelector('#s-signup.active, [id^="s-ob"].active')) window.mpGaTrack('signup_started');
    }

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
    document.head.appendChild(script);
  }

  // Carry only approved labels through internal navigation, including before a
  // visitor chooses analytics. No campaign data is stored or sent before consent.
  function decorateLink(link) {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || !campaign.size) return;
    try {
      const target = new URL(href, window.location.href);
      if (target.origin !== window.location.origin) return;
      if (!publicPaths[target.pathname] && !appPaths.has(target.pathname) && !/^\/blog(\/[a-z0-9-]+)?\/?$/.test(target.pathname)) return;
      // Internal navigation must retain the landing campaign, not start a new one.
      for (const [key, value] of campaign) target.searchParams.set(key, value);
      link.setAttribute('href', target.pathname + target.search + target.hash);
    } catch {}
  }
  document.querySelectorAll('a[href]').forEach(decorateLink);
  document.addEventListener('contextmenu', function (event) {
    const link = event.target && event.target.closest && event.target.closest('a[href]');
    if (link) decorateLink(link);
  });

  // A click records intent. Signup starts are recorded by the actual app screen.
  document.addEventListener('click', function (event) {
    if (!event.target || !event.target.closest) return;
    const destination = event.target.closest('a[href]');
    if (destination) decorateLink(destination);
    if (!analyticsAllowed || !tagLoaded) return;
    const link = event.target.closest('a[data-mp-cta]');
    if (!link) return;
    const ctaId = link.getAttribute('data-mp-cta') || '';
    if (!/^[a-z0-9-]{1,80}$/.test(ctaId)) return;
    const params = { cta_id: ctaId, page_location: pageLocation, page_referrer: pageReferrer, transport_type: 'beacon' };
    window.gtag('event', 'cta_click', params);
  });

  function hideBanner() {
    if (banner) banner.remove();
    banner = null;
    settings.hidden = false;
  }

  function showBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'mp-analytics-choice mp-cookie-choice';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie choices');
    banner.innerHTML = '<div class="mp-cookie-brand">mentally prepare</div><div class="mp-cookie-copy"><h2>This website uses cookies</h2><p>Essential cookies keep you signed in. If you allow analytics, Google Analytics counts visits, app opens, scan progress, signups and saved notes. Campaign labels and referring websites help us understand how people find us. Journal text, scan answers, names and email addresses are never sent. <a href="/privacy">Read our privacy policy</a>.</p></div><div class="mp-analytics-actions"><button type="button" data-choice="granted">Allow analytics cookies</button><button type="button" data-choice="denied">Deny optional cookies</button></div>';
    banner.addEventListener('click', function (event) {
      const choice = event.target && event.target.getAttribute('data-choice');
      if (choice !== 'granted' && choice !== 'denied') return;
      saveChoice(consentKey, choice);
      hideBanner();
      if (choice === 'granted') loadTag();
      else {
        analyticsAllowed = false;
        window['ga-disable-' + measurementId] = true;
        if (tagLoaded) window.gtag('consent', 'update', { analytics_storage: 'denied' });
        clearAnalyticsCookies();
      }
      if (choice === 'denied' && tagLoaded) window.location.reload();
    });
    document.body.appendChild(banner);
    settings.hidden = true;
  }

  const style = document.createElement('style');
  style.textContent = '.mp-analytics-choice{position:fixed;z-index:10000;left:16px;right:16px;bottom:16px;max-width:560px;margin:auto;padding:18px 20px;background:#0E0A18;color:#F8F2FF;border:1px solid rgba(248,242,255,.2);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.55);font:14px/1.5 system-ui,sans-serif}.mp-analytics-choice h2{margin:0 0 8px;font:700 16px/1.3 system-ui,sans-serif}.mp-analytics-choice p{margin:0 0 14px;color:#F8F2FF}.mp-analytics-choice a{color:#EBB4C2}.mp-analytics-actions{display:flex;flex-wrap:wrap;gap:10px}.mp-analytics-actions button,.mp-analytics-settings{cursor:pointer;border:1px solid rgba(248,242,255,.35);border-radius:8px;background:#0E0A18;color:#F8F2FF;padding:9px 13px;font:600 13px system-ui,sans-serif}.mp-analytics-actions button[data-choice="granted"]{background:#EBB4C2;color:#08050F;border-color:#EBB4C2}.mp-analytics-actions button:focus-visible,.mp-analytics-settings:focus-visible{outline:2px solid #ECC885;outline-offset:2px}.mp-analytics-settings{position:fixed;z-index:9999;left:16px;bottom:16px;font-size:12px}.mp-analytics-settings[hidden]{display:none}';
  style.textContent += '.mp-cookie-choice{left:0;right:0;bottom:0;max-width:none;padding:24px clamp(20px,4vw,64px);border:0;border-top:1px solid rgba(248,242,255,.2);border-radius:0;display:grid;grid-template-columns:minmax(130px,180px) minmax(0,1fr) minmax(210px,260px);align-items:start;gap:clamp(20px,3vw,48px);box-shadow:0 -10px 40px rgba(0,0,0,.45)}.mp-cookie-brand{padding-top:3px;font:700 16px/1.3 system-ui,sans-serif;white-space:nowrap}.mp-cookie-choice .mp-cookie-copy{max-width:720px}.mp-cookie-choice h2{margin:0 0 10px}.mp-cookie-choice p{margin:0}.mp-cookie-choice .mp-analytics-actions{display:grid;gap:8px}.mp-cookie-choice .mp-analytics-actions button{width:100%;min-height:44px;text-align:center}.mp-cookie-choice .mp-analytics-actions button[data-choice="denied"]{background:transparent}@media(max-width:760px){.mp-cookie-choice{grid-template-columns:1fr;gap:12px;padding:18px 20px 22px;max-height:75vh;overflow:auto}.mp-cookie-brand{font-size:13px;color:#EBB4C2}.mp-cookie-choice h2{font-size:16px}.mp-cookie-choice .mp-analytics-actions{grid-template-columns:1fr 1fr}.mp-cookie-choice .mp-analytics-actions button{min-height:48px}}@media(max-width:440px){.mp-cookie-choice .mp-analytics-actions{grid-template-columns:1fr}}';
  if (isApp) style.textContent += '.mp-analytics-settings{bottom:calc(80px + env(safe-area-inset-bottom,0px));padding:7px 9px;font-size:11px}';
  document.head.appendChild(style);

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'mp-analytics-settings';
  settings.textContent = 'Cookie choices';
  settings.addEventListener('click', showBanner);
  document.body.appendChild(settings);

  const choice = readChoice(consentKey);
  retireMetaPixel();
  if (choice === 'granted') loadTag();
  if (choice !== 'denied' && choice !== 'granted') showBanner();
})();
