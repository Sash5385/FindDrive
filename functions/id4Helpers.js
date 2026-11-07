// Чисті (без залежностей від Firebase) допоміжні функції мосту FindDrive ⇄ ID4Drive.
// Винесені окремо, щоб тестувати через node:test без firebase-admin.

const TZ = 'Europe/Kyiv';
const HOUR = 3600 * 1000;
const CANCEL_WINDOW_MS = 24 * HOUR;
const PENDING_TTL_MS = 24 * HOUR;
const MAX_ACTIVE_BOOKINGS = 2;
const SYNC_WINDOW_DAYS = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// --- Час (Europe/Kyiv) ---

// Зсув Europe/Kyiv від UTC (мс) у конкретний момент — враховує літній/зимовий час
function kyivOffsetMs(utcMs) {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).forEach(x => { p[x.type] = x.value; });
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// "YYYY-MM-DD" + "HH:MM" за київським часом -> UTC-мілісекунди.
// Зсув береться саме на дату заняття (а не на "зараз"), тому перехід на літній час не ламає вікно 24 год.
function kyivToUtcMs(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (const off of [3 * HOUR, 2 * HOUR]) { // при неоднозначному часі беремо ранішій момент (суворіше)
    if (kyivOffsetMs(naive - off) === off) return naive - off;
  }
  return naive - kyivOffsetMs(naive - 3 * HOUR); // неіснуючий час (пропуск при переході)
}

// Сьогоднішня дата YYYY-MM-DD за Києвом
function kyivDateStr(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// --- Скасування клієнтом ---

// Чи може клієнт скасувати запис. Вікно 24 год діє лише для зв'язаного з ID4 інструктора.
// Повертає { ok:true } або { ok:false, reason:'cancel_window' }.
function canClientCancel({ date, time }, nowMs, linked) {
  if (!linked) return { ok: true };
  if (!DATE_RE.test(date || '') || !TIME_RE.test(time || '')) return { ok: false, reason: 'cancel_window' };
  const startMs = kyivToUtcMs(date, time);
  return startMs - nowMs >= CANCEL_WINDOW_MS ? { ok: true } : { ok: false, reason: 'cancel_window' };
}

// --- Ліміт і довірені клієнти ---

const isActive = (b, todayStr) =>
  (b.status === 'pending' || b.status === 'confirmed') && !!b.date && b.date >= todayStr;

// Довірений = має підтверджений запис у минулому (у будь-якого інструктора)
const isTrustedClient = (bookings, todayStr) =>
  bookings.some(b => b.status === 'confirmed' && !!b.date && b.date < todayStr);

// Рішення для нового запису до зв'язаного інструктора.
// bookings — УСІ записи клієнта, включно з новим. Новий запис рахується активним.
// -> { action:'limit' } або { action:'claim', claimStatus:'confirmed'|'pending' }
function decideNewBooking(bookings, todayStr) {
  const active = bookings.filter(b => isActive(b, todayStr)).length;
  if (active > MAX_ACTIVE_BOOKINGS) return { action: 'limit' };
  return { action: 'claim', claimStatus: isTrustedClient(bookings, todayStr) ? 'confirmed' : 'pending' };
}

// --- Протермінування pending ---

function isPendingExpired(b, nowMs) {
  if (b.status !== 'pending') return false;
  if (b.date && b.time && DATE_RE.test(b.date) && TIME_RE.test(b.time) && kyivToUtcMs(b.date, b.time) <= nowMs) return true;
  const created = b.createdAtMs;
  return Number.isFinite(created) && nowMs - created > PENDING_TTL_MS;
}

// --- Захист від ехо-циклів ---

// Зміну зробила сама синхронізація (id4 / fd), якщо маркер змінився в цьому оновленні.
// syncOriginAt — «nonce»: без нього друга подія з ID4 поспіль була б неотличима від ручної правки.
function isSyncOriginChange(before, after) {
  return (after.syncOrigin === 'id4' || after.syncOrigin === 'fd') && after.syncOriginAt !== before.syncOriginAt;
}

// Яку дію відправити в ID4 при зміні запису (null — нічого не слати).
function id4ActionForUpdate(before, after) {
  if (before.status === after.status) return null;
  if (isSyncOriginChange(before, after)) return null;
  if (after.status === 'confirmed') return { action: 'confirm', by: 'instructor' };
  if (after.status === 'cancelled') {
    const by = after.cancelledBy === 'client' ? 'client' : after.cancelledBy === 'system' ? 'system' : 'instructor';
    return { action: 'cancel', by };
  }
  return null;
}

// --- Слоти ---

const slotToMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const minToSlot = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// Мапа date -> Set<'HH:MM'> усіх 30-хвилинних позицій, зайнятих активними бронями FD
function occupiedFromBookings(bookings) {
  const map = {};
  for (const b of bookings) {
    if (!b || !b.date || !TIME_RE.test(b.time || '')) continue;
    if (b.status && b.status !== 'pending' && b.status !== 'confirmed') continue;
    const start = slotToMin(b.time);
    const n = Math.max(1, Math.ceil((Number(b.duration) || 60) / 30));
    const set = map[b.date] || (map[b.date] = new Set());
    for (let i = 0; i < n; i++) set.add(minToSlot(start + i * 30));
  }
  return map;
}

// Нормалізує список слотів із запиту: лише валідні HH:MM, унікальні, відсортовані
function cleanSlots(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter(s => typeof s === 'string' && TIME_RE.test(s)))].sort();
}

