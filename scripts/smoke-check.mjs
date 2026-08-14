// Легкий smoke-тест: відкриває index.html і admin.html у headless-браузері
// (Playwright + Chromium) і перевіряє, що сторінка реально рендериться без
// JS-помилок і ключові елементи/кнопки працюють. Ловить runtime-баги, які
// `node --check` (чиста перевірка синтаксису) не бачить — наприклад, клік
// по кнопці, що не знаходить свою панель через відсутній атрибут.
//
// Запуск:  node scripts/smoke-check.mjs
// Виходить з кодом 1, якщо щось не пройшло — зручно для CI (.github/workflows).

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const GOTO_TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS || 30000);

// Деякі середовища (напр. пісочниця Claude Code) мають Chromium заздалегідь
// встановлений за фіксованим шляхом замість того, що чекає локальна версія
// Playwright — використовуємо його, якщо він є, інакше стандартна поведінка
// (CI виконує `npx playwright install chromium` окремим кроком).
const PRESET_CHROMIUM = '/opt/pw-browsers/chromium';
const launchOpts = fs.existsSync(PRESET_CHROMIUM) ? { executablePath: PRESET_CHROMIUM } : {};

const PAGES = {
  'index.html': {
    elements: [
      '.nav', '#instr-grid', '#schools', '#school-grid',
      '#instr-panel', '#instr-welcome', '#school-panel', '#school-welcome',
      '#cabinet', '#instr-profile', '#school-profile', '.nav-role-btn',
    ],
    interactions: [
      { name: 'клік "Я інструктор" відкриває instr-welcome', click: 'a.nav-role-btn:has-text("Я інструктор")', expect: '#instr-welcome.open' },
      { name: 'клік "Я автошкола" відкриває school-welcome',  click: 'a.nav-role-btn:has-text("Я автошкола")',  expect: '#school-welcome.open' },
      { name: 'кнопка "Увійти" відкриває auth-modal', click: '#btn-login', expect: '#auth-modal[style*="flex"]' },
      { name: 'футер "Знайти інструктора" → інфо-модалка',      click: 'a[onclick*="_openInfoModal(\'find\')"]',        expect: '#info-modal[style*="flex"]' },
      { name: 'футер "Як це працює" → інфо-модалка',            click: 'a[onclick*="_openInfoModal(\'howto\')"]',       expect: '#info-modal[style*="flex"]' },
      { name: 'футер "Карта" → інфо-модалка',                   click: 'a[onclick*="_openInfoModal(\'map\')"]',         expect: '#info-modal[style*="flex"]' },
      { name: 'футер "Про нас" → інфо-модалка',                 click: 'a[onclick*="_openInfoModal(\'about\')"]',       expect: '#info-modal[style*="flex"]' },
      { name: 'футер "Контакти" → інфо-модалка',                click: 'a[onclick*="_openInfoModal(\'contacts\')"]',    expect: '#info-modal[style*="flex"]' },
      { name: 'футер "Конфіденційність" → інфо-модалка',        click: 'a[onclick*="_openInfoModal(\'privacy\')"]',     expect: '#info-modal[style*="flex"]' },
      { name: 'футер "Умови партнерства" → інфо-модалка',       click: 'a[onclick*="_openInfoModal(\'partnership\')"]', expect: '#info-modal[style*="flex"]' },
      { name: 'футер "Умови" → інфо-модалка',                   click: 'a[onclick*="_openInfoModal(\'terms\')"]',       expect: '#info-modal[style*="flex"]' },
      { name: 'картка інструктора "Записатись" → instr-profile', click: '.instr-card .btn-book', expect: '#instr-profile.open', optional: true },
      { name: 'картка школи → school-profile', click: '.school-card', expect: '#school-profile.open', optional: true },
    ],
  },
  'admin.html': {
    elements: ['#auth-gate', '#btn-google-login'],
    interactions: [],
  },
};

async function checkPage(browser, file, cfg) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  let failed = false;
  console.log(`\n=== ${file} ===`);
  try {
    // domcontentloaded (не 'load') — чекає виконання наших модульних скриптів,
    // але не залежить від повільних сторонніх ресурсів (GTM, шрифти, тайли карти)
    await page.goto('file://' + path.join(root, file), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
    await page.waitForTimeout(1200); // дати доасинхронному init (Firebase/onSnapshot) відпрацювати

    for (const sel of cfg.elements) {
      const count = await page.locator(sel).count();
      if (count === 0) { console.error(`  ✗ елемент не знайдено: ${sel}`); failed = true; }
      else console.log(`  ✓ ${sel}`);
    }

    for (const step of cfg.interactions) {
      try {
        // Закриваємо будь-яку відкриту панель/модалку/оверлей від попереднього
        // кроку — інакше вона перекриває наступну кнопку і клік підвисає.
        await page.evaluate(() => {
          window.closeAll && window.closeAll();
          window._closeInfoModal && window._closeInfoModal();
          window._closeAuthModal && window._closeAuthModal();
        });
        await page.waitForTimeout(200);

        if (step.optional && await page.locator(step.click).count() === 0) {
          console.log(`  · ${step.name} — пропущено (елемента немає в даних цього прогону)`);
          continue;
        }

        await page.locator(step.click).first().click({ timeout: 5000 });
        await page.waitForTimeout(400);
        const ok = await page.locator(step.expect).count();
        if (ok > 0) console.log(`  ✓ ${step.name}`);
        else { console.error(`  ✗ ${step.name} — умова не виконалась (${step.expect})`); failed = true; }
      } catch (e) {
        console.error(`  ✗ ${step.name} — ${e.message.split('\n')[0]}`);
        failed = true;
      }
    }

    if (errors.length) {
      console.error(`  ✗ JS-помилки під час завантаження (${errors.length}):`);
      errors.slice(0, 10).forEach(e => console.error(`      ${e}`));
      failed = true;
    } else {
      console.log('  ✓ без JS-помилок');
    }
  } catch (e) {
    console.error(`  ✗ не вдалось завантажити сторінку: ${e.message.split('\n')[0]}`);
    failed = true;
  } finally {
    await page.close();
  }
  return failed;
}

async function run() {
  const browser = await chromium.launch(launchOpts);
  let anyFailed = false;
  for (const [file, cfg] of Object.entries(PAGES)) {
    const failed = await checkPage(browser, file, cfg);
    anyFailed = anyFailed || failed;
  }
  await browser.close();

  console.log(anyFailed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST OK');
  process.exit(anyFailed ? 1 : 0);
}

run();
