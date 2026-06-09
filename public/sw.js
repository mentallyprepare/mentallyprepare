// ═══════════════════════════════════════
// MENTALLY PREPARE — Service Worker
// ═══════════════════════════════════════
const CACHE_NAME = 'post-login-routing-20260609';
const STATIC_ASSETS = [
  '/manifest.json',
  '/site.webmanifest',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/favicon-48x48.png',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

// Install — cache only icons/manifest (not HTML)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => {
        clients.forEach(client => client.postMessage({ type: 'MP_SW_UPDATED', cache: CACHE_NAME }));
      })
  );
});

// Fetch — network-first for everything, cache fallback for offline
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API calls — network only
  if (url.pathname.startsWith('/api/')) return;

  // App shell and code must always come from the network. Old cached JS kept
  // showing the removed partner-switch failure copy for returning users.
  if (
    request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname === '/app'
  ) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Network first, cache fallback
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

// Listen for skip waiting message from page
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Push notifications
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Mentally Prepare';
  const options = {
    body: data.body || 'Your reset is ready.',
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    tag: data.tag || 'mentally-prepare-reminder',
    renotify: false,
    vibrate: [80, 40, 80],
    data: { url: data.url || '/app' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const client = clients.find(c => c.url.includes(url));
      if (client) return client.focus();
      return self.clients.openWindow(url);
    })
  );
});
