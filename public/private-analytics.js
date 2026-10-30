(function () {
  'use strict';
  try {
    if (localStorage.getItem('mp_analytics_consent_v2') !== 'granted') return;
  } catch { return; }

  const measurementId = 'G-8Y96FYSR01';
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', {
    analytics_storage: 'denied', ad_storage: 'denied',
    ad_user_data: 'denied', ad_personalization: 'denied'
  });
  window.gtag('consent', 'update', { analytics_storage: 'granted' });
  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    send_page_view: false,
    page_location: 'https://mymentallyprepare.com/app',
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
  document.head.appendChild(script);

  const allowed = new Set(['signup_started', 'sign_up', 'quiz_started', 'quiz_completed', 'note_written']);
  window.mpGaTrack = function (name) {
    if (!allowed.has(name)) return;
    window.gtag('event', name, {
      page_location: 'https://mymentallyprepare.com/app',
      page_referrer: '',
      transport_type: 'beacon'
    });
  };
})();
