// Тести чистих допоміжних функцій мосту FD ⇄ ID4: node --test functions/
const test = require('node:test');
const assert = require('node:assert/strict');
const { sign, verify } = require('./syncAuth');
const H = require('./id4Helpers');

const SECRET = 'test-secret';

function fakeReq(bodyObj, { secret = SECRET, method = 'POST', sigOverride } = {}) {
  const raw = JSON.stringify(bodyObj);
  return {
    method,
    rawBody: Buffer.from(raw),
    headers: { 'x-sync-signature': sigOverride !== undefined ? sigOverride : sign(secret, raw) },
  };
}

// --- Підпис ---
test('verify: коректний підпис і свіжий ts', () => {
  const r = verify(fakeReq({ ts: Date.now(), a: 1 }), SECRET);
  assert.equal(r.ok, true);
  assert.equal(r.body.a, 1);
});

test('verify: чужий секрет / зіпсований підпис -> 401', () => {
  const r1 = verify(fakeReq({ ts: Date.now() }, { secret: 'other' }), SECRET);
  assert.deepEqual([r1.ok, r1.status, r1.reason], [false, 401, 'bad_signature']);
  const r2 = verify(fakeReq({ ts: Date.now() }, { sigOverride: 'abc' }), SECRET);
  assert.equal(r2.status, 401);
  const r3 = verify(fakeReq({ ts: Date.now() }, { sigOverride: '' }), SECRET);
  assert.equal(r3.status, 401);
});

test('verify: протермінований ts (>5 хв) і ts з майбутнього -> 401 expired', () => {
  const r1 = verify(fakeReq({ ts: Date.now() - 6 * 60 * 1000 }), SECRET);
  assert.deepEqual([r1.ok, r1.status, r1.reason], [false, 401, 'expired']);
  const r2 = verify(fakeReq({ ts: Date.now() + 6 * 60 * 1000 }), SECRET);
  assert.equal(r2.reason, 'expired');
  const r3 = verify(fakeReq({ ts: Date.now() - 4 * 60 * 1000 }), SECRET);
  assert.equal(r3.ok, true);
  assert.equal(verify(fakeReq({ a: 1 }), SECRET).reason, 'expired'); // немає ts
});

test('verify: не POST -> 405; підпис рахується по сирому тілу', () => {
  assert.equal(verify(fakeReq({ ts: Date.now() }, { method: 'GET' }), SECRET).status, 405);
  const req = fakeReq({ ts: Date.now(), x: 1 });
  req.rawBody = Buffer.from(req.rawBody.toString().replace('"x":1', '"x":2')); // тіло змінили після підпису
  assert.equal(verify(req, SECRET).reason, 'bad_signature');
});

// --- Довірений клієнт і ліміт ---
const TODAY = '2026-06-10';
const bk = (status, date) => ({ status, date });

test('decideNewBooking: новий клієнт -> pending', () => {
  const r = H.decideNewBooking([bk('pending', '2026-06-12')], TODAY);
  assert.deepEqual(r, { action: 'claim', claimStatus: 'pending' });
});

test('decideNewBooking: довірений (є confirmed у минулому) -> confirmed', () => {
  const r = H.decideNewBooking([bk('confirmed', '2026-05-01'), bk('pending', '2026-06-12')], TODAY);
  assert.deepEqual(r, { action: 'claim', claimStatus: 'confirmed' });
  // confirmed у майбутньому довіреним не робить
  assert.equal(H.decideNewBooking([bk('confirmed', '2026-06-11'), bk('pending', '2026-06-12')], TODAY).claimStatus, 'pending');
  // скасовані в минулому не рахуються
  assert.equal(H.decideNewBooking([bk('cancelled', '2026-05-01'), bk('pending', '2026-06-12')], TODAY).claimStatus, 'pending');
});

test('decideNewBooking: ліміт — понад 2 активні (з новим) -> limit', () => {
  const two = [bk('confirmed', '2026-06-11'), bk('pending', '2026-06-12')];
  assert.equal(H.decideNewBooking(two, TODAY).action, 'claim'); // 2 активні — ще можна
  const three = [...two, bk('pending', '2026-06-13')];
  assert.equal(H.decideNewBooking(three, TODAY).action, 'limit');
  // скасовані й минулі в ліміт не входять; довірений теж підпадає під ліміт
  const mixed = [bk('cancelled', '2026-06-11'), bk('confirmed', '2026-05-01'), bk('pending', '2026-06-12'), bk('pending', '2026-06-13')];
  assert.equal(H.decideNewBooking(mixed, TODAY).action, 'claim');
  assert.equal(H.decideNewBooking([...mixed, bk('pending', '2026-06-14')], TODAY).action, 'limit');
  // запис на сьогодні активний (дата >= сьогодні)
  assert.equal(H.isActive(bk('pending', TODAY), TODAY), true);
});

