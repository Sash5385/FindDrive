// Чисті функції: розбір сторінки OLX, фільтрація, статистика, агрегація.
// Без мережі й Firestore — покриті тестами в lib.test.mjs.
import * as cheerio from 'cheerio';

export const PRICE_MIN = 200;   // грн за заняття: нижче — сміття/помилки
export const PRICE_MAX = 3000;  // вище — курси/пакети, не годинне заняття

// Оголошення не про категорію B (вантажівки, ADR, мото, трактор тощо)
const NON_B = /(\bCE\b|\bC1E?\b|ADR|АДР|код\s*95|тахограф|тракторист|вантажів|мотоцикл|\bмото\b|автобус)/i;

export const normApos = s => String(s || '').replace(/[ʼ’`´]/g, "'").replace(/\s+/g, ' ').trim();

export function parsePrice(text) {
  const t = String(text || '');
  if (!t || /[$€]|USD|EUR/i.test(t)) return null;
  const compact = t.replace(/[\s  ]/g, '');
  const m = compact.match(/(\d+)(?:[.,]\d+)?грн/i);
  if (!m) return null;
  return { value: Number(m[1]), negotiable: /договір|договор/i.test(t) };
}

export function parseLocation(text) {
  const head = normApos(String(text || '').split(' - ')[0]);
  if (!head) return { city: '', district: '' };
  const [city, ...rest] = head.split(',').map(s => s.trim());
  return { city: city || '', district: rest.join(', ') };
}

export function parseListing(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('[data-cy="l-card"]').each((_, el) => {
    const card = $(el);
    const href = card.find('a[href*="/obyavlenie/"]').first().attr('href')
              || card.find('a[href]').first().attr('href') || '';
    const idMatch = href.match(/-ID([A-Za-z0-9]+)\.html/);
    const id = idMatch ? idMatch[1] : (card.attr('id') || '');
    const title = card.find('h4, h6').first().text().trim();
    const priceText = card.find('[data-testid="ad-price"]').first().text().trim();
    const locText = card.find('[data-testid="location-date"]').first().text().trim();
    if (id) out.push({ id, title, priceText, locText });
  });
  return out;
}

// Повертає {id, price, negotiable, district} або null, якщо оголошення не годиться
export function normalizeAd(raw, expectedCity) {
  const price = parsePrice(raw.priceText);
  if (!price) return null;
  if (price.value < PRICE_MIN || price.value > PRICE_MAX) return null;
  if (NON_B.test(raw.title || '')) return null;
  const loc = parseLocation(raw.locText);
  if (normApos(loc.city) !== normApos(expectedCity)) return null; // "схожі" оголошення з інших міст
  return { id: raw.id, price: price.value, negotiable: price.negotiable, district: loc.district };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const r = x => Math.round(x);
  return {
    n: v.length,
    min: v[0],
    p25: r(quantile(v, 0.25)),
    median: r(quantile(v, 0.5)),
    p75: r(quantile(v, 0.75)),
    max: v[v.length - 1],
    avg: r(v.reduce((s, x) => s + x, 0) / v.length)
  };
}

// ads: Map/масив нормалізованих оголошень; auto/manual: Set id з відфільтрованих сторінок
export function aggregateCity(ads, autoIds, manualIds) {
  const list = [...ads];
  const pick = (arr, set) => arr.filter(a => set.has(a.id)).map(a => a.price);
  const res = {
    sample: list.length,
    all: stats(list.map(a => a.price)),
    automatic: stats(pick(list, autoIds)),
    manual: stats(pick(list, manualIds)),
    districts: {}
  };
  const byDistrict = new Map();
  for (const a of list) {
    if (!a.district) continue;
    if (!byDistrict.has(a.district)) byDistrict.set(a.district, []);
    byDistrict.get(a.district).push(a);
  }
  for (const [name, arr] of byDistrict) {
    res.districts[name] = {
      all: stats(arr.map(a => a.price)),
      automatic: stats(pick(arr, autoIds)),
      manual: stats(pick(arr, manualIds))
    };
  }
  return res;
}
