import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, parseLocation, parseListing, normalizeAd, stats, aggregateCity } from './lib.mjs';

const card = (id, title, price, loc) => `
  <div data-cy="l-card" id="${id}">
    <a href="/d/uk/obyavlenie/some-title-ID${id}.html?search_reason=search%7Corganic"><img alt=""></a>
    <div data-cy="ad-card-title"><a href="/d/uk/obyavlenie/some-title-ID${id}.html"><h4>${title}</h4></a>
      ${price ? `<p data-testid="ad-price">${price}</p>` : ''}</div>
    <p data-testid="location-date">${loc}</p>
  </div>`;

test('parsePrice', () => {
  assert.deepEqual(parsePrice('1 200 грн.'), { value: 1200, negotiable: false });
  assert.deepEqual(parsePrice('800 грн.Договірна'), { value: 800, negotiable: true });
  assert.equal(parsePrice('Безкоштовно'), null);
  assert.equal(parsePrice('25 $'), null);
  assert.equal(parsePrice(''), null);
});

test('parseLocation', () => {
  assert.deepEqual(parseLocation('Київ, Деснянський - Сьогодні о 13:54'), { city: 'Київ', district: 'Деснянський' });
  assert.deepEqual(parseLocation('Полтава - 24 листопада 2026 р.'), { city: 'Полтава', district: '' });
  assert.deepEqual(parseLocation('Київ, Солом’янський - Сьогодні'), { city: 'Київ', district: "Солом'янський" });
});

test('parseListing + normalizeAd', () => {
  const html = card('AAA1', 'Автоінструктор, автомат', '1 000 грн.', 'Київ, Дарницький - Сьогодні о 11:58')
    + card('AAA2', 'Навчання на кат. СE, АДР', '1 500 грн.', 'Київ, Подільський - Сьогодні')
    + card('AAA3', 'Інструктор', null, 'Київ, Оболонський - Сьогодні')
    + card('AAA4', 'Інструктор Бровари', '900 грн.', 'Бровари - Сьогодні')
    + card('AAA5', 'Курс під ключ', '15 000 грн.', 'Київ, Печерський - Сьогодні');
  const raw = parseListing(html);
  assert.equal(raw.length, 5);
  assert.equal(raw[0].id, 'AAA1');
  const ok = raw.map(r => normalizeAd(r, 'Київ')).filter(Boolean);
  assert.deepEqual(ok, [{ id: 'AAA1', price: 1000, negotiable: false, district: 'Дарницький' }]);
});

test('stats', () => {
  assert.equal(stats([]), null);
  assert.deepEqual(stats([700, 1000, 1000, 1200]), { n: 4, min: 700, p25: 925, median: 1000, p75: 1050, max: 1200, avg: 975 });
});

test('aggregateCity', () => {
  const ads = [
    { id: 'a', price: 800, district: 'Сихівський' },
    { id: 'b', price: 900, district: 'Сихівський' },
    { id: 'c', price: 1000, district: 'Галицький' },
    { id: 'd', price: 700, district: '' }
  ];
  const agg = aggregateCity(ads, new Set(['a', 'c']), new Set(['b']));
  assert.equal(agg.sample, 4);
  assert.equal(agg.all.median, 850);
  assert.equal(agg.automatic.n, 2);
  assert.equal(agg.manual.median, 900);
  assert.equal(agg.districts['Сихівський'].all.n, 2);
  assert.equal(agg.districts['Сихівський'].automatic.median, 800);
  assert.equal(agg.districts['Галицький'].manual, null);
  assert.equal(Object.keys(agg.districts).length, 2);
});
