const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');
const admin = require('firebase-admin');

admin.initializeApp();

// data — об'єкт, який SW передає в notificationclick → відкриває потрібну панель
// link — куди веде клік по сповіщенню (за замовчуванням головна, для адмін-пушів — admin.html)
async function sendPush(uid, title, body, data = {}, link = 'https://finddrive.in.ua/') {
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
          icon:  'https://finddrive.in.ua/favicon.png',
          badge: 'https://finddrive.in.ua/favicon.png',
        },
        fcmOptions: { link }
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

// Firestore-тригери гарантують доставку "щонайменше один раз" — той самий event.id
// іноді прилітає повторно, тому без цієї перевірки один запис міг слати кілька пушів.
// create() падає з ALREADY_EXISTS, якщо подія вже оброблена — саме так ловимо дублікат.
async function claimEventOnce(eventId) {
  try {
    await admin.firestore().collection('_processedEvents').doc(eventId).create({
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (e) {
    if (e.code === 6 || e.message?.includes('ALREADY_EXISTS')) return false;
    throw e;
  }
}

// Дзеркалить бронювання в публічну колекцію bookingSlots — БЕЗ жодних персональних даних
// (ім'я/телефон/email клієнта та інструктора, точка зустрічі). Анонімний відвідувач має бачити,
// які слоти зайняті, тому bookingSlots публічно читається; сам bookings — ні (firestore.rules).
exports.mirrorBookingSlot = onDocumentWritten(
  { document: 'bookings/{id}', region: 'europe-west1' },
  async event => {
    const after = event.data.after?.exists ? event.data.after.data() : null;
    const ref = admin.firestore().collection('bookingSlots').doc(event.params.id);
    if (!after || !['pending', 'confirmed'].includes(after.status)) {
      await ref.delete().catch(() => {});
      return;
    }
    await ref.set({
      instructorId: after.instructorId || null,
      date: after.date || null,
      time: after.time || null,
      duration: after.duration || 60,
      status: after.status,
    });
  }
);

// Інструктор отримує push коли клієнт бронює
exports.onBookingCreated = onDocumentCreated(
  { document: 'bookings/{id}', region: 'europe-west1' },
  async event => {
    if (!(await claimEventOnce(event.id))) return;
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
    if (!(await claimEventOnce(event.id))) return;
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
    if (!(await claimEventOnce(event.id))) return;
    const d = event.data.data();
    if (d.status !== 'pending') return;
    const adminUid = await getAdminUid();
    if (!adminUid) return;
    await sendPush(
      adminUid,
      'Нова анкета інструктора!',
      `${d.name || 'Інструктор'} — ${d.phone || d.email || ''}`,
      { type: 'admin' },
      'https://finddrive.in.ua/admin.html'
    );
  }
);

// Поточний зсув Europe/Kyiv від UTC у хвилинах (враховує літній/зимовий час)
function kyivOffsetMinutes(date) {
  const utcStr  = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const kyivStr = date.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' });
  return (new Date(kyivStr) - new Date(utcStr)) / 60000;
}

// Перетворює дату+час запису (в Europe/Kyiv) на реальний UTC-момент
function bookingDateTimeUtc(dateStr, timeStr, offsetMin) {
  const naive = new Date(`${dateStr}T${timeStr}:00Z`);
  return new Date(naive.getTime() - offsetMin * 60000);
}

// Нагадування учню й інструктору за ~2 год до підтвердженого заняття
exports.sendLessonReminders = onSchedule(
  { schedule: 'every 30 minutes', region: 'europe-west1' },
  async () => {
    const now = new Date();
    const offsetMin = kyivOffsetMinutes(now);
    const windowStart = new Date(now.getTime() + 105 * 60 * 1000); // +1год45хв
    const windowEnd   = new Date(now.getTime() + 135 * 60 * 1000); // +2год15хв

    const snap = await admin.firestore().collection('bookings')
      .where('status', '==', 'confirmed')
      .get();

    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.reminderSent || !d.date || !d.time) continue;
      const lessonAt = bookingDateTimeUtc(d.date, d.time, offsetMin);
      if (lessonAt < windowStart || lessonAt > windowEnd) continue;

      const locHint = d.meetingPoint?.label ? ` — ${d.meetingPoint.label}` : '';
      if (d.clientId) {
        await sendPush(d.clientId, 'Нагадування про урок', `Сьогодні о ${d.time}${locHint}`, { type: 'booking' });
      }
      const instrUid = d.instructorUserId || await getInstrUserId(d.instructorId);
      if (instrUid) {
        await sendPush(instrUid, 'Нагадування про урок', `${d.clientName || 'Учень'} — сьогодні о ${d.time}${locHint}`, { type: 'booking' });
      }
      await doc.ref.update({ reminderSent: true });
    }
  }
);

// Щоденне прибирання минулих дат з availability інструкторів —
// документ інструктора не повинен рости вічно, старі слоти нікому не потрібні
exports.cleanupOldAvailability = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'Europe/Kyiv', region: 'europe-west1' },
  async () => {
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
    const snap = await admin.firestore().collection('instructors').get();

    let batch = admin.firestore().batch();
    let opsInBatch = 0;
    let touchedDocs = 0;

    for (const doc of snap.docs) {
      const availability = doc.data().availability;
      if (!availability || typeof availability !== 'object') continue;
      const staleKeys = Object.keys(availability).filter(dateStr => dateStr < todayStr);
      if (!staleKeys.length) continue;

      const updates = {};
      staleKeys.forEach(k => { updates[`availability.${k}`] = admin.firestore.FieldValue.delete(); });
      batch.update(doc.ref, updates);
      opsInBatch++;
      touchedDocs++;

      if (opsInBatch >= 400) {
        await batch.commit();
        batch = admin.firestore().batch();
        opsInBatch = 0;
      }
    }
    if (opsInBatch > 0) await batch.commit();
    console.log(`cleanupOldAvailability: очищено ${touchedDocs} документ(ів) інструкторів`);
  }
);

