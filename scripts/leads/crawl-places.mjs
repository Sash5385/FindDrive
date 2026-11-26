#!/usr/bin/env node
/**
 * Краулер лідів: інструктори з водіння та автошколи з Google Places API (New).
 * Читає scripts/cities.json → шукає по містах і районах → пише CSV + JSON у scripts/leads/out/.
 *
 * Запуск:
 *   GOOGLE_PLACES_KEY=... node scripts/leads/crawl-places.mjs            # усі міста
 *   GOOGLE_PLACES_KEY=... node scripts/leads/crawl-places.mjs --city kyiv
 *   ... --no-districts   (лише загальні запити по місту — дешевше)
 *   ... --known scripts/leads/out/leads.json   (пропустити вже відомі ліди)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'out');
const cities = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'cities.json'), 'utf8'));

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const KEY = process.env.GOOGLE_PLACES_KEY;
if (!KEY) { console.error('Немає GOOGLE_PLACES_KEY'); process.exit(1); }
const ONLY = arg('--city');
const NO_DISTRICTS = args.includes('--no-districts');
const KNOWN_FILE = arg('--known');

const BASE_QUERIES = ['інструктор з водіння', 'автоінструктор', 'автошкола'];
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.websiteUri',
  'places.rating', 'places.userRatingCount', 'places.googleMapsUri', 'places.businessStatus',
  'nextPageToken',
].join(',');

const SCHOOL_RE = /авто\s*школ|автошкол|школ[аи]\s*водін|driving\s*school|навчальн|ТСОУ|ДТСААФ|академі|центр/i;
const IRRELEVANT_RE = /СТО|шиномонтаж|автомийк|автосалон|запчаст|страхув|евакуатор|таксі/i;

// Текст першого повідомлення (оффер)
const OFFER = (name, city, ref) =>
  `Вітаю${name ? ', ' + name : ''}! Бачу вас на Google Maps як інструктора з водіння ${city.prep} ${city.loc}. ` +
  `Запрошуємо: безкоштовний профіль на FindDrive — учні знаходять вас на карті поряд, ` +
  `+ DrivePad (онлайн-запис і календар) — перший місяць безкоштовно. ` +
  `Детальніше: https://finddrive.in.ua/?ref=${ref}\n` +
  `Якщо не цікаво — напишіть «ні», більше не турбуватимемо.`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function searchText(textQuery, city, pageToken) {
  const body = {
    textQuery, languageCode: 'uk', regionCode: 'UA', pageSize: 20,
    locationBias: { circle: { center: { latitude: city.lat, longitude: city.lng }, radius: 30000 } },
  };
  if (pageToken) body.pageToken = pageToken;
  for (let attempt = 0; attempt < 3; attempt++) {
    requests++;
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    throw new Error(`Places API ${res.status}: ${txt.slice(0, 300)}`);
  }
  throw new Error('Places API: забагато повторів');
}

// Нормалізація телефону до +380XXXXXXXXX
function normPhone(p) {
  if (!p) return '';
  let d = String(p).replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 10) d = '38' + d;
  if (d.length === 12 && d.startsWith('380')) return '+' + d;
  return d ? '+' + d : '';
}

const isMobile = (p) => /^\+380(39|50|63|66|67|68|73|91|92|93|94|95|96|97|98|99)\d{7}$/.test(p);
const refId = (placeId) => crypto.createHash('sha1').update(placeId).digest('base64url').slice(0, 8);

function score(l) {
  let s = 0;
  if (l.phone) s += 30;
  if (l.mobile) s += 20;                 // мобільний = можна в Viber/Telegram
  if (l.type === 'instructor') s += 20;  // приватник — основна ЦА
  if (!l.website) s += 10;               // без сайту — більше потребує онлайн-запису
  if (l.reviews >= 5) s += 10;
  if (l.rating >= 4.5) s += 10;
  return s;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  const known = new Set();
  if (KNOWN_FILE && fs.existsSync(KNOWN_FILE)) {
    for (const l of JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'))) { known.add(l.placeId); if (l.phone) known.add(l.phone); }
  }
  const leads = new Map();
  const phones = new Set();
  const list = cities.filter(c => !ONLY || c.slug === ONLY);
  if (!list.length) throw new Error(`Місто "${ONLY}" не знайдено в cities.json`);

  for (const city of list) {
    const queries = BASE_QUERIES.map(q => `${q} ${city.name}`);
    if (!NO_DISTRICTS) for (const d of city.districts) queries.push(`інструктор з водіння ${d} ${city.name}`);
    let found = 0;
    for (const q of queries) {
      let token;
      for (let page = 0; page < 3; page++) {
        const data = await searchText(q, city, token);
        for (const p of data.places || []) {
          if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
          const name = p.displayName?.text || '';
          if (IRRELEVANT_RE.test(name)) continue;
          const phone = normPhone(p.internationalPhoneNumber || p.nationalPhoneNumber);
          if (leads.has(p.id) || known.has(p.id) || (phone && (phones.has(phone) || known.has(phone)))) continue;
          const ref = refId(p.id);
          const l = {
            id: ref, placeId: p.id, city: city.slug, name,
            type: SCHOOL_RE.test(name) ? 'school' : 'instructor',
            phone, mobile: isMobile(phone),
            website: p.websiteUri || '', address: p.formattedAddress || '',
            lat: p.location?.latitude ?? null, lng: p.location?.longitude ?? null,
            rating: p.rating ?? null, reviews: p.userRatingCount ?? 0,
            maps: p.googleMapsUri || '', query: q, foundAt: new Date().toISOString(),
            status: 'new',
          };
          l.score = score(l);
          l.message = OFFER(l.type === 'instructor' ? name.split(/\s+/)[0] : '', city, ref);
          leads.set(p.id, l);
          if (phone) phones.add(phone);
          found++;
        }
        token = data.nextPageToken;
        if (!token) break;
      }
    }
    console.log(`${city.name}: +${found} (запитів усього: ${requests})`);
  }

  const rows = [...leads.values()].sort((a, b) => b.score - a.score);
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(OUT, `leads-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2));

  const cols = ['score', 'type', 'city', 'name', 'phone', 'mobile', 'rating', 'reviews', 'website', 'address', 'maps', 'viber', 'whatsapp', 'telegram', 'message', 'id', 'placeId'];
  const lines = [cols.join(',')];
  for (const l of rows) {
    const msg = encodeURIComponent(l.message);
    const num = l.phone.replace('+', '');
    const ext = {
      viber: l.mobile ? `viber://chat?number=%2B${num}` : '',
      whatsapp: l.mobile ? `https://wa.me/${num}?text=${msg}` : '',
      telegram: l.mobile ? `https://t.me/+${num}` : '',
    };
    lines.push(cols.map(c => csvCell(c in ext ? ext[c] : l[c])).join(','));
  }
  const csvPath = path.join(OUT, `leads-${stamp}.csv`);
  fs.writeFileSync(csvPath, '﻿' + lines.join('\n')); // BOM — щоб Excel коректно відкрив кирилицю

  const inst = rows.filter(r => r.type === 'instructor').length;
  console.log(`\nГотово: ${rows.length} лідів (приватних інструкторів: ${inst}, шкіл: ${rows.length - inst}, з мобільним: ${rows.filter(r => r.mobile).length})`);
  console.log(`Запитів до API: ${requests}`);
  console.log(`CSV:  ${csvPath}\nJSON: ${jsonPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