// Локація за замовчуванням для дати без власної: найближча ПОПЕРЕДНЯ дата з точкою,
// інакше перша точка зустрічі з профілю. Повертає {location, locationLat, locationLng} або null.
function pickDefaultLocation(availability, dateStr, profile) {
  const av = availability || {};
  const prev = Object.keys(av).filter(k => k < dateStr && av[k] && av[k].locationLat && av[k].location).sort();
  if (prev.length) {
    const a = av[prev[prev.length - 1]];
    return { location: a.location, locationLat: a.locationLat, locationLng: a.locationLng || null };
  }
  const pt = ((profile && profile.meetingPoints) || []).find(p => p && typeof p === 'object' && p.lat);
  if (pt) return { location: pt.label || '', locationLat: pt.lat, locationLng: pt.lng || null };
  return null;
}

// Зливає слоти з ID4 у запис availability[date], зберігаючи все існуюче (локацію, перерву, тривалості).
function mergeAvailability(existing, slots, defaultLoc, syncedAt) {
  const merged = { ...(existing || {}) };
  delete merged.open; // "день вихідний" не має перекривати синхронізовані слоти
  merged.openSlots = slots;
  merged.source = 'id4';
  merged.syncedAt = syncedAt;
  if (!merged.locationLat && defaultLoc) {
    merged.location = defaultLoc.location;
    merged.locationLat = defaultLoc.locationLat;
    if (defaultLoc.locationLng != null) merged.locationLng = defaultLoc.locationLng;
  }
  return merged;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Будує оновлення availability.<date> для всіх дат запиту.
// dates: { 'YYYY-MM-DD': ['HH:MM'] }; occupied: date -> Set слотів, що зайняті бронями FD.
// Повертає { updates: {'availability.<date>': obj}, changed:[dates], skipped:[dates] }.
function buildAvailabilityUpdates({ availability, profile, dates, occupied, todayStr, syncedAt }) {
  const work = { ...(availability || {}) }; // локальна копія — наступні дати успадковують локацію попередніх
  const updates = {}, changed = [], skipped = [];
  const maxDate = addDaysStr(todayStr, SYNC_WINDOW_DAYS + 5);
  for (const date of Object.keys(dates || {}).sort()) {
    if (!DATE_RE.test(date) || date < todayStr || date > maxDate) { skipped.push(date); continue; }
    const occ = (occupied && occupied[date]) || new Set();
    const slots = cleanSlots(dates[date]).filter(s => !occ.has(s));
    const existing = work[date];
    if (!slots.length && !(existing && (existing.source === 'id4' || (existing.openSlots && existing.openSlots.length)))) {
      continue; // нічого відкривати й нічого закривати — не створюємо порожній запис
    }
    const merged = mergeAvailability(existing, slots, pickDefaultLocation(work, date, profile), syncedAt);
    const prevSlots = (existing && Array.isArray(existing.openSlots)) ? existing.openSlots : [];
    const same = existing && existing.source === 'id4' && existing.open == null
      && sameList(prevSlots, slots)
      && (existing.locationLat || null) === (merged.locationLat || null);
    if (same) continue;
    work[date] = merged;
    updates[`availability.${date}`] = merged;
    changed.push(date);
  }
  return { updates, changed, skipped };
}

module.exports = {
  CANCEL_WINDOW_MS, PENDING_TTL_MS, MAX_ACTIVE_BOOKINGS, SYNC_WINDOW_DAYS, DATE_RE, TIME_RE,
  kyivOffsetMs, kyivToUtcMs, kyivDateStr, addDaysStr,
  canClientCancel, isActive, isTrustedClient, decideNewBooking, isPendingExpired,
  isSyncOriginChange, id4ActionForUpdate,
  occupiedFromBookings, cleanSlots, pickDefaultLocation, mergeAvailability, buildAvailabilityUpdates,
};