// --- Вікно скасування 24 год (Europe/Kyiv) ---
const utc = s => Date.parse(s);

test('kyivToUtcMs: літній і зимовий час', () => {
  assert.equal(H.kyivToUtcMs('2026-07-01', '12:00'), utc('2026-07-01T09:00:00Z')); // UTC+3
  assert.equal(H.kyivToUtcMs('2026-01-15', '12:00'), utc('2026-01-15T10:00:00Z')); // UTC+2
});

test('canClientCancel: звичайний інструктор — без вікна', () => {
  assert.equal(H.canClientCancel({ date: '2026-07-01', time: '12:00' }, utc('2026-07-01T08:59:00Z'), false).ok, true);
});

test('canClientCancel: зв\'язаний — рівно 24 год ще можна, на хвилину менше — ні', () => {
  const rec = { date: '2026-07-01', time: '12:00' }; // 09:00Z
  assert.equal(H.canClientCancel(rec, utc('2026-06-30T09:00:00Z'), true).ok, true);
  const late = H.canClientCancel(rec, utc('2026-06-30T09:01:00Z'), true);
  assert.deepEqual([late.ok, late.reason], [false, 'cancel_window']);
  assert.equal(H.canClientCancel(rec, utc('2026-07-01T10:00:00Z'), true).ok, false); // вже минуло
});

test('canClientCancel: перехід на літній час (29.03.2026, Київ UTC+2 -> UTC+3)', () => {
  // Заняття 29.03 10:00 за Києвом = 07:00Z (вже UTC+3). Фіксований +2 дав би 08:00Z.
  const rec = { date: '2026-03-29', time: '10:00' };
  assert.equal(H.kyivToUtcMs('2026-03-29', '10:00'), utc('2026-03-29T07:00:00Z'));
  assert.equal(H.canClientCancel(rec, utc('2026-03-28T07:00:00Z'), true).ok, true);   // рівно 24 год
  assert.equal(H.canClientCancel(rec, utc('2026-03-28T07:30:00Z'), true).ok, false);  // 23.5 год
  // До переходу кінцева дата ще "зимова": 28.03 12:00 = 10:00Z
  assert.equal(H.kyivToUtcMs('2026-03-28', '12:00'), utc('2026-03-28T10:00:00Z'));
});

test('canClientCancel: перехід на зимовий час (25.10.2026, UTC+3 -> UTC+2)', () => {
  const rec = { date: '2026-10-25', time: '12:00' }; // після переходу UTC+2 => 10:00Z
  assert.equal(H.kyivToUtcMs('2026-10-25', '12:00'), utc('2026-10-25T10:00:00Z'));
  assert.equal(H.canClientCancel(rec, utc('2026-10-24T10:00:00Z'), true).ok, true);
  assert.equal(H.canClientCancel(rec, utc('2026-10-24T10:01:00Z'), true).ok, false);
});

test('canClientCancel: некоректні дата/час -> відмова для зв\'язаного', () => {
  assert.equal(H.canClientCancel({ date: null, time: null }, Date.now(), true).ok, false);
});

// --- Протермінування pending ---
test('isPendingExpired: старше 24 год або вже почалось', () => {
  const now = utc('2026-06-10T12:00:00Z');
  const base = { status: 'pending', date: '2026-06-20', time: '10:00' };
  assert.equal(H.isPendingExpired({ ...base, createdAtMs: now - 25 * 3600e3 }, now), true);
  assert.equal(H.isPendingExpired({ ...base, createdAtMs: now - 23 * 3600e3 }, now), false);
  assert.equal(H.isPendingExpired({ status: 'pending', date: '2026-06-10', time: '14:00', createdAtMs: now - 3600e3 }, now), true); // 14:00 Київ = 11:00Z
  assert.equal(H.isPendingExpired({ ...base, status: 'confirmed', createdAtMs: now - 99 * 3600e3 }, now), false);
});

// --- Ехо-цикли ---
test('id4ActionForUpdate: ручна зміна -> дія; зміна від синхронізації -> нічого', () => {
  const before = { status: 'pending', syncOrigin: 'id4', syncOriginAt: 100 };
  // ручне підтвердження в FD після старої події з ID4 (маркер не змінився)
  assert.deepEqual(H.id4ActionForUpdate(before, { ...before, status: 'confirmed' }), { action: 'confirm', by: 'instructor' });
  // нова подія з ID4 (nonce змінився) — не пересилаємо назад
  assert.equal(H.id4ActionForUpdate(before, { ...before, status: 'cancelled', syncOriginAt: 200 }), null);
  // внутрішня зміна FD-функції
  assert.equal(H.id4ActionForUpdate({ status: 'pending' }, { status: 'cancelled', syncOrigin: 'fd', syncOriginAt: 5 }), null);
  // скасування клієнтом / системою
  assert.deepEqual(H.id4ActionForUpdate({ status: 'confirmed' }, { status: 'cancelled', cancelledBy: 'client' }), { action: 'cancel', by: 'client' });
  assert.deepEqual(H.id4ActionForUpdate({ status: 'pending' }, { status: 'cancelled', cancelledBy: 'system' }), { action: 'cancel', by: 'system' });
  // статус не змінився
  assert.equal(H.id4ActionForUpdate({ status: 'pending' }, { status: 'pending', id4Synced: true }), null);
});

