const CACHE_NAME = 'crosssync-shell-20260717-recovery-v2';
const SHELL_ASSETS = [
  '/manifest.webmanifest',
  '/static/styles.css',
  '/static/app.js',
  '/static/app-icon-180.png',
  '/static/app-icon-192.png',
  '/static/app-icon-512.png',
  '/static/keep-awake.mp4',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const cacheable = url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest';
  if (!cacheable) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
