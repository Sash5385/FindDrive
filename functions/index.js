const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
// v1-неймспейс — лише для icsFeed: v1 HTTPS-функції отримують передбачуваний URL
// (https://REGION-PROJECT.cloudfunctions.net/NAME), тоді як v2 — непередбачуваний Cloud Run URL
// з хешем, який неможливо зашити в код клієнта заздалегідь.
const functionsV1 = require('firebase-functions/v1');
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

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function icsStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// Публічний ICS-фід записів учня/інструктора для підписки в Google/Apple Calendar.
// Авторизація — через непередбачуваний calToken у query (календарні застосунки не можуть
// слати Firebase Auth заголовки при періодичному опитуванні), тому це відкритий HTTP endpoint,
// а не Callable/Firestore-функція — читаємо напряму через Admin SDK (firestore.rules тут ні до чого).
exports.icsFeed = functionsV1.region('europe-west1').https.onRequest(async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) { res.status(400).send('Missing token'); return; }

  try {
    let calName = 'FindDrive', bookings = [];

    const instrSnap = await admin.firestore().collection('instructors').where('calToken', '==', token).limit(1).get();
    if (!instrSnap.empty) {
      const instr = instrSnap.docs[0];
      if (instr.data().calendarSyncEnabled === false) { res.status(403).send('Sync disabled'); return; }
      calName = `FindDrive — ${instr.data().name || 'Інструктор'}`;
      const [s1, s2] = await Promise.all([
        admin.firestore().collection('bookings').where('instructorId', '==', instr.id).where('status', '==', 'confirmed').get(),
        admin.firestore().collection('bookings').where('instructorId', '==', instr.id).where('status', '==', 'pending').get(),
      ]);
      bookings = [...s1.docs, ...s2.docs].map(d => ({ ...d.data(), _id: d.id, _who: 'client' }));
    } else {
      const userSnap = await admin.firestore().collection('users').where('calToken', '==', token).limit(1).get();
      if (userSnap.empty) { res.status(404).send('Not found'); return; }
      const user = userSnap.docs[0];
      if (user.data().calendarSyncEnabled === false) { res.status(403).send('Sync disabled'); return; }
      calName = `FindDrive — ${user.data().name || 'Учень'}`;
      const [s1, s2] = await Promise.all([
        admin.firestore().collection('bookings').where('clientId', '==', user.id).where('status', '==', 'confirmed').get(),
        admin.firestore().collection('bookings').where('clientId', '==', user.id).where('status', '==', 'pending').get(),
      ]);
      bookings = [...s1.docs, ...s2.docs].map(d => ({ ...d.data(), _id: d.id, _who: 'instructor' }));
    }

    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FindDrive//Calendar Feed//UK', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsEscape(calName)}`, 'X-WR-TIMEZONE:Europe/Kyiv',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ];
    bookings.forEach(bk => {
      if (!bk.date || !bk.time) return;
      const offsetMin = kyivOffsetMinutes(new Date(`${bk.date}T12:00:00Z`));
      const start = bookingDateTimeUtc(bk.date, bk.time, offsetMin);
      const end   = new Date(start.getTime() + (bk.duration || 60) * 60000);
      const who   = bk._who === 'client' ? (bk.clientName || 'Учень') : (bk.instructorName || 'Інструктор');
      const loc   = bk.meetingPoint?.label || bk.area || '';
      lines.push(
        'BEGIN:VEVENT',
        `UID:finddrive-${bk._id}@finddrive.in.ua`,
        `DTSTAMP:${icsStamp(new Date())}`,
        `DTSTART:${icsStamp(start)}`,
        `DTEND:${icsStamp(end)}`,
        `SUMMARY:${icsEscape('Заняття з водіння — ' + who)}`,
      );
      if (loc) lines.push(`LOCATION:${icsEscape(loc)}`);
      lines.push(`STATUS:${bk.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=1800');
    res.status(200).send(lines.join('\r\n'));
  } catch (e) {
    console.error('icsFeed error:', e.message);
    res.status(500).send('Internal error');
  }
});
