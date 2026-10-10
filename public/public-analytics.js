(function () {
  'use strict';

  const measurementId = 'G-8Y96FYSR01';
  const consentKey = 'mp_public_analytics_consent_v1';
  const clarityConsentKey = 'mp_public_clarity_consent_v1';
  const clarityProjectId = 'yujdrgc251';
  const metaPixelId = '2477145509443715';
  const metaConsentKey = 'mp_public_meta_ads_consent_v1';
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
  const blogMatch = /^\/blog(\/[a-z0-9-]+)?\/?$/.exec(window.location.pathname);
  const canonicalPath = publicPaths[window.location.pathname] || (blogMatch ? '/blog' + (blogMatch[1] || '') : null);
  if (!canonicalPath) return;

  let tagLoaded = false;
  let clarityLoaded = false;
  let metaLoaded = false;
  let metaBanner;
  let banner;

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

  function loadTag() {
    if (tagLoaded) return;
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
      page_location: 'https://mymentallyprepare.com' + canonicalPath,
      page_referrer: '',
      ignore_referrer: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
    window.gtag('event', 'page_view', {
      page_title: document.title,
      page_location: 'https://mymentallyprepare.com' + canonicalPath,
      page_referrer: ''
    });

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
    document.head.appendChild(script);
  }

  function loadClarity() {
    // Clarity records page and clicked URLs. Skip URLs with parameters or
    // fragments, which may contain information that should not be recorded.
    if (clarityLoaded || window.location.search || window.location.hash) return;
    clarityLoaded = true;
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.clarity.ms/tag/' + clarityProjectId;
    document.head.appendChild(script);
  }

  function stopClarity() {
    if (!clarityLoaded) return;
    window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
    window.clarity('consent', false);
  }

  function loadMetaPixel() {
    // Meta can infer interests from page URLs. Limit the pixel to the clean
    // homepage and never send events from the journal, sign-in, or blog.
    if (metaLoaded || canonicalPath !== '/' || window.location.search || window.location.hash) return;
    metaLoaded = true;
    window.fbq = window.fbq || function () {
      (window.fbq.queue = window.fbq.queue || []).push(arguments);
    };
    window.fbq('set', 'autoConfig', false, metaPixelId);
    window.fbq('init', metaPixelId);
    window.fbq('track', 'PageView');
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }

  function showMetaChoice() {
    if (canonicalPath !== '/' || metaBanner || banner || readChoice(metaConsentKey)) return;
    metaBanner = document.createElement('div');
    metaBanner.className = 'mp-analytics-choice mp-meta-choice';
    metaBanner.setAttribute('role', 'dialog');
    metaBanner.setAttribute('aria-label', 'Meta advertising choice');
    metaBanner.innerHTML = '<p>May we share a visit to this homepage with Meta to measure our ads? This uses the Meta Pixel and may set cookies. It never runs in the private app, sign-in, or blog. Your Google Analytics and Clarity choices stay separate. <a href="/privacy">Read our privacy policy</a>.</p><div class="mp-analytics-actions"><button type="button" data-meta-choice="denied">No thanks</button><button type="button" data-meta-choice="granted">Allow Meta Pixel</button></div>';
    metaBanner.addEventListener('click', function (event) {
      const choice = event.target && event.target.getAttribute('data-meta-choice');
      if (choice !== 'granted' && choice !== 'denied') return;
      saveChoice(metaConsentKey, choice);
      metaBanner.remove();
      metaBanner = null;
      if (choice === 'granted') loadMetaPixel();
      if (choice === 'denied' && metaLoaded) window.location.reload();
    });
    document.body.appendChild(metaBanner);
  }

  // Links marked data-mp-cta report which call to action was used. Sign-up
  // links also report sign_up_start. Nothing is sent without consent.
  document.addEventListener('click', function (event) {
    if (!tagLoaded || !event.target || !event.target.closest) return;
    const link = event.target.closest('a[data-mp-cta]');
    if (!link) return;
    const params = {
      cta_id: link.getAttribute('data-mp-cta'),
      page_location: 'https://mymentallyprepare.com' + canonicalPath
    };
    window.gtag('event', 'cta_click', params);
    if (/[?&]screen=s-signup(?:&|$)/.test(link.getAttribute('href') || '')) {
      window.gtag('event', 'sign_up_start', params);
    }
  });

  function hideBanner() {
    if (banner) banner.remove();
    banner = null;
    settings.hidden = false;
    showMetaChoice();
  }

  function showBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'mp-analytics-choice';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Analytics and recording choice');
    const existingAnalyticsOnly = readChoice(consentKey) === 'granted' && !readChoice(clarityConsentKey);
    banner.innerHTML = existingAnalyticsOnly
      ? '<p>You already allow Google Analytics on public pages. Would you also allow Microsoft Clarity to record clicks and scrolling on those pages? It never runs in the private journal or sign-in screens. <a href="/privacy">Read our privacy policy</a>.</p><div class="mp-analytics-actions"><button type="button" data-choice="granted">No recordings</button><button type="button" data-choice="granted-recording">Allow recordings</button></div>'
      : '<p>May we measure visits to these public pages? Google Analytics counts visits. If you also choose recordings, Microsoft Clarity records clicks and scrolling on public pages. Neither runs in the private journal or sign-in screens. <a href="/privacy">Read our privacy policy</a>.</p><div class="mp-analytics-actions"><button type="button" data-choice="denied">No thanks</button><button type="button" data-choice="granted">Analytics only</button><button type="button" data-choice="granted-recording">Analytics + recordings</button></div>';
    banner.addEventListener('click', function (event) {
      const choice = event.target && event.target.getAttribute('data-choice');
      if (!['granted', 'granted-recording', 'denied'].includes(choice)) return;
      const analyticsChoice = choice === 'denied' ? 'denied' : 'granted';
      const recordingChoice = choice === 'granted-recording' ? 'granted' : 'denied';
      saveChoice(consentKey, analyticsChoice);
      saveChoice(clarityConsentKey, recordingChoice);
      hideBanner();
      if (analyticsChoice === 'granted') loadTag();
      else {
        clearAnalyticsCookies();
      }
      if (recordingChoice === 'granted') loadClarity();
      else stopClarity();
      if ((analyticsChoice === 'denied' && tagLoaded) || (recordingChoice === 'denied' && clarityLoaded)) window.location.reload();
    });
    document.body.appendChild(banner);
    settings.hidden = true;
  }

  const style = document.createElement('style');
  style.textContent = '.mp-analytics-choice{position:fixed;z-index:10000;left:16px;right:16px;bottom:16px;max-width:560px;margin:auto;padding:18px 20px;background:#0E0A18;color:#F8F2FF;border:1px solid rgba(248,242,255,.2);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.55);font:14px/1.5 system-ui,sans-serif}.mp-analytics-choice p{margin:0 0 14px;color:#F8F2FF}.mp-analytics-choice a{color:#EBB4C2}.mp-analytics-actions{display:flex;flex-wrap:wrap;gap:10px}.mp-analytics-actions button,.mp-analytics-settings{cursor:pointer;border:1px solid rgba(248,242,255,.35);border-radius:8px;background:#0E0A18;color:#F8F2FF;padding:9px 13px;font:600 13px system-ui,sans-serif}.mp-analytics-actions button[data-choice="granted"],.mp-analytics-actions button[data-choice="granted-recording"]{background:#EBB4C2;color:#08050F;border-color:#EBB4C2}.mp-analytics-actions button:focus-visible,.mp-analytics-settings:focus-visible{outline:2px solid #ECC885;outline-offset:2px}.mp-analytics-settings{position:fixed;z-index:9999;left:16px;bottom:16px;font-size:12px}.mp-analytics-settings[hidden]{display:none}';
  style.textContent += '.mp-meta-choice .mp-analytics-actions button[data-meta-choice="granted"]{background:#EBB4C2;color:#08050F;border-color:#EBB4C2}.mp-meta-choice .mp-analytics-actions button:focus-visible{outline:2px solid #ECC885;outline-offset:2px}.mp-meta-settings{left:auto;right:16px}';
  document.head.appendChild(style);

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'mp-analytics-settings';
  settings.textContent = 'Analytics & recordings';
  settings.addEventListener('click', showBanner);
  document.body.appendChild(settings);

  if (canonicalPath === '/') {
    const metaSettings = document.createElement('button');
    metaSettings.type = 'button';
    metaSettings.className = 'mp-analytics-settings mp-meta-settings';
    metaSettings.textContent = 'Meta ads choice';
    metaSettings.addEventListener('click', function () {
      if (metaBanner || banner) return;
      // Reopen the choice without carrying a previous grant forward.
      saveChoice(metaConsentKey, '');
      showMetaChoice();
    });
    document.body.appendChild(metaSettings);
  }

  const choice = readChoice(consentKey);
  const recordingChoice = readChoice(clarityConsentKey);
  if (choice === 'granted') loadTag();
  if (choice === 'granted' && recordingChoice === 'granted') loadClarity();
  if (choice !== 'denied' && (choice !== 'granted' || !recordingChoice)) showBanner();
  if (readChoice(metaConsentKey) === 'granted') loadMetaPixel();
  if (!banner) showMetaChoice();
})();
