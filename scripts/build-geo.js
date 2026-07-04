#!/usr/bin/env node
/**
 * Генератор гео-лендінгів під міста для SEO.
 * Читає scripts/cities.json → пише /instruktor-<slug>/index.html для кожного міста.
 * Запуск:  node scripts/build-geo.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cities = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf8'));
const BASE = 'https://finddrive.in.ua';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const steps = [
  ['Вкажіть район', 'Натисніть «Моє місце» або оберіть свій район — покажемо інструкторів поблизу'],
  ['Оберіть інструктора', 'Порівняйте за рейтингом, ціною, відгуками та типом КПП'],
  ['Забронюйте час', 'Онлайн-запис на вільний слот або домовтеся по телефону'],
  ['Їдьте на урок', 'Зустріньтесь з інструктором і після заняття залиште відгук'],
];

function cityFaq(c) {
  return [
    [`Скільки коштує інструктор з водіння ${c.prep} ${c.loc}?`,
     `Ціну за годину встановлює сам інструктор — вона вказана в його профілі. Оплата відбувається напряму інструктору; FindDrive за пошук та запис із учнів плати не бере.`],
    [`Як знайти інструктора з водіння поряд ${c.prep} ${c.loc}?`,
     `Натисніть «Моє місце» — сайт визначить вашу геолокацію і покаже інструкторів ${c.prep} ${c.loc} поряд. Також можна ввести район вручну (${c.districts.slice(0,3).join(', ')} тощо).`],
    [`Чи є інструктори на автоматі та механіці ${c.prep} ${c.loc}?`,
     `Так. У фільтрах можна обрати тип КПП — «Автомат» або «Механіка» — і побачити лише підходящих інструкторів ${c.prep} ${c.loc}.`],
    [`Інструктори знають маршрути ТСЦ ${c.gen}?`,
     `Багато інструкторів вказують у профілі ТСЦ, чиї маршрути вони знають (${c.tsc.join(', ')}). Це допомагає підготуватися саме до вашого іспиту.`],
  ];
}

function page(c, all) {
  const url = `${BASE}/instruktor-${c.slug}/`;
  const title = `Інструктор з водіння ${c.prep} ${c.loc} — знайти на карті | FindDrive`;
  const desc = `Знайти інструктора з водіння ${c.prep} ${c.loc}: райони ${c.districts.slice(0,4).join(', ')} та інші. Порівняй за ціною, рейтингом і районом, запишись онлайн. Безкоштовно для учнів.`;
  const faq = cityFaq(c);

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Головна', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: `Інструктор з водіння ${c.prep} ${c.loc}`, item: url },
      ]},
      { '@type': 'Service', serviceType: `Пошук інструкторів з водіння ${c.prep} ${c.loc}`,
        areaServed: { '@type': 'City', name: c.name },
        provider: { '@type': 'Organization', name: 'FindDrive', url: BASE + '/' },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'UAH', description: 'Пошук і запис до інструктора — безкоштовно для учнів' } },
      { '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({
        '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
  };

  const citiesNav = all.map(x => x.slug === c.slug
    ? `<a class="cur" href="/instruktor-${x.slug}/">${esc(x.name)}</a>`
    : `<a href="/instruktor-${x.slug}/">${esc(x.name)}</a>`).join('');

  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="FindDrive">
<meta property="og:locale" content="uk_UA">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${BASE}/og-image.png">
<link rel="icon" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/geo.css">
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>
<nav class="geo-nav"><div class="wrap">
  <a href="/" style="display:flex;align-items:center;gap:10px"><img src="/logo192.png" alt="FindDrive"><span class="brand">FindDrive</span></a>
  <a class="home" href="/">На головну →</a>
</div></nav>

<div class="wrap">
  <div class="crumbs"><a href="/">Головна</a> › Інструктор з водіння ${c.prep} ${esc(c.loc)}</div>

  <header class="hero">
    <h1>Інструктор з водіння <span>${c.prep} ${esc(c.loc)}</span></h1>
    <p class="lead">Знайдіть інструктора з водіння ${c.prep} ${esc(c.loc)} поряд із вами — на карті, за районом, ціною та рейтингом. Онлайн-запис за 2 хвилини, безкоштовно для учнів.</p>
    <a class="cta" href="/?city=${encodeURIComponent(c.name)}">Знайти інструктора ${c.prep} ${esc(c.loc)} →</a>
  </header>

  <section>
    <h2>Райони ${esc(c.gen)}</h2>
    <p>Оберіть інструктора у своєму районі — учні доїжджають до інструктора самі, тож локація важлива.</p>
    <div class="chips">${c.districts.map(d => `<span class="chip">${esc(d)}</span>`).join('')}</div>
  </section>

  <section>
    <h2>ТСЦ ${c.prep} ${esc(c.loc)} та області</h2>
    <p>Інструктори вказують у профілі, маршрути яких ТСЦ вони знають — це допомагає підготуватися до практичного іспиту:</p>
    <ul class="tsc-list">${c.tsc.map(t => `<li>ТСЦ МВС ${esc(t)} — ${esc(c.name)}</li>`).join('')}</ul>
  </section>

  <section>
    <h2>Як це працює</h2>
    <div class="steps">${steps.map(([b, s]) => `<div class="step"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')}</div>
  </section>

  <section class="faq">
    <h2>Часті запитання — інструктор з водіння ${c.prep} ${esc(c.loc)}</h2>
    ${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><div class="a">${esc(a)}</div></details>`).join('\n    ')}
  </section>

  <section>
    <h2>Інструктори з водіння в інших містах</h2>
    <div class="cities">${citiesNav}</div>
  </section>

  <section style="text-align:center;padding:24px 0 8px">
    <a class="cta" href="/?city=${encodeURIComponent(c.name)}">Переглянути інструкторів ${c.prep} ${esc(c.loc)} на карті →</a>
  </section>
</div>

<footer><div class="wrap">
  <span class="foot-copy">© 2025 FindDrive — маркетплейс інструкторів з водіння по всій Україні.</span>
  <a href="/">finddrive.in.ua</a>
</div></footer>
</body>
</html>
`;
}

let count = 0;
for (const c of cities) {
  const dir = path.join(ROOT, `instruktor-${c.slug}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page(c, cities));
  count++;
  console.log(`  ✓ /instruktor-${c.slug}/`);
}
console.log(`Готово: ${count} сторінок.`);
