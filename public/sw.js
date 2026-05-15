// Oike Sales Intel — Service Worker
// Network-first strategy: always try network, fall back to cache.
// API calls, auth, and Airtable are never cached.

const CACHE_NAME = 'oike-v1';
const SKIP_CACHE = ['/api/', 'airtable.com', 'openai.com', 'clerk.', 'netlify.'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/app', '/app.js', '/style.css', '/manifest.json'])
        .catch(() => {}) // fail silently if assets don't exist yet
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Never cache API / external service calls
  if (SKIP_CACHE.some(s => url.includes(s))) return;
  // Only cache GET requests
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache a clone of successful responses
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request)) // offline fallback
  );
});

self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Oike', body: e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Oike Sales Intel', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/app' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cs => {
      const target = e.notification.data?.url || '/app';
      const existing = cs.find(c => c.url.includes('/app'));
      if (existing) { existing.focus(); existing.navigate(target); }
      else clients.openWindow(target);
    })
  );
});
