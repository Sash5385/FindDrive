const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const {
  TARGET_INSTRUCTOR_EMAIL,
  CALENDAR_SECRETS,
  getCalendarClient,
  buildEvent,
  getBookingSchedule,
  fromCalendarEvent,
  isIgnorableCalendarError,
} = require('./googleCalendarSync');

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

// ─── Google Calendar sync (MVP, тільки особистий календар одного інструктора) ───
// Портовано з webid4/functions/googleCalendar.js + index.js, адаптовано під
// Firestore (плоска колекція bookings/{bookingId} замість RTDB bookings/{uid}/{bookingId}).

const CALENDAR_SYNC_FIELDS = ['googleEventId', 'calendarId', 'lastSyncedByApp'];
const ECHO_WINDOW_MS = 3 * 60 * 1000;

function isRecentEcho(ts) {
  return !!ts && Date.now() - ts < ECHO_WINDOW_MS;
}

// Якщо різниця before/after — тільки в полях, які пише сам sync (наше ж відлуння)
function onlyCalendarFieldsChanged(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (CALENDAR_SYNC_FIELDS.includes(key)) continue;
    if ((before || {})[key] !== (after || {})[key]) return false;
  }
  return true;
}

// Перевіряє чи діапазон [startMin, startMin+durMin) на дату date вільний
// від інших активних бронювань цільового інструктора (для переносу з календаря)
async function isRangeFreeForBooking(date, startMin, durMin, excludeBookingId) {
  const endMin = startMin + durMin;
  const snap = await admin.firestore().collection('bookings')
    .where('instructorEmail', '==', TARGET_INSTRUCTOR_EMAIL)
    .where('date', '==', date)
    .get();

  for (const doc of snap.docs) {
    if (doc.id === excludeBookingId) continue;
    const b = doc.data();
    if (!b || b.status === 'cancelled') continue;
    const sched = getBookingSchedule(b);
    if (!sched) continue;
    const bEnd = sched.startMin + sched.durMin;
    if (startMin < bEnd && sched.startMin < endMin) return false;
  }

  return true;
}

// Брoнь створена/перенесена/скасована/видалена → відображаємо в Google Calendar
// (тільки для бронювань цільового інструктора — інші instructorEmail ігноруються)
exports.onBookingSyncToCalendar = onDocumentWritten(
  { document: 'bookings/{bookingId}', region: 'europe-west1', secrets: CALENDAR_SECRETS },
  async event => {
    const before = event.data.before?.exists ? event.data.before.data() : null;
    const after = event.data.after?.exists ? event.data.after.data() : null;
    const { bookingId } = event.params;

    const owner = after || before;
    if (!owner || (owner.instructorEmail || '').toLowerCase() !== TARGET_INSTRUCTOR_EMAIL) return;

    if (before && after) {
      const justSyncedFromCalendar =
        after.lastSyncedFromCalendar &&
        after.lastSyncedFromCalendar !== before.lastSyncedFromCalendar &&
        isRecentEcho(after.lastSyncedFromCalendar);
      if (onlyCalendarFieldsChanged(before, after) || justSyncedFromCalendar) return;
    }

    let calendar;
    try {
      calendar = getCalendarClient();
    } catch (e) {
      console.error(`onBookingSyncToCalendar: client init failed bookingId=${bookingId}: ${e.message}`);
      return;
    }

    try {
      // Запис видалено повністю
      if (!after) {
        if (before?.googleEventId) {
          await calendar.events
            .delete({ calendarId: before.calendarId || 'primary', eventId: before.googleEventId })
            .catch(err => { if (!isIgnorableCalendarError(err)) throw err; });
        }
        return;
      }

      // Скасовано — прибираємо event з календаря
      if (after.status === 'cancelled') {
        if (after.googleEventId) {
          await calendar.events
            .delete({ calendarId: after.calendarId || 'primary', eventId: after.googleEventId })
            .catch(err => { if (!isIgnorableCalendarError(err)) throw err; });
          await event.data.after.ref.update({ lastSyncedByApp: Date.now() });
        }
        return;
      }

      // Новий активний запис — створюємо event
      if (!before) {
        const eventBody = buildEvent(after, bookingId);
        if (!eventBody) return;
        const res = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
        await event.data.after.ref.update({
          googleEventId: res.data.id,
          calendarId: 'primary',
          lastSyncedByApp: Date.now(),
        });
        return;
      }

      // Перенесено дату/час/тривалість — оновлюємо event
      const rescheduled =
        after.date !== before.date ||
        after.time !== before.time ||
        after.duration !== before.duration;
      if (!rescheduled) return;

      const eventBody = buildEvent(after, bookingId);
      if (!eventBody) return;

      if (after.googleEventId) {
        await calendar.events.patch({
          calendarId: after.calendarId || 'primary',
          eventId: after.googleEventId,
          requestBody: eventBody,
        });
        await event.data.after.ref.update({ lastSyncedByApp: Date.now() });
      } else {
        const res = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
        await event.data.after.ref.update({
          googleEventId: res.data.id,
          calendarId: 'primary',
          lastSyncedByApp: Date.now(),
        });
      }
    } catch (e) {
      console.error(`onBookingSyncToCalendar error bookingId=${bookingId}: ${e.message}`);
    }
  }
);

