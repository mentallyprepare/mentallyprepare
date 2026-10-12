(function () {
  'use strict';

  const measurementId = 'G-8Y96FYSR01';
  const consentKey = 'mp_public_analytics_consent_v1';
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
  }

  function showBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'mp-analytics-choice mp-cookie-choice';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie choices');
    banner.innerHTML = '<div class="mp-cookie-brand">mentally prepare</div><div class="mp-cookie-copy"><h2>This website uses cookies</h2><p>We use an essential cookie to keep your account signed in. With your permission, Google Analytics uses cookies to count visits to public pages. It does not run in the private journal or sign-in screens. <a href="/privacy">Read our privacy policy</a>.</p></div><div class="mp-analytics-actions"><button type="button" data-choice="granted">Allow analytics cookies</button><button type="button" data-choice="denied">Deny optional cookies</button></div>';
    banner.addEventListener('click', function (event) {
      const choice = event.target && event.target.getAttribute('data-choice');
      if (choice !== 'granted' && choice !== 'denied') return;
      saveChoice(consentKey, choice);
      hideBanner();
      if (choice === 'granted') loadTag();
      else clearAnalyticsCookies();
      if (choice === 'denied' && tagLoaded) window.location.reload();
    });
    document.body.appendChild(banner);
    settings.hidden = true;
  }

  const style = document.createElement('style');
  style.textContent = '.mp-analytics-choice{position:fixed;z-index:10000;left:16px;right:16px;bottom:16px;max-width:560px;margin:auto;padding:18px 20px;background:#0E0A18;color:#F8F2FF;border:1px solid rgba(248,242,255,.2);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.55);font:14px/1.5 system-ui,sans-serif}.mp-analytics-choice h2{margin:0 0 8px;font:700 16px/1.3 system-ui,sans-serif}.mp-analytics-choice p{margin:0 0 14px;color:#F8F2FF}.mp-analytics-choice a{color:#EBB4C2}.mp-analytics-actions{display:flex;flex-wrap:wrap;gap:10px}.mp-analytics-actions button,.mp-analytics-settings{cursor:pointer;border:1px solid rgba(248,242,255,.35);border-radius:8px;background:#0E0A18;color:#F8F2FF;padding:9px 13px;font:600 13px system-ui,sans-serif}.mp-analytics-actions button[data-choice="granted"]{background:#EBB4C2;color:#08050F;border-color:#EBB4C2}.mp-analytics-actions button:focus-visible,.mp-analytics-settings:focus-visible{outline:2px solid #ECC885;outline-offset:2px}.mp-analytics-settings{position:fixed;z-index:9999;left:16px;bottom:16px;font-size:12px}.mp-analytics-settings[hidden]{display:none}';
  style.textContent += '.mp-cookie-choice{left:0;right:0;bottom:0;max-width:none;padding:24px clamp(20px,4vw,64px);border:0;border-top:1px solid rgba(248,242,255,.2);border-radius:0;display:grid;grid-template-columns:minmax(130px,180px) minmax(0,1fr) minmax(210px,260px);align-items:start;gap:clamp(20px,3vw,48px);box-shadow:0 -10px 40px rgba(0,0,0,.45)}.mp-cookie-brand{padding-top:3px;font:700 16px/1.3 system-ui,sans-serif;white-space:nowrap}.mp-cookie-choice .mp-cookie-copy{max-width:720px}.mp-cookie-choice h2{margin:0 0 10px}.mp-cookie-choice p{margin:0}.mp-cookie-choice .mp-analytics-actions{display:grid;gap:8px}.mp-cookie-choice .mp-analytics-actions button{width:100%;min-height:44px;text-align:center}.mp-cookie-choice .mp-analytics-actions button[data-choice="denied"]{background:transparent}@media(max-width:760px){.mp-cookie-choice{grid-template-columns:1fr;gap:12px;padding:18px 20px 22px;max-height:75vh;overflow:auto}.mp-cookie-brand{font-size:13px;color:#EBB4C2}.mp-cookie-choice h2{font-size:16px}.mp-cookie-choice .mp-analytics-actions{grid-template-columns:1fr 1fr}.mp-cookie-choice .mp-analytics-actions button{min-height:48px}}@media(max-width:440px){.mp-cookie-choice .mp-analytics-actions{grid-template-columns:1fr}}';
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
