# Сверка FAM source → RU на 20 ноября 2026

## Проверенные ревизии

- Исходный FAM: [`main` `5e749c56b9270efbfdf1f48cefe6e8d95a01c579`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579).
- Российская копия: [`migration/yandex-cloud` `f23d42b4fa14dd2add9dc899177739e7589ce838`](https://github.com/spartakdubov059/fam-website/commit/f23d42b4fa14dd2add9dc899177739e7589ce838).
- В актуальном `main` 78 SQL migration-файлов и 7 Edge Functions; число проверено через GitHub API. Предыдущий source snapshot `7fd418246653f92b53f66bc29fa224d95d04d5cf` содержал 76 migrations.

## Дельта исходника `main` 20 ноября 2026

Новый upstream commit [`5e749c5`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579) расширил опросы с 2–4 до 2–8 вариантов, ограничил индекс голоса диапазоном 0–7 и добавил миграцию Postgres. В RU-копии этот сценарий синхронизирован в `f23d42b`: UI создаёт и показывает до восьми вариантов, API принимает только индексы 0–7, YDB репозиторий проверяет индекс относительно числа ответов конкретного опроса, синтетический YDB интеграционный сценарий создаёт восьмивариантный опрос и голосует за индекс 7. На RU-ревизии локально прошли `311/311` тестов; [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508222) и [одноразовая YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508156) прошли.

Остальные изменения upstream коммита:

- `school-pulse.js` сохраняет текущую hero-карточку после обновления ленты и оставляет карусель доступной при отказе загрузки. Российская оболочка использует отдельный список school-pulse и не имеет этой карусели; визуального аналога, который можно синхронизировать отдельно, в текущем RU UI нет.
- `index.html` теперь перенаправляет обычные GitHub Pages визиты на Netlify даже при сохранённой локальной Supabase-сессии, сохраняя на Pages только URL auth callbacks. Это upstream Supabase/Netlify маршрутизация, не часть отдельного RU хоста с Яндекс ID; в RU её не переносил.
- Обновлены PostgreSQL CI тесты и лимит вариантов. Новое изменение затрагивает source `main`; я его не менял. Оно не меняет RU YDB схему кроме допустимого расширения JSON-массива, которое проверяется серверной политикой и репозиторием.

Российская ветка не содержит всех изменений upstream main: полное поведенческое соответствие интерфейса, SQL/RLS/RPC и Edge Functions всё ещё не доказано. Облачный staging и реальные OAuth/S3/YDB не настроены.

## Delta исходного main после snapshot `7fd4182`

- Commit `b5b3773` исправил определение доступности Supabase/Netlify и безопасный fallback на GitHub Pages. Commit `7532820` не разрешает переход на Netlify без явного `health.ok === true`, сохраняет локальную auth-сессию при выходе и показывает состояние «профиль временно недоступен», если чтение профиля завершилось ошибкой. Эти изменения относятся к исходной Supabase/Netlify оболочке и не добавляют YDB backend endpoint.
- Добавлена migration `20261118212000_restore_own_profile_identity_field_grants.sql`. Она требует включённый RLS, возвращает authenticated `SELECT` только на `person_type`, `staff_position`, `staff_verification_status` и `UPDATE` только на `person_type`, `staff_position`; поля роли и статуса проверки остаются серверными. В RU-копии изменение профиля разрешено только через `/api/v1/me`: сервер связывает запрос с проверенной Яндекс/OIDC личностью, проверяет активность профиля и в транзакции переводит изменённые сведения сотрудника в `pending` проверку. Это функциональный эквивалент в YDB backend, а не перенос Postgres grants.
- В диапазоне не добавились Edge Functions и расписания. Полное поведенческое соответствие 77 migrations/RLS/RPC/triggers и семи Edge Functions ещё не подтверждено.

## Проверки RU-копии на ревизии `bbb1644`

- GitHub Actions SDK/Sharp успешно выполнил закреплённые установки, backend suite, проверку systemd расписаний и нативную Sharp/WebP проверку: [run 44667460743](https://github.com/spartakdubov059/fam-website/actions/runs/44667460743).
- Одноразовая YDB интеграция успешно применила схемы 01–31, выполнила синтетические сценарии и удалила тестовую базу: [run 44667460572](https://github.com/spartakdubov059/fam-website/actions/runs/44667460572).
- Backend suite на предыдущем кодовом snapshot `cf628fe` прошёл локально `300/300`; в ревизии `bbb1644` кодовый тестовый набор изменён только временем fixture ежедневного digest, и соответствующая CI ступень завершилась успешно. Облачного staging, реального OAuth и S3 не было.

Это не российское облачное staging. Бесплатный хост и способ гарантировать предел расходов 0 ₽ не подтверждены; реальные данные пользователей не использовались.
