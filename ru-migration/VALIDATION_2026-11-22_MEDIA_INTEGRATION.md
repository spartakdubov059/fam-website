# Проверка RU media upload в disposable YDB — 22 ноября 2026

На commit [`fb722a3`](https://github.com/spartakdubov059/fam-website/commit/fb722a37057883bde328b62b9da84b083c49e87c) расширен `compat/integration-ydb.mjs`: synthetic bearer identity проходит через database actor resolver, тестовая PNG обрабатывается Sharp, S3-совместимый adapter сохраняет WebP только в памяти, YDB регистрирует pending media и связывает его с объявлением.

- Первый запуск [YDB CI #44964711785](https://github.com/spartakdubov059/fam-website/actions/runs/44964711785) поднял disposable YDB и применил схему, но тест не стартовал: backend-модули не находили AWS SDK, установленный в `ru-migration/compat/node_modules`.
- На commit [`de04c86`](https://github.com/spartakdubov059/fam-website/commit/de04c86bc69780be77b8aba4b12f7805216838c4) workflow связал backend с тем же закреплённым набором SDK зависимостей. Повторный [YDB CI #44964876097](https://github.com/spartakdubov059/fam-website/actions/runs/44964876097) завершился успешно: установка SDK, disposable DB, схема, полный синтетический integration script и очистка контейнера прошли.
- Локально до запуска YDB CI прошли синтаксическая проверка integration script, `compat/verify.mjs` и **439/439** backend tests.
- Хранилище S3 в новом media-сценарии подменено in-memory adapter; проверены WebP байты и YDB статусы `pending` → `linked`. Реальный Yandex Object Storage, Yandex Cloud IAM/OAuth и пользовательские данные не использовались.

Это подтверждает одноразовую интеграцию кода с disposable YDB и fake storage, но не является облачным staging, проверкой стоимости `0 ₽`, полным security sign-off или подтверждением паритета всего приложения. Расписания остаются выключенными; `main` и production не менялись.
