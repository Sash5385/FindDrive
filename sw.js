try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

  firebase.initializeApp({
    apiKey:            "AIzaSyAr-Q8ojscCoMLXNAKNjqbGrqw0JN6_mbo",
    authDomain:        "finddrive-b009d.firebaseapp.com",
    projectId:         "finddrive-b009d",
    storageBucket:     "finddrive-b009d.firebasestorage.app",
    messagingSenderId: "8431552805",
    appId:             "1:8431552805:web:6708f74b843ff5b94332cc"
  });

  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const title = payload.notification?.title || 'FindDrive';
    const body  = payload.notification?.body  || '';
    self.registration.showNotification(title, {
      body,
      icon:  '/favicon.png',
      badge: '/favicon.png',
      data:  { url: '/' }
    });
  });
} catch(e) {
  console.warn('FCM SW init failed:', e.message);
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.openWindow(url));
});

// --- Caching ---
const CACHE = 'finddrive-v4';

// Свої файли + Firebase CDN модулі (щоб PWA працювала офлайн / при слабкому сигналі)
const PRECACHE = [
  '/',
  '/index.html',
  '/favicon.png',
  '/logo192.png',
  '/logo.png',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
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
  if (e.request.method !== 'GET') return;

  const isSameOrigin  = url.origin === self.location.origin;
  const isFirebaseCDN = url.hostname === 'www.gstatic.com';

  if (!isSameOrigin && !isFirebaseCDN) return;

  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const network = fetch(e.request)
          .then(res => {
            if (res && res.status === 200) cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || network;
      })
    )
  );
});
