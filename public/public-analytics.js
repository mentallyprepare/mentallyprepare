(function () {
  'use strict';

  const measurementId = 'G-8Y96FYSR01';
  const consentKey = 'mp_public_analytics_consent_v1';
  const publicPaths = {
    '/': '/',
    '/index.html': '/',
    '/safety': '/safety',
    '/safety.html': '/safety',
    '/privacy': '/privacy',
    '/privacy.html': '/privacy',
    '/terms': '/terms',
    '/terms.html': '/terms'
  };
  const canonicalPath = publicPaths[window.location.pathname];
  if (!canonicalPath) return;

  let tagLoaded = false;
  let banner;

  function readChoice() {
    try { return localStorage.getItem(consentKey); } catch { return null; }
  }

  function saveChoice(choice) {
    try { localStorage.setItem(consentKey, choice); } catch {}
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

  function hideBanner() {
    if (banner) banner.remove();
    banner = null;
    settings.hidden = false;
  }

  function showBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'mp-analytics-choice';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Analytics choice');
    banner.innerHTML = '<p>May we measure visits to these public pages? Google Analytics loads only if you agree. It is never added to the private journal. <a href="/privacy">Read our privacy policy</a>.</p><div class="mp-analytics-actions"><button type="button" data-choice="denied">No thanks</button><button type="button" data-choice="granted">Allow analytics</button></div>';
    banner.addEventListener('click', function (event) {
      const choice = event.target && event.target.getAttribute('data-choice');
      if (choice !== 'granted' && choice !== 'denied') return;
      saveChoice(choice);
      hideBanner();
      if (choice === 'granted') loadTag();
      else {
        clearAnalyticsCookies();
        if (tagLoaded) window.location.reload();
      }
    });
    document.body.appendChild(banner);
    settings.hidden = true;
  }

  const style = document.createElement('style');
  style.textContent = '.mp-analytics-choice{position:fixed;z-index:10000;left:16px;right:16px;bottom:16px;max-width:560px;margin:auto;padding:18px 20px;background:#0E0A18;color:#F8F2FF;border:1px solid rgba(248,242,255,.2);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.55);font:14px/1.5 system-ui,sans-serif}.mp-analytics-choice p{margin:0 0 14px;color:#F8F2FF}.mp-analytics-choice a{color:#EBB4C2}.mp-analytics-actions{display:flex;flex-wrap:wrap;gap:10px}.mp-analytics-actions button,.mp-analytics-settings{cursor:pointer;border:1px solid rgba(248,242,255,.35);border-radius:8px;background:#0E0A18;color:#F8F2FF;padding:9px 13px;font:600 13px system-ui,sans-serif}.mp-analytics-actions button[data-choice="granted"]{background:#EBB4C2;color:#08050F;border-color:#EBB4C2}.mp-analytics-actions button:focus-visible,.mp-analytics-settings:focus-visible{outline:2px solid #ECC885;outline-offset:2px}.mp-analytics-settings{position:fixed;z-index:9999;left:16px;bottom:16px;font-size:12px}.mp-analytics-settings[hidden]{display:none}';
  document.head.appendChild(style);

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'mp-analytics-settings';
  settings.textContent = 'Analytics choice';
  settings.addEventListener('click', showBanner);
  document.body.appendChild(settings);

  const choice = readChoice();
  if (choice === 'granted') loadTag();
  else if (choice !== 'denied') showBanner();
})();
