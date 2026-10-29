# Google Play: листинг и Data safety

## Украинский (основной)

**Название (≤30):** FindDrive — інструктор з водіння
**Краткое описание (≤80):** Знайдіть інструктора з водіння поруч із вами та запишіться онлайн

**Полное описание:**
FindDrive — сервіс пошуку інструкторів з водіння за геолокацією. Знаходьте інструктора поруч, порівнюйте за містом, ціною та рейтингом і записуйтесь на заняття онлайн за пару хвилин.

Для учнів:
• Інструктори на карті — бачте, хто працює поруч із вами
• Профіль інструктора: фото, ціна, стаж, район, тип КПП, точки зустрічі, ТСЦ, відгуки
• Вільні дати й час — оберіть зручний слот і запишіться
• Дошка оголошень: «Шукаю» і «Пропоную» заняття
• Чат з інструктором і сповіщення про записи
• Обрані інструктори

Для інструкторів:
• Власна анкета з фото, цінами та районом роботи
• Календар і відкриті слоти для запису
• Учні знаходять вас за локацією — вони доїжджають до вас самі

Працює в Києві, Харкові, Дніпрі, Одесі, Львові, Запоріжжі та інших містах України.

Питання та підтримка: Sash5385@gmail.com

## English

**Title (≤30):** FindDrive — Driving Instructor
**Short (≤80):** Find a driving instructor near you on the map and book a lesson online

**Full:**
FindDrive helps you find a driving instructor by location. See instructors near you on the map, compare by city, price and rating, and book a lesson online in minutes.

For learners:
• Instructors on the map — see who works near you
• Instructor profile: photo, price, experience, district, transmission, meeting points, reviews
• Open dates and time slots — pick one and book
• Bulletin board: "Looking for" and "Offering" lessons
• Chat with instructors and booking notifications
• Favourites

For instructors:
• Your own profile with photo, prices and working area
• Calendar and open booking slots
• Learners find you by location

Available in Kyiv, Kharkiv, Dnipro, Odesa, Lviv, Zaporizhzhia and other cities of Ukraine.

Support: Sash5385@gmail.com

## Параметры приложения
- Категория: Education (альтернатива: Maps & Navigation). Теги: Education, Auto & Vehicles
- Контакт: Sash5385@gmail.com, сайт https://finddrive.in.ua
- Политика: https://finddrive.in.ua/privacy.html
- Реклама: нет. Платные функции: нет (пока). Целевая аудитория: 18+
- Content rating (анкета IARC): насилия, азартных игр, контента для взрослых нет; есть пользовательский контент (чат, отзывы, объявления) и обмен локацией. Ожидаемо: 3+/Everyone с пометкой UGC
- Доступ к приложению для ревью: дайте тестовый аккаунт (email+пароль), если вход обязателен для записи/чата

## Data safety (ответы по текущему коду, проверьте перед отправкой)
Данные шифруются при передаче (HTTPS): **Да**. Запрос удаления данных: **Да**, https://finddrive.in.ua/privacy.html#delete + email.

| Тип данных | Собирается | Передаётся | Цель | Обязательно |
|---|---|---|---|---|
| Местоположение (точное) | Да | **Да** — OpenStreetMap Nominatim (reverse-геокодинг) | Функциональность | Нет (можно вручную) |
| Имя | Да | Нет | Функциональность, управление аккаунтом | Да |
| Email | Да | Нет | Управление аккаунтом, связь | Да |
| Телефон | Да | Нет | Функциональность (связь учня и инструктора) | Нет |
| Фото | Да (инструкторы) | Нет | Функциональность | Нет |
| Сообщения в чате/отзывы | Да | Нет | Функциональность | Нет |
| User ID / Device ID (FCM-токен) | Да | Нет | Функциональность (push) | Нет |
| Взаимодействие с приложением, диагностика | Да | Нет | Аналитика (Google Analytics) | Да |

Проверено по коду: координаты кнопки «Моє місце» уходят в Nominatim; выбранные вручную точки (точка инструктора, объявление) сохраняются в Firestore. Поэтому «Местоположение» = собирается и передаётся. Политика обновлена.
Firebase/Google Analytics — сервис-провайдеры: передачей третьим лицам в смысле Play не считаются, если обрабатывают данные от вашего имени.
