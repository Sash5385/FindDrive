// Підпис і перевірка запитів між ID4Drive та FindDrive (HMAC-SHA256).
// ВАЖЛИВО: цей файл має бути ІДЕНТИЧНИМ в обох репозиторіях (FindDrive і ID4Drive).
const crypto = require('crypto');

const SIGNATURE_HEADER = 'x-sync-signature';
const MAX_SKEW_MS = 5 * 60 * 1000; // допустиме розходження годинників — 5 хвилин
const POST_TIMEOUT_MS = 10 * 1000;

// hex(HMAC-SHA256(secret, bodyString))
function sign(secret, bodyString) {
  return crypto.createHmac('sha256', String(secret)).update(bodyString, 'utf8').digest('hex');
}

// Перевіряє вхідний запит. Повертає { ok:true, body } або { ok:false, status, reason }.
function verify(req, secret) {
  if (req.method !== 'POST') return { ok: false, status: 405, reason: 'method_not_allowed' };
  if (!secret) return { ok: false, status: 500, reason: 'no_secret' };

  const raw = req.rawBody;
  if (!raw) return { ok: false, status: 400, reason: 'empty_body' };
  const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);

  const given = String((req.headers && req.headers[SIGNATURE_HEADER]) || '').trim().toLowerCase();
  const expected = sign(secret, rawStr);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual кидає виняток при різній довжині — довжину перевіряємо окремо
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: 'bad_signature' };
  }

  let body;
  try { body = JSON.parse(rawStr); } catch (e) { return { ok: false, status: 400, reason: 'bad_json' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, reason: 'bad_json' };
  }

  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return { ok: false, status: 401, reason: 'expired' };
  }
  return { ok: true, body };
}

// POST з підписом. Повертає розпарсену JSON-відповідь (в т.ч. {ok:false,...} при 4xx).
// Кидає виняток при мережевій помилці, таймауті (10 с) або не-JSON відповіді.
async function postSigned(url, payload, secret) {
  const bodyString = JSON.stringify({ ...payload, ts: payload && payload.ts != null ? payload.ts : Date.now() });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Signature': sign(secret, bodyString) },
      body: bodyString,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error(`HTTP ${resp.status}: non-JSON response`); }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sign, verify, postSigned, MAX_SKEW_MS };
