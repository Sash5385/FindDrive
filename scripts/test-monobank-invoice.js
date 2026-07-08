#!/usr/bin/env node
// Перевірка активації токенізації monobank acquiring (MONETIZATION.md §5.1).
// Спосіб перевірки — від підтримки monobank: тестовий запит на створення рахунку
// з saveCardData. Якщо відповідь містить invoiceId і pageUrl без помилок — готово.
//
// Запуск (токен НІКОЛИ не передавати як аргумент командного рядка — потрапить
// в history/логи процесів; тільки через змінну середовища):
//   MONOBANK_TOKEN=xxxxx node scripts/test-monobank-invoice.js
//
// Токен береться з web.monobank.ua → monobiznes → FINDDRIVE → Оплата на сайті
// (або "Оплата по підписці") → "Інтеграційний токен". Не публікувати, не комітити.

const token = process.env.MONOBANK_TOKEN;
if (!token) {
  console.error('Помилка: задайте змінну середовища MONOBANK_TOKEN перед запуском.');
  console.error('Приклад: MONOBANK_TOKEN=xxxxx node scripts/test-monobank-invoice.js');
  process.exit(1);
}

const walletId = `test-wallet-${Date.now()}`;

const payload = {
  amount: 100, // 1.00 грн — мінімальна тестова сума
  ccy: 980,
  merchantPaymInfo: {
    reference: `test-${Date.now()}`,
    destination: 'Тестова перевірка токенізації FindDrive',
  },
  validity: 3600, // 1 година — тестовий рахунок не має жити довго
  saveCardData: {
    saveCard: true,
    walletId,
  },
};

async function main() {
  console.log('Надсилаю тестовий запит на POST /api/merchant/invoice/create ...');
  console.log('walletId:', walletId);

  const res = await fetch('https://api.monobank.ua/api/merchant/invoice/create', {
    method: 'POST',
    headers: {
      'X-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`\nHTTP статус: ${res.status}`);
  console.log('Тіло відповіді:', text);

  if (res.status === 200) {
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (json?.invoiceId && json?.pageUrl) {
      console.log('\n✅ Токенізація активна — invoiceId і pageUrl отримано без помилок.');
      console.log('pageUrl (можна відкрити в браузері для перевірки чекауту):', json.pageUrl);
    } else {
      console.log('\n⚠️ HTTP 200, але invoiceId/pageUrl відсутні — перевірте тіло відповіді вище.');
    }
  } else if (res.status === 403) {
    console.log('\n❌ 403 — токен невалідний. Перевірте MONOBANK_TOKEN.');
  } else {
    console.log('\n❌ Токенізація ще не активна, або інша помилка запиту — див. тіло відповіді вище.');
  }
}

main().catch(e => {
  console.error('Помилка запиту:', e.message);
  process.exit(1);
});