// Push при новому повідомленні в чаті
exports.onChatMessage = onDocumentCreated(
  { document: 'chats/{chatId}/messages/{msgId}', region: 'europe-west1' },
  async event => {
    if (!(await claimEventOnce(event.id))) return;
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

// ===== МОНЕТИЗАЦІЯ — ЧЕРНЕТКА (MONETIZATION.md §6-8) =====
// paymentCallback ще не підключений до реального акаунту LiqPay — назви полів
// callback-payload (order_id, status, payment_id, amount, currency, err_code,
// err_description) відповідають публічній документації LiqPay, але фактичну
// відповідь потрібно звірити в sandbox, коли з'являться реальні ключі.
// Секрет НЕ зберігається в коді: firebase functions:secrets:set LIQPAY_PRIVATE_KEY
const LIQPAY_PRIVATE_KEY = defineSecret('LIQPAY_PRIVATE_KEY');

// Функція-ініціатор платежу (створення order_id, редирект на чекаут LiqPay)
// буде окремим кроком — саме вона й задає цей формат order_id.
const PLAN_DAYS = { monthly: 30, yearly: 365 };
function parseSubscriptionOrderId(orderId) {
  const m = /^sub_([^_]+)_(monthly|yearly)_\d+$/.exec(orderId || '');
  return m ? { instructorId: m[1], plan: m[2] } : null;
}

// signature = base64(sha1(private_key + data + private_key)) — офіційна схема LiqPay.
// timingSafeEqual захищає порівняння підпису від timing-атак; довжини звіряємо
// заздалегідь, бо сама функція падає при вхідних буферах різного розміру.
function liqpaySignatureValid(data, signature, privateKey) {
  const expected = crypto.createHash('sha1').update(privateKey + data + privateKey).digest('base64');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// Приймає server-to-server callback від LiqPay про статус платежу підписки.
exports.paymentCallback = onRequest(
  { region: 'europe-west1', secrets: [LIQPAY_PRIVATE_KEY] },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    const { data, signature } = req.body || {};
    if (!data || !signature) { res.status(400).send('Missing data/signature'); return; }

    if (!liqpaySignatureValid(data, signature, LIQPAY_PRIVATE_KEY.value())) {
      console.error('paymentCallback: invalid signature');
      res.status(400).send('Invalid signature');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    } catch (e) {
      console.error('paymentCallback: bad payload', e.message);
      res.status(400).send('Bad payload');
      return;
    }

    // LiqPay повторює недоставлені callback'и — захист від подвійної обробки.
    const eventId = `liqpay_${payload.payment_id || 'noid'}_${payload.status || 'nostatus'}`;
    if (!(await claimEventOnce(eventId))) { res.status(200).send('OK (duplicate)'); return; }

    await admin.firestore().collection('payments').add({
      provider: 'liqpay',
      orderId: payload.order_id || null,
      paymentId: payload.payment_id || null,
      status: payload.status || null,
      amount: payload.amount || null,
      currency: payload.currency || null,
      errCode: payload.err_code || null,
      errDescription: payload.err_description || null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const parsed = parseSubscriptionOrderId(payload.order_id);
    if (!parsed) {
      console.warn('paymentCallback: unrecognized order_id', payload.order_id);
      res.status(200).send('OK (unrecognized order_id)');
      return;
    }
    const { instructorId, plan } = parsed;
    const instrRef = admin.firestore().collection('instructors').doc(instructorId);

    if (['success', 'subscribed'].includes(payload.status)) {
      const days = PLAN_DAYS[plan] || 30;
      await instrRef.update({
        subscription: {
          status: 'active',
          plan,
          provider: 'liqpay',
          providerRef: payload.payment_id || null,
          currentPeriodEnd: admin.firestore.Timestamp.fromMillis(Date.now() + days * 86400000),
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
    } else if (['failure', 'error'].includes(payload.status)) {
      // Знижуємо статус лише тим, у кого підписка вже була активна —
      // невдала перша спроба оплати без попередньої активної підписки нічого не змінює.
      const snap = await instrRef.get();
      if (snap.data()?.subscription?.status === 'active') {
        await instrRef.update({ 'subscription.status': 'past_due' });
        const uid = snap.data().userId;
        if (uid) {
          await sendPush(uid, 'Проблема з оплатою підписки', 'Оновіть спосіб оплати, щоб не втратити пріоритет у видачі', { type: 'admin' });
        }
      }
    } else if (payload.status === 'unsubscribed') {
      await instrRef.update({ 'subscription.status': 'canceled' });
    }

    res.status(200).send('OK');
  }
);
