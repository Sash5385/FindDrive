// Міст FindDrive ⇄ ID4Drive: синхронізація слотів і броней (варіант D+).
// ID4 = джерело правди по слотах, FD = вітрина і прийом броней. Контракт — у CONTRACT.md оркестратора.
const admin = require('firebase-admin');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { verify, postSigned } = require('./syncAuth');
const H = require('./id4Helpers');

const REGION = 'europe-west1';
const ID4_BASE = process.env.ID4_BASE_URL
  || 'https://europe-west1-id4drive-booking-44182.cloudfunctions.net';
const ADMIN_EMAIL = 'sash5385@gmail.com';

// Спільний секрет (те саме значення в обох проєктах): firebase functions:secrets:set FD_ID4_SECRET
const FD_ID4_SECRET = defineSecret('FD_ID4_SECRET');

const db = () => admin.firestore();
const FV = () => admin.firestore.FieldValue;

// --- Допоміжне ---

// Єдиний зв'язаний інструктор: { id, data } | { error:'no_linked_instructor'|'multiple_linked_instructors' }
async function findLinkedInstructor() {
  const snap = await db().collection('instructors').where('id4Linked', '==', true).limit(2).get();
  if (snap.empty) return { error: 'no_linked_instructor' };
  if (snap.size > 1) return { error: 'multiple_linked_instructors' };
  return { id: snap.docs[0].id, data: snap.docs[0].data() };
}

async function isLinkedInstructorId(instrId) {
  if (!instrId) return false;
  const snap = await db().collection('instructors').doc(instrId).get();
  return snap.exists && snap.data().id4Linked === true;
}

// Маркер "цю зміну зробила синхронізація" (nonce syncOriginAt робить кожну подію унікальною)
const originMark = origin => ({ syncOrigin: origin, syncOriginAt: Date.now() });

const bookingMs = d => (d && typeof d.toMillis === 'function') ? d.toMillis() : null;

async function postId4(name, payload) {
  return postSigned(`${ID4_BASE}/${name}`, payload, FD_ID4_SECRET.value());
}

// --- Заявка слоту в ID4 ---

// Повертає 'ok' | 'taken' | 'error'
async function claimInId4(bookingId, b, claimStatus) {
  try {
    const res = await postId4('fdClaimSlot', {
      fdBookingId: bookingId,
      date: b.date,
      time: b.time,
      durMin: Number(b.duration) || 60,
      clientName: b.clientName || '',
      clientPhone: b.clientPhone || '',
      ...(b.clientEmail ? { clientEmail: b.clientEmail } : {}),
      status: claimStatus,
    });
    if (res && res.ok) return 'ok';
    if (res && res.reason === 'taken') return 'taken';
    console.error('fdClaimSlot відмовив:', bookingId, res && res.reason);
    return 'error';
  } catch (e) {
    console.error('fdClaimSlot помилка мережі:', bookingId, e.message);
    return 'error';
  }
}

// Виконує заявку й записує наслідок у бронь. Повертає 'ok' | 'taken' | 'error'.
async function claimAndApply(ref, b, claimStatus) {
  const outcome = await claimInId4(ref.id, b, claimStatus);
  if (outcome === 'ok') {
    const upd = { id4Synced: true, id4SyncError: FV().delete(), id4ClaimStatus: FV().delete() };
    if (claimStatus === 'confirmed' && b.status !== 'confirmed') {
      Object.assign(upd, { status: 'confirmed' }, originMark('fd'));
    }
    await ref.update(upd);
  } else if (outcome === 'taken') {
    await ref.update({
      status: 'cancelled', cancelledBy: 'system', cancelReason: 'slot_taken',
      id4SyncError: FV().delete(), ...originMark('fd'),
    });
  } else {
    await ref.update({ id4SyncError: true, id4ClaimStatus: claimStatus });
  }
  return outcome;
}

// --- Тригери бронювань (викликаються з index.js) ---

// Новий запис. Повертає { cancelled:true }, якщо запис одразу скасовано (ліміт / слот зайнято) —
// тоді інструктору push не потрібен.
async function handleBookingCreated(bookingId, b) {
  try {
    if (!(await isLinkedInstructorId(b.instructorId))) return {};
    const ref = db().collection('bookings').doc(bookingId);
    const todayStr = H.kyivDateStr(Date.now());

    let all = [{ ...b, id: bookingId }];
    if (b.clientId) {
      const snap = await db().collection('bookings').where('clientId', '==', b.clientId).get();
      all = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      if (!all.some(x => x.id === bookingId)) all.push({ ...b, id: bookingId });
    }
    const decision = H.decideNewBooking(all, todayStr);
    if (decision.action === 'limit') {
      await ref.update({ status: 'cancelled', cancelledBy: 'system', cancelReason: 'limit', ...originMark('fd') });
      return { cancelled: true };
    }
    const outcome = await claimAndApply(ref, b, decision.claimStatus);
    return { cancelled: outcome === 'taken' };
  } catch (e) {
    console.error('handleBookingCreated:', bookingId, e.message);
    try { await db().collection('bookings').doc(bookingId).update({ id4SyncError: true }); } catch (_) {}
    return {};
  }
}

