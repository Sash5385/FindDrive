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
  self.registration.showNotification(title, {
    body,
    icon: '/favicon.png',
    badge: '/favicon.png',
  });
});
