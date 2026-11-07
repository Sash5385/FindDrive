// Підпис і перевірка запитів ID4Drive <-> FindDrive.
// УВАГА: цей файл ідентичний в обох репозиторіях (webid4 і finddrive) — міняти лише синхронно.
//
// Протокол: POST, JSON-тіло з обов'язковим полем ts (Date.now()),
// заголовок X-Sync-Signature = hex(HMAC-SHA256(secret, rawBody)).
// Без залежностей (лише node:crypto і глобальний fetch, Node 20/22).

const crypto = require("crypto");

const SIGNATURE_HEADER = "x-sync-signature";
const MAX_SKEW_MS = 5 * 60 * 1000; // допустиме розходження годинників: 5 хв
const POST_TIMEOUT_MS = 10 * 1000;

// hex HMAC-SHA256 від рядка тіла
function sign(secret, bodyString) {
  return crypto.createHmac("sha256", String(secret)).update(String(bodyString), "utf8").digest("hex");
}

// Заголовок запиту без залежності від регістру (express: req.get / req.headers)
function readHeader(req, name) {
  if (req && typeof req.get === "function") {
    const v = req.get(name);
    if (v) return String(v);
  }
  const h = req && req.headers ? req.headers[name.toLowerCase()] : undefined;
  return Array.isArray(h) ? String(h[0]) : (h ? String(h) : "");
}

// Перевірка вхідного запиту.
// Успіх: { ok: true, body }  (body — розпарсений JSON)
// Відмова: { ok: false, status, reason }
function verify(req, secret) {
  if (!req || req.method !== "POST") return { ok: false, status: 405, reason: "method_not_allowed" };
  if (!secret) return { ok: false, status: 500, reason: "no_secret" };

  const raw = req.rawBody;
  if (raw == null) return { ok: false, status: 400, reason: "no_body" };
  const rawString = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);

  const got = readHeader(req, SIGNATURE_HEADER).trim().toLowerCase();
  if (!got) return { ok: false, status: 401, reason: "no_signature" };

  const expected = sign(secret, rawString);
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual кидає помилку на різній довжині — порівнюємо лише рівні
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: "bad_signature" };
  }

  let body;
  try {
    body = JSON.parse(rawString);
  } catch {
    return { ok: false, status: 400, reason: "bad_json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, reason: "bad_json" };
  }
  if (typeof body.ts !== "number" || !Number.isFinite(body.ts)) {
    return { ok: false, status: 400, reason: "bad_ts" };
  }
  if (Math.abs(Date.now() - body.ts) > MAX_SKEW_MS) {
    return { ok: false, status: 401, reason: "expired" };
  }
  return { ok: true, body };
}

// Підписаний POST. Додає ts, якщо його немає в payload. Повертає розпарсений JSON відповіді;
// мережева помилка / таймаут (10 с) / не-JSON відповідь -> кидає Error.
async function postSigned(url, payload, secret) {
  const body = JSON.stringify({ ...payload, ts: payload && payload.ts != null ? payload.ts : Date.now() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Signature": sign(secret, body) },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`bad_response_${res.status}`);
    }
    if (parsed && typeof parsed === "object" && parsed.ok === undefined && !res.ok) {
      return { ok: false, reason: `http_${res.status}`, status: res.status };
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sign, verify, postSigned, MAX_SKEW_MS };
