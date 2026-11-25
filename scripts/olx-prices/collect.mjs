#!/usr/bin/env node
// Збір агрегованих цін автоінструкторів з публічних сторінок категорії OLX
// "Автоінструктори" → Firestore marketPrices/{citySlug}.
//
// Що зберігається: лише агрегати (кількість, мін, квартилі, медіана, макс) по місту,
// району і типу КПП. Назви, імена, телефони, посилання оголошень НЕ зберігаються.
// Етикет: перевірка robots.txt перед кожним URL, 1 запит на 4–7 с, чесний User-Agent.
//
// Запуск:
//   node collect.mjs                 — збір + запис у Firestore (потрібен FIREBASE_SERVICE_ACCOUNT)
//   node collect.mjs --dry-run       — без запису, результат у out/market-prices.json
//   node collect.mjs --cities=kyiv,lviv --max-pages=3
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import robotsParser from 'robots-parser';
import { parseListing, normalizeAd, aggregateCity } from './lib.mjs';
import { CITIES } from './cities.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const ORIGIN = 'https://www.olx.ua';
const UA = 'Mozilla/5.0 (compatible; FindDriveMarketBot/1.0; +https://finddrive.in.ua)';
const VARIANTS = ['all', 'automatic', 'manual'];

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const DRY = !!args['dry-run'] || process.env.DRY_RUN === '1';
const MAX_PAGES = Number(args['max-pages'] || process.env.MAX_PAGES || 10);
const ONLY = String(args.cities || process.env.CITIES || '').split(',').map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const politeDelay = () => sleep(4000 + Math.random() * 3000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function buildUrl(olxSlug, variant, page, withPriceFilter) {
  const u = new URL(`/uk/uslugi/obrazovanie/avtoinstruktory/${olxSlug}/`, ORIGIN);
  if (withPriceFilter) u.searchParams.set('search[filter_float_price:from]', '1');
  if (variant !== 'all') u.searchParams.set('search[filter_enum_gearbox_type][0]', variant);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'uk-UA,uk;q=0.9' },
        signal: AbortSignal.timeout(25000)
      });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) return { status: res.status, text: '' };
      return { status: res.status, text: await res.text() };
    } catch (e) {
      log(`  retry ${attempt}/3 ${url}: ${e.message}`);
      await sleep(10000 * attempt);
    }
  }
  return { status: 0, text: '' };
}

async function loadRobots() {
  const url = ORIGIN + '/robots.txt';
  const { status, text } = await fetchText(url);
  if (status !== 200) throw new Error(`robots.txt недоступний (HTTP ${status}) — збір зупинено`);
  return robotsParser(url, text);
}

async function collectCity(slug, cfg, robots, debug) {
  const ads = new Map();
  const sets = { automatic: new Set(), manual: new Set() };
  let requests = 0, skipped = 0, cards = 0;

  for (const variant of VARIANTS) {
    const seenCards = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      // Спершу URL з фільтром "лише з ціною"; якщо robots.txt його забороняє — без фільтра
      let url = buildUrl(cfg.olxSlug, variant, page, true);
      if (!robots.isAllowed(url, UA)) url = buildUrl(cfg.olxSlug, variant, page, false);
      if (!robots.isAllowed(url, UA)) { skipped++; log(`  robots.txt забороняє: ${url}`); break; }

      if (requests++) await politeDelay();
      const { status, text } = await fetchText(url);
      if (status !== 200) { log(`  ${variant} p${page}: HTTP ${status}`); break; }

      const raw = parseListing(text);
      cards += raw.length;
      if (!raw.length) {
        if (page === 1 && variant === 'all') debug.push({ slug, url, html: text });
        break;
      }
      let freshCards = 0, priced = 0;
      for (const r of raw) {
        if (!seenCards.has(r.id)) { seenCards.add(r.id); freshCards++; }
        const ad = normalizeAd(r, cfg.olxName);
        if (!ad) continue;
        priced++;
        if (variant !== 'all') sets[variant].add(ad.id);
        if (!ads.has(ad.id)) ads.set(ad.id, ad);
      }
      log(`  ${variant} p${page}: карток ${raw.length}, нових ${freshCards}, з ціною ${priced}`);
      // Сторінки скінчились: OLX повторює останню сторінку замість порожньої
      if (!freshCards) break;
    }
  }
  return { ads: ads.values(), sets, requests, skipped, cards };
}

async function writeFirestore(docs, meta) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Немає секрету FIREBASE_SERVICE_ACCOUNT — додайте його в GitHub → Settings → Secrets and variables → Actions або запустіть з --dry-run');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore();
  const batch = db.batch();
  const date = new Date().toISOString().slice(0, 10);
  for (const [slug, data] of Object.entries(docs)) {
    batch.set(db.doc(`marketPrices/${slug}`), { ...data, updatedAt: FieldValue.serverTimestamp() });
    batch.set(db.doc(`marketPricesHistory/${date}_${slug}`), {
      date, slug, city: data.city, sample: data.sample,
      all: data.all, automatic: data.automatic, manual: data.manual
    });
  }
  batch.set(db.doc('marketPrices/_meta'), { ...meta, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
}

async function main() {
  const geo = JSON.parse(await readFile(path.join(HERE, '..', 'cities.json'), 'utf8'));
  const geoBySlug = Object.fromEntries(geo.map(c => [c.slug, c]));
  const slugs = Object.keys(CITIES).filter(s => !ONLY.length || ONLY.includes(s));
  log(`Міста: ${slugs.join(', ')} · max ${MAX_PAGES} стор. · ${DRY ? 'DRY-RUN' : 'запис у Firestore'}`);

  const robots = await loadRobots();
  const docs = {}, debug = [], report = [];
  for (const slug of slugs) {
    const cfg = CITIES[slug];
    log(`${cfg.olxName}…`);
    const res = await collectCity(slug, cfg, robots, debug);
    const agg = aggregateCity(res.ads, res.sets.automatic, res.sets.manual);
    report.push({ slug, sample: agg.sample, requests: res.requests, cards: res.cards, skipped: res.skipped });
    if (!agg.sample) { log(`  ${cfg.olxName}: 0 оголошень з ціною — документ не оновлюю`); continue; }
    const g = geoBySlug[slug] || {};
    docs[slug] = {
      slug, city: cfg.olxName, source: 'olx', lat: g.lat ?? null, lng: g.lng ?? null,
      aliases: cfg.aliases, minSample: 3, ...agg
    };
    log(`  ${cfg.olxName}: ${agg.sample} огол., медіана ${agg.all.median} грн`);
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'market-prices.json'), JSON.stringify({ report, docs }, null, 2));
  for (const d of debug) await writeFile(path.join(OUT, `debug-${d.slug}.html`), d.html);

  const ok = Object.keys(docs);
  if (!ok.length) {
    console.error('Жодне місто не дало даних. Ймовірно, OLX змінив розмітку або блокує запити — див. out/debug-*.html');
    process.exit(1);
  }
  const meta = {
    source: 'olx', cities: ok, failed: slugs.filter(s => !ok.includes(s)),
    totalAds: ok.reduce((s, k) => s + docs[k].sample, 0),
    runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
  };
  if (DRY) { log('DRY-RUN: у Firestore нічого не записано, див. out/market-prices.json'); return; }
  await writeFirestore(docs, meta);
  log(`Записано: ${ok.join(', ')} (${meta.totalAds} огол.)${meta.failed.length ? ' · без даних: ' + meta.failed.join(', ') : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