// Кожні 10 хв: підтягуємо з Google Calendar скасування/перенос, зроблені вручну в календарі
exports.syncCalendarToApp = onSchedule(
  { schedule: 'every 10 minutes', region: 'europe-west1', secrets: CALENDAR_SECRETS },
  async () => {
    let calendar;
    try {
      calendar = getCalendarClient();
    } catch (e) {
      console.error(`syncCalendarToApp: client init failed: ${e.message}`);
      return;
    }

    const syncStateRef = admin.firestore().collection('_syncState').doc('finddriveCalendar');
    const syncStateSnap = await syncStateRef.get();
    const syncToken = syncStateSnap.exists ? syncStateSnap.data().nextSyncToken : null;

    const events = [];
    let pageToken;
    let newSyncToken = null;

    try {
      do {
        const params = { calendarId: 'primary', maxResults: 250, pageToken };
        if (syncToken) params.syncToken = syncToken;
        else params.timeMin = new Date().toISOString();
        const res = await calendar.events.list(params);
        events.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken;
        if (res.data.nextSyncToken) newSyncToken = res.data.nextSyncToken;
      } while (pageToken);
    } catch (e) {
      const status = e?.code ?? e?.response?.status;
      if (status === 410) {
        console.warn('syncCalendarToApp: syncToken expired (410) — reset for full resync');
        await syncStateRef.delete().catch(() => {});
        return;
      }
      console.error(`syncCalendarToApp: events.list failed: ${e.message}`);
      return;
    }

    for (const ev of events) {
      const priv = ev.extendedProperties?.private;
      if (!priv || priv.appSource !== 'finddrive' || !priv.bookingId) continue;

      const bookingRef = admin.firestore().collection('bookings').doc(priv.bookingId);
      const bookingSnap = await bookingRef.get();
      if (!bookingSnap.exists) continue;
      const booking = bookingSnap.data();
      if (!booking || booking.status === 'cancelled') continue;

      if (ev.status === 'cancelled') {
        // Наше ж недавнє видалення через onBookingSyncToCalendar — ігноруємо
        if (isRecentEcho(booking.lastSyncedByApp)) continue;

        await bookingRef.update({ status: 'cancelled', cancelledBy: 'admin' }).catch(() => {});
        console.log(`syncCalendarToApp: cancelled booking ${priv.bookingId} (deleted in Google Calendar)`);
        continue;
      }

      // Активна подія — перевіряємо чи не перенесена вручну в календарі
      if (isRecentEcho(booking.lastSyncedByApp) || isRecentEcho(booking.lastSyncedFromCalendar)) continue;

      const calSchedule = fromCalendarEvent(ev);
      if (!calSchedule) continue; // all-day подія — не наш формат, ігноруємо

      const appSchedule = getBookingSchedule(booking);
      if (!appSchedule) continue;

      const changed = calSchedule.date !== appSchedule.date ||
        calSchedule.startMin !== appSchedule.startMin ||
        calSchedule.durMin !== appSchedule.durMin;
      if (!changed) continue;

      const free = await isRangeFreeForBooking(
        calSchedule.date, calSchedule.startMin, calSchedule.durMin, priv.bookingId
      );
      if (!free) {
        console.warn(
          `syncCalendarToApp: reschedule from calendar bookingId=${priv.bookingId} → ` +
          `${calSchedule.date} ${calSchedule.time} conflicts with existing slot, skipped`
        );
        continue;
      }

      await bookingRef.update({
        date: calSchedule.date,
        time: calSchedule.time,
        duration: calSchedule.durMin,
        lastSyncedFromCalendar: Date.now(),
      }).catch(() => {});
      console.log(
        `syncCalendarToApp: rescheduled booking ${priv.bookingId} → ` +
        `${calSchedule.date} ${calSchedule.time} (moved in Google Calendar)`
      );
    }

    if (newSyncToken) {
      await syncStateRef.set({ nextSyncToken: newSyncToken }, { merge: true });
    }
  }
);
