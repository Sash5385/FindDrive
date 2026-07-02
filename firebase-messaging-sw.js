importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBimSHNH6PcXQnOq5GjJLxNijXkDI5MgkU",
  authDomain: "finddrive-b009d.firebaseapp.com",
  projectId: "finddrive-b009d",
  storageBucket: "finddrive-b009d.appspot.com",
  messagingSenderId: "887073543534",
  appId: "1:887073543534:web:c51dac1fe49a52a3fe02c4"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title = 'FindDrive', body = '' } = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(title, {
    body,
    icon: '/favicon.png',
    badge: '/favicon.png',
    data,
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const appUrl = 'https://finddrive.in.ua/';

  // Build target URL with notification action encoded in hash
  let hash = '#notif=' + (data.type || 'cabinet');
  if (data.chatId) hash += '&chatId=' + data.chatId;
  if (data.instrId) hash += '&instrId=' + data.instrId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app tab already open — focus it and send postMessage
      for (const client of list) {
        if (client.url.startsWith(appUrl)) {
          client.postMessage({ type: 'notif-click', ...data });
          return client.focus();
        }
      }
      // Otherwise open fresh with hash
      return self.clients.openWindow(appUrl + hash);
    })
  );
});
