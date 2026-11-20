# Сверка FAM source → RU на 20 ноября 2026

## Проверенные ревизии

- Исходный FAM: [`main` `75328206895898ab99c1ac3098de6deceda09459`](https://github.com/spartakdubov059/fam-website/commit/75328206895898ab99c1ac3098de6deceda09459).
- Российская копия: [`migration/yandex-cloud` `bbb1644d1da8614597570655d10c62b4030a2146`](https://github.com/spartakdubov059/fam-website/commit/bbb1644d1da8614597570655d10c62b4030a2146).
- В актуальном `main` 77 SQL migration-файлов и 7 Edge Functions; число файлов проверено через GitHub API. Предыдущий source snapshot `7fd418246653f92b53f66bc29fa224d95d04d5cf` содержал 76 migrations.

## Delta исходного main после snapshot `7fd4182`

- Commit `b5b3773` исправил определение доступности Supabase/Netlify и безопасный fallback на GitHub Pages. Commit `7532820` не разрешает переход на Netlify без явного `health.ok === true`, сохраняет локальную auth-сессию при выходе и показывает состояние «профиль временно недоступен», если чтение профиля завершилось ошибкой. Эти изменения относятся к исходной Supabase/Netlify оболочке и не добавляют YDB backend endpoint.
- Добавлена migration `20261118212000_restore_own_profile_identity_field_grants.sql`. Она требует включённый RLS, возвращает authenticated `SELECT` только на `person_type`, `staff_position`, `staff_verification_status` и `UPDATE` только на `person_type`, `staff_position`; поля роли и статуса проверки остаются серверными. В RU-копии изменение профиля разрешено только через `/api/v1/me`: сервер связывает запрос с проверенной Яндекс/OIDC личностью, проверяет активность профиля и в транзакции переводит изменённые сведения сотрудника в `pending` проверку. Это функциональный эквивалент в YDB backend, а не перенос Postgres grants.
- В диапазоне не добавились Edge Functions и расписания. Полное поведенческое соответствие 77 migrations/RLS/RPC/triggers и семи Edge Functions ещё не подтверждено.

## Проверки RU-копии на ревизии `bbb1644`

- GitHub Actions SDK/Sharp успешно выполнил закреплённые установки, backend suite, проверку systemd расписаний и нативную Sharp/WebP проверку: [run 44667460743](https://github.com/spartakdubov059/fam-website/actions/runs/44667460743).
- Одноразовая YDB интеграция успешно применила схемы 01–31, выполнила синтетические сценарии и удалила тестовую базу: [run 44667460572](https://github.com/spartakdubov059/fam-website/actions/runs/44667460572).
- Backend suite на предыдущем кодовом snapshot `cf628fe` прошёл локально `300/300`; в ревизии `bbb1644` кодовый тестовый набор изменён только временем fixture ежедневного digest, и соответствующая CI ступень завершилась успешно. Облачного staging, реального OAuth и S3 не было.

Это не российское облачное staging. Бесплатный хост и способ гарантировать предел расходов 0 ₽ не подтверждены; реальные данные пользователей не использовались.