async function sendUpdateToId4(bookingId, action, by) {
  try {
    const res = await postId4('fdUpdateBooking', { fdBookingId: bookingId, action, by });
    if (res && res.ok) return true;
    if (res && res.reason === 'not_found') { console.warn('fdUpdateBooking: not_found', bookingId); return true; }
    console.error('fdUpdateBooking відмовив:', bookingId, res && res.reason);
    return false;
  } catch (e) {
    console.error('fdUpdateBooking помилка мережі:', bookingId, e.message);
    return false;
  }
}

// Зміна статусу запису не з ID4 -> повідомити ID4 (confirm / cancel)
async function handleBookingUpdated(bookingId, before, after) {
  try {
    const act = H.id4ActionForUpdate(before, after);
    if (!act) return;
    if (after.id4Synced !== true) return; // слот ще не заявлено в ID4 — підхопить повторна заявка за статусом
    if (!(await isLinkedInstructorId(after.instructorId))) return;
    const ok = await sendUpdateToId4(bookingId, act.action, act.by);
    if (!ok) await db().collection('bookings').doc(bookingId).update({ id4UpdateError: true });
  } catch (e) {
    console.error('handleBookingUpdated:', bookingId, e.message);
  }
}

// --- Вхідні ендпоінти ---

function signedEndpoint(handler) {
  return onRequest({ region: REGION, secrets: [FD_ID4_SECRET] }, async (req, res) => {
    const v = verify(req, FD_ID4_SECRET.value());
    if (!v.ok) { res.status(v.status).json({ ok: false, reason: v.reason }); return; }
    try {
      const out = await handler(v.body);
      res.status(out && out.reason === 'bad_request' ? 400 : 200).json(out);
    } catch (e) {
      console.error('id4Bridge endpoint error:', e);
      res.status(500).json({ ok: false, reason: 'internal' });
    }
  });
}

// ID4 -> FD: відкриті слоти по датах
async function slotsSyncHandler(body) {
  const dates = body.dates;
  if (!dates || typeof dates !== 'object' || Array.isArray(dates)) return { ok: false, reason: 'bad_request' };
  if (Object.keys(dates).length > 100) return { ok: false, reason: 'bad_request' };

  const linked = await findLinkedInstructor();
  if (linked.error) return { ok: false, reason: linked.error };

  // Слоти, вже зайняті активними бронями FD (bookingSlots — дзеркало без персональних даних)
  const bsSnap = await db().collection('bookingSlots').where('instructorId', '==', linked.id).get();
  const occupied = H.occupiedFromBookings(bsSnap.docs.map(d => d.data()));

  const ref = db().collection('instructors').doc(linked.id);
  const todayStr = H.kyivDateStr(Date.now());
  const result = await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { changed: [], skipped: [] };
    const data = snap.data();
    const r = H.buildAvailabilityUpdates({
      availability: data.availability, profile: data, dates, occupied, todayStr,
      syncedAt: admin.firestore.Timestamp.now(),
    });
    if (r.changed.length) tx.update(ref, r.updates);
    return r;
  });
  return { ok: true, updated: result.changed.length, skipped: result.skipped.length };
}

// ID4 -> FD: бронь змінена в ID4 (адмін підтвердив / скасував / переніс)
async function bookingEventHandler(body) {
  const { fdBookingId, status, date, time, durMin } = body;
  if (typeof fdBookingId !== 'string' || !fdBookingId || fdBookingId.includes('/')) return { ok: false, reason: 'bad_request' };
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) return { ok: false, reason: 'bad_request' };
  if (date != null && !H.DATE_RE.test(date)) return { ok: false, reason: 'bad_request' };
  if (time != null && !H.TIME_RE.test(time)) return { ok: false, reason: 'bad_request' };

  const linked = await findLinkedInstructor();
  if (linked.error) return { ok: false, reason: linked.error };

  const ref = db().collection('bookings').doc(fdBookingId);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().instructorId !== linked.id) return { ok: false, reason: 'not_found' };
    const cur = snap.data();
    const upd = {};
    if (status !== cur.status) upd.status = status;
    if (date && date !== cur.date) upd.date = date;
    if (time && time !== cur.time) upd.time = time;
    const dur = Number(durMin);
    if (Number.isFinite(dur) && dur > 0 && dur !== (cur.duration || 60)) upd.duration = dur;
    if (!Object.keys(upd).length) return { ok: true, unchanged: true };
    if (upd.status === 'cancelled') { upd.cancelledBy = 'instructor'; upd.cancelReason = 'id4'; }
    tx.update(ref, { ...upd, ...originMark('id4') });
    return { ok: true };
  });
}

const id4SlotsSync = signedEndpoint(slotsSyncHandler);
const id4BookingEvent = signedEndpoint(bookingEventHandler);