// --- Злиття доступності ---
const TS = 'TS';
const loc = { location: 'Оболонь, пр. Героїв Сталінграда 1', locationLat: 50.5, locationLng: 30.5 };

test('mergeAvailability зберігає локацію, перерву і тривалості, знімає open:false', () => {
  const existing = { ...loc, breakFrom: '13:00', breakTo: '14:00', durations: [60, 120], open: false, openSlots: ['08:00'] };
  const m = H.mergeAvailability(existing, ['09:00', '10:00'], { location: 'X', locationLat: 1, locationLng: 2 }, TS);
  assert.deepEqual(m.openSlots, ['09:00', '10:00']);
  assert.equal(m.source, 'id4');
  assert.equal(m.syncedAt, TS);
  assert.equal(m.location, loc.location);
  assert.equal(m.locationLat, 50.5);
  assert.deepEqual(m.durations, [60, 120]);
  assert.equal(m.breakFrom, '13:00');
  assert.equal('open' in m, false);
});

test('buildAvailabilityUpdates: локація береться з найближчої попередньої дати, потім із профілю', () => {
  const availability = { '2026-06-12': { ...loc, openSlots: [] } };
  const profile = { meetingPoints: ['рядок', { label: 'Позняки', lat: 50.4, lng: 30.6 }] };
  const r = H.buildAvailabilityUpdates({
    availability, profile, todayStr: TODAY, syncedAt: TS, occupied: {},
    dates: { '2026-06-11': ['09:00'], '2026-06-14': ['10:00', '09:00', 'bad'], '2026-06-15': ['11:00'] },
  });
  assert.equal(r.updates['availability.2026-06-11'].location, 'Позняки');           // раніше за всі — профіль
  assert.equal(r.updates['availability.2026-06-14'].location, loc.location);          // від 06-12
  assert.deepEqual(r.updates['availability.2026-06-14'].openSlots, ['09:00', '10:00']);
  assert.equal(r.updates['availability.2026-06-15'].location, loc.location);          // успадковано ланцюгом
  assert.equal(r.changed.length, 3);
});

test('buildAvailabilityUpdates: пусті дати не створюють записів, але закривають існуючі', () => {
  const availability = {
    '2026-06-12': { ...loc, openSlots: ['09:00'], source: 'id4' },
    '2026-06-13': { ...loc, openSlots: ['09:00'] },
  };
  const r = H.buildAvailabilityUpdates({
    availability, profile: {}, todayStr: TODAY, syncedAt: TS, occupied: {},
    dates: { '2026-06-11': [], '2026-06-12': [], '2026-06-13': [] },
  });
  assert.equal('availability.2026-06-11' in r.updates, false);
  assert.deepEqual(r.updates['availability.2026-06-12'].openSlots, []);
  assert.equal(r.updates['availability.2026-06-12'].location, loc.location); // локація збережена
  assert.deepEqual(r.updates['availability.2026-06-13'].openSlots, []);
});

test('buildAvailabilityUpdates: без змін — без запису; дати поза вікном ігноруються', () => {
  const availability = { '2026-06-12': { ...loc, openSlots: ['09:00'], source: 'id4' } };
  const r = H.buildAvailabilityUpdates({
    availability, profile: {}, todayStr: TODAY, syncedAt: TS, occupied: {},
    dates: { '2026-06-12': ['09:00'], '2026-06-01': ['09:00'], '2027-01-01': ['09:00'], 'garbage': ['09:00'] },
  });
  assert.equal(r.changed.length, 0);
  assert.deepEqual(r.skipped.sort(), ['2026-06-01', '2027-01-01', 'garbage']);
});

test('buildAvailabilityUpdates: слоти, зайняті бронями FD, прибираються (з урахуванням тривалості)', () => {
  const occupied = H.occupiedFromBookings([
    { date: '2026-06-12', time: '10:00', duration: 120, status: 'confirmed' },
    { date: '2026-06-12', time: '15:00', duration: 60, status: 'cancelled' }, // не рахується
  ]);
  const r = H.buildAvailabilityUpdates({
    availability: { '2026-06-12': loc }, profile: {}, todayStr: TODAY, syncedAt: TS, occupied,
    dates: { '2026-06-12': ['09:30', '10:00', '10:30', '11:00', '11:30', '15:00'] },
  });
  assert.deepEqual(r.updates['availability.2026-06-12'].openSlots, ['09:30', '15:00']);
});
