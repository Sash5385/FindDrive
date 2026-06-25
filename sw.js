const CACHE = 'finddrive-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/favicon.png',
  '/logo192.png',
  '/logo.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Тільки GET і тільки свій origin
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Стратегія: stale-while-revalidate
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const network = fetch(e.request)
          .then(res => { cache.put(e.request, res.clone()); return res; })
          .catch(() => null);
        return cached || network;
      })
    )
  );
});