// --- Розклад: протермінування pending + повтори ---

async function sweep() {
  const linked = await findLinkedInstructor();
  if (linked.error) return;
  const now = Date.now();
  const todayStr = H.kyivDateStr(now);

  const [pendSnap, confSnap, updErrSnap] = await Promise.all([
    db().collection('bookings').where('instructorId', '==', linked.id).where('status', '==', 'pending').get(),
    db().collection('bookings').where('instructorId', '==', linked.id).where('status', '==', 'confirmed').get(),
    db().collection('bookings').where('id4UpdateError', '==', true).get(),
  ]);

  // (a) протермінування pending (старше 24 год або заняття вже почалось)
  const handled = new Set();
  for (const doc of pendSnap.docs) {
    const b = doc.data();
    if (!H.isPendingExpired({ ...b, createdAtMs: bookingMs(b.createdAt) }, now)) continue;
    handled.add(doc.id);
    await doc.ref.update({ status: 'cancelled', cancelledBy: 'system', cancelReason: 'expired', ...originMark('fd') });
    if (b.id4Synced === true) {
      const ok = await sendUpdateToId4(doc.id, 'cancel', 'system');
      if (!ok) await doc.ref.update({ id4UpdateError: true });
    }
  }

  // (b) повтор fdClaimSlot лише для записів із прапорцем id4SyncError
  // (старі записи до зв'язування без прапорця НЕ чіпаємо — інакше їх можна помилково скасувати як "taken")
  for (const doc of [...pendSnap.docs, ...confSnap.docs]) {
    if (handled.has(doc.id)) continue;
    const b = doc.data();
    if (b.id4SyncError !== true || b.id4Synced === true) continue;
    if (!b.date || b.date < todayStr) { await doc.ref.update({ id4SyncError: FV().delete() }); continue; }
    const claimStatus = b.status === 'confirmed' ? 'confirmed' : (b.id4ClaimStatus === 'confirmed' ? 'confirmed' : 'pending');
    await claimAndApply(doc.ref, b, claimStatus);
  }

  // (c) повтор fdUpdateBooking, що не дійшов
  for (const doc of updErrSnap.docs) {
    if (handled.has(doc.id)) continue;
    const b = doc.data();
    const action = b.status === 'cancelled' ? 'cancel' : b.status === 'confirmed' ? 'confirm' : null;
    if (!action) { await doc.ref.update({ id4UpdateError: FV().delete() }); continue; }
    const by = b.cancelledBy === 'client' ? 'client' : b.cancelledBy === 'system' ? 'system' : 'instructor';
    if (await sendUpdateToId4(doc.id, action, by)) await doc.ref.update({ id4UpdateError: FV().delete() });
  }
}

const id4BridgeSweep = onSchedule(
  { schedule: 'every 10 minutes', region: REGION, secrets: [FD_ID4_SECRET] },
  async () => { await sweep(); }
);

// --- Callable: скасування запису ---

const cancelBooking = onCall({ region: REGION }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Потрібен вхід в акаунт');
  const bookingId = request.data && request.data.bookingId;
  if (typeof bookingId !== 'string' || !bookingId || bookingId.includes('/')) {
    throw new HttpsError('invalid-argument', 'Не вказано запис');
  }
  const uid = request.auth.uid;
  const email = request.auth.token.email || null;

  const ref = db().collection('bookings').doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Запис не знайдено');
  const b = snap.data();

  const instrSnap = b.instructorId ? await db().collection('instructors').doc(b.instructorId).get() : null;
  const instr = instrSnap && instrSnap.exists ? instrSnap.data() : null;

  const isAdminUser = email === ADMIN_EMAIL;
  const isInstr = !!instr && (instr.userId === uid || (!!email && instr.email === email));
  const isClient = b.clientId === uid;
  if (!isAdminUser && !isInstr && !isClient) throw new HttpsError('permission-denied', 'Немає доступу до цього запису');

  if (b.status === 'cancelled') return { ok: true, already: true };

  // Вікно 24 год — лише для клієнта і лише для зв'язаного з ID4 інструктора
  if (!isAdminUser && !isInstr && isClient) {
    const chk = H.canClientCancel(b, Date.now(), !!instr && instr.id4Linked === true);
    if (!chk.ok) {
      throw new HttpsError('failed-precondition', 'Скасування можливе не пізніше ніж за 24 год до заняття', { reason: 'cancel_window' });
    }
  }

  // Без syncOrigin — тригер onBookingUpdated сам перешле скасування в ID4
  await ref.update({
    status: 'cancelled',
    cancelledBy: (isAdminUser || isInstr) ? 'instructor' : 'client',
    cancelledAt: FV().serverTimestamp(),
  });
  return { ok: true };
});

module.exports = {
  FD_ID4_SECRET, id4SlotsSync, id4BookingEvent, id4BridgeSweep, cancelBooking,
  handleBookingCreated, handleBookingUpdated,
  // для тестів / повторного використання
  slotsSyncHandler, bookingEventHandler, sweep,
};
