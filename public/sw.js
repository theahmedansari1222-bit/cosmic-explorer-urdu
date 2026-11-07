// Offline support: after the first visit the app opens without internet.
// Pages are fetched fresh when online (so updates arrive); everything else is cached.
// When you publish a big update, change the version number below.
const CACHE = 'cosmic-explorer-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;

  const store = (response) => {
    if (response && (response.ok || response.type === 'opaque')) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  };

  if (request.mode === 'navigate') {
    // Pages: network first, cached copy when offline.
    event.respondWith(
      fetch(request)
        .then(store)
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  // Everything else: cached copy first, then the network.
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then(store)));
});
