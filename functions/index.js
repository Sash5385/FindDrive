const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();

// data — об'єкт, який SW передає в notificationclick → відкриває потрібну панель
async function sendPush(uid, title, body, data = {}) {
  if (!uid) return;
  // FCM data values must be strings
  const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    const token = snap.data()?.fcmToken;
    if (!token) return;
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: strData,
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

// Повертає userId інструктора по його Firestore doc ID
async function getInstrUserId(instrId) {
  if (!instrId) return null;
  const snap = await admin.firestore().collection('instructors').doc(instrId).get();
  return snap.data()?.userId || null;
}

const ADMIN_EMAIL = 'sash5385@gmail.com';

// Повертає uid адміна по email (шукаємо в users, бо саме там зберігається fcmToken)
async function getAdminUid() {
  const snap = await admin.firestore().collection('users').where('email', '==', ADMIN_EMAIL).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

// Інструктор отримує push коли клієнт бронює
exports.onBookingCreated = onDocumentCreated(
  { document: 'bookings/{id}', region: 'europe-west1' },
  async event => {
    const d = event.data.data();
    const uid = d.instructorUserId || await getInstrUserId(d.instructorId);
    if (!uid) return;
    await sendPush(
      uid,
      'Новий запис на заняття!',
      `${d.clientName || 'Учень'} — ${d.date} о ${d.time}`,
      { type: 'booking' }
    );
  }
);

// Клієнт отримує push коли інструктор підтверджує / скасовує
exports.onBookingUpdated = onDocumentUpdated(
  { document: 'bookings/{id}', region: 'europe-west1' },
  async event => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;
    if (after.status === 'cancelled' && after.cancelledBy === 'client') {
      // Клієнт скасував — сповістити інструктора
      const instrUid = after.instructorUserId || await getInstrUserId(after.instructorId);
      if (instrUid) {
        await sendPush(
          instrUid,
          'Заняття скасовано клієнтом',
          `${after.clientName || 'Учень'} — ${after.date} о ${after.time}`,
          { type: 'booking' }
        );
      }
    }
    if (!after.clientId) return;
    if (after.status === 'confirmed') {
      await sendPush(
        after.clientId,
        'Запис підтверджено!',
        `${after.date} о ${after.time} з ${after.instructorName || 'інструктором'}`,
        { type: 'booking' }
      );
    } else if (after.status === 'cancelled') {
      await sendPush(
        after.clientId,
        'Запис скасовано',
        `${after.date} о ${after.time}`,
        { type: 'booking' }
      );
    }
  }
);

// Адмін отримує push коли подана нова анкета інструктора
exports.onInstructorCreated = onDocumentCreated(
  { document: 'instructors/{id}', region: 'europe-west1' },
  async event => {
    const d = event.data.data();
    if (d.status !== 'pending') return;
    const adminUid = await getAdminUid();
    if (!adminUid) return;
    await sendPush(
      adminUid,
      'Нова анкета інструктора!',
      `${d.name || 'Інструктор'} — ${d.phone || d.email || ''}`,
      { type: 'admin' }
    );
  }
);

// Push при новому повідомленні в чаті
exports.onChatMessage = onDocumentCreated(
  { document: 'chats/{chatId}/messages/{msgId}', region: 'europe-west1' },
  async event => {
    const msg    = event.data.data();
    const chatId = event.params.chatId;

    const chatSnap = await admin.firestore().collection('chats').doc(chatId).get();
    if (!chatSnap.exists) return;
    const chat = chatSnap.data();

    const senderUid = msg.uid;
    const text = msg.text || 'Нове повідомлення';

    if (senderUid === chat.studentId) {
      const instrUid = chat.instrUserId || await getInstrUserId(chatId.split('_')[0]);
      await sendPush(
        instrUid,
        `Повідомлення від ${chat.studentName || 'учня'}`,
        text,
        { type: 'chat', chatId, instrId: chatId.split('_')[0] }
      );
    } else {
      await sendPush(
        chat.studentId,
        `Повідомлення від ${chat.instrName || 'інструктора'}`,
        text,
        { type: 'chat', chatId, instrId: chatId.split('_')[0] }
      );
    }
  }
);
