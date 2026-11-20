# Сверка FAM source → RU на 20 ноября 2026

# Сверка FAM source → RU на 20 ноября 2026

## Повторная сверка актуального ref (20 ноября 2026)

GitHub API и `git fetch origin main` сейчас разрешают `main` в [`7fd4182`](https://github.com/spartakdubov059/fam-website/commit/7fd418246653f92b53f66bc29fa224d95d04d5cf), который содержит 76 migrations и 7 Edge Functions. Предыдущая запись ниже описывает ревизию [`5e749c5`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579), но этот commit не является предком текущего `main`. Это подтверждённое расхождение истории; его причина неизвестна. Поэтому опросы на 2–8 вариантов в RU, синхронизированные с `5e749c5`, являются расширенной RU-версией относительно текущего `main` (в котором 2–4), а прежние формулировки «актуальный main — 5e749c5» исправлены.

Текущая RU-ветка после добавления read-only system-health отчёта — [`e6044a0`](https://github.com/spartakdubov059/fam-website/commit/e6044a0489245ea755d7031b422d1f0c3f500b02). На этом commit CI подтвердил `315/315` backend-тестов, SDK/Sharp проверку и одноразовую интеграцию с локальной YDB на синтетических данных. Российского облачного staging это не подтверждает.

## Проверенные ревизии предыдущего сравнения

- Тогда сравнивались FAM commit [`5e749c56b9270efbfdf1f48cefe6e8d95a01c579`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579) и RU commit [`f23d42b4fa14dd2add9dc899177739e7589ce838`](https://github.com/spartakdubov059/fam-website/commit/f23d42b4fa14dd2add9dc899177739e7589ce838).
- В той ревизии `5e749c5` было 78 SQL migration-файлов и 7 Edge Functions; исходный snapshot `7fd4182` содержал 76 migrations. `5e749c5` больше не является текущим `main`.

## Отличия ревизии `5e749c5` от `7fd4182`

Commit [`5e749c5`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579) расширил опросы с 2–4 до 2–8 вариантов, ограничил индекс голоса диапазоном 0–7 и добавил миграцию Postgres. В RU-копии этот сценарий синхронизирован в `f23d42b`: UI создаёт и показывает до восьми вариантов, API принимает только индексы 0–7, YDB репозиторий проверяет индекс относительно числа ответов конкретного опроса, синтетический YDB интеграционный сценарий создаёт восьмивариантный опрос и голосует за индекс 7. На RU-ревизии локально прошли `311/311` тестов; [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508222) и [одноразовая YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508156) прошли.

Остальные изменения этой ревизии:

- В `school-pulse.js` сохраняется текущая hero-карточка после обновления ленты и карусель доступна при отказе загрузки. Российская оболочка использует отдельный список school-pulse и не имеет этой карусели.
- В `index.html` обычные GitHub Pages визиты переводятся на Netlify даже при сохранённой локальной Supabase-сессии; на Pages остаются URL auth callbacks. Это относится к Supabase/Netlify маршрутизации исходной оболочки.
- Были обновлены PostgreSQL CI тесты и лимит вариантов. Эти сведения описывают ревизию `5e749c5`, а не текущий ref `main`.

Российская ветка не содержит всех изменений upstream main: полное поведенческое соответствие интерфейса, SQL/RLS/RPC и Edge Functions всё ещё не доказано. Облачный staging и реальные OAuth/S3/YDB не настроены.

## Историческая delta ревизии `5e749c5` после snapshot `7fd4182`

- Commit `b5b3773` исправил определение доступности Supabase/Netlify и безопасный fallback на GitHub Pages. Commit `7532820` не разрешает переход на Netlify без явного `health.ok === true`, сохраняет локальную auth-сессию при выходе и показывает состояние «профиль временно недоступен», если чтение профиля завершилось ошибкой. Эти изменения относятся к исходной Supabase/Netlify оболочке и не добавляют YDB backend endpoint.
- Добавлена migration `20261118212000_restore_own_profile_identity_field_grants.sql`. Она требует включённый RLS, возвращает authenticated `SELECT` только на `person_type`, `staff_position`, `staff_verification_status` и `UPDATE` только на `person_type`, `staff_position`; поля роли и статуса проверки остаются серверными. В RU-копии изменение профиля разрешено только через `/api/v1/me`: сервер связывает запрос с проверенной Яндекс/OIDC личностью, проверяет активность профиля и в транзакции переводит изменённые сведения сотрудника в `pending` проверку. Это функциональный эквивалент в YDB backend, а не перенос Postgres grants.
- В диапазоне не добавились Edge Functions и расписания. Полное поведенческое соответствие миграций/RLS/RPC/triggers и семи Edge Functions ещё не подтверждено.

## Проверки RU-копии на ревизии `bbb1644`

- GitHub Actions SDK/Sharp успешно выполнил закреплённые установки, backend suite, проверку systemd расписаний и нативную Sharp/WebP проверку: [run 44667460743](https://github.com/spartakdubov059/fam-website/actions/runs/44667460743).
- Одноразовая YDB интеграция успешно применила схемы 01–31, выполнила синтетические сценарии и удалила тестовую базу: [run 44667460572](https://github.com/spartakdubov059/fam-website/actions/runs/44667460572).
- Backend suite на предыдущем кодовом snapshot `cf628fe` прошёл локально `300/300`; в ревизии `bbb1644` кодовый тестовый набор изменён только временем fixture ежедневного digest, и соответствующая CI ступень завершилась успешно. Облачного staging, реального OAuth и S3 не было.

Это не российское облачное staging. Бесплатный хост и способ гарантировать предел расходов 0 ₽ не подтверждены; реальные данные пользователей не использовались.
