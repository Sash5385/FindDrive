const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();

async function sendPush(uid, title, body) {
  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    const token = snap.data()?.fcmToken;
    if (!token) return;
    await admin.messaging().send({
      token,
      notification: { title, body },
      webpush: {
        notification: {
          icon:  'https://finddrive.id4drive.pro/favicon.png',
          badge: 'https://finddrive.id4drive.pro/favicon.png',
        },
        fcmOptions: { link: 'https://finddrive.id4drive.pro/' }
      }
    });
  } catch (e) {
    console.error('sendPush error:', uid, e.message);
  }
}

// Інструктор отримує push коли клієнт бронює
exports.onBookingCreated = onDocumentCreated('bookings/{id}', async event => {
  const d = event.data.data();
  if (!d.instructorUserId) return;
  await sendPush(
    d.instructorUserId,
    'Новий запис на заняття!',
    `${d.clientName || 'Учень'} — ${d.date} о ${d.time}`
  );
});

// Клієнт отримує push коли інструктор підтверджує / скасовує
exports.onBookingUpdated = onDocumentUpdated('bookings/{id}', async event => {
  const before = event.data.before.data();
  const after  = event.data.after.data();
  if (before.status === after.status || !after.clientId) return;
  if (after.status === 'confirmed') {
    await sendPush(
      after.clientId,
      'Запис підтверджено!',
      `${after.date} о ${after.time} з ${after.instructorName || 'інструктором'}`
    );
  } else if (after.status === 'cancelled') {
    await sendPush(
      after.clientId,
      'Запис скасовано',
      `${after.date} о ${after.time}`
    );
  }
});
