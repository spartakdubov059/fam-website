# Сверка FAM source → RU на 20 ноября 2026

## Проверенные ревизии

- Исходный FAM: [`main` `7fd418246653f92b53f66bc29fa224d95d04d5cf`](https://github.com/spartakdubov059/fam-website/commit/7fd418246653f92b53f66bc29fa224d95d04d5cf).
- Российская копия: [`migration/yandex-cloud` `809f11e535dc318c8fd302bb101575f58f0a66e0`](https://github.com/spartakdubov059/fam-website/commit/809f11e535dc318c8fd302bb101575f58f0a66e0).
- В source `main` на этой ревизии — 76 файлов `supabase/migrations` и 7 Edge Functions. Между прошлым snapshot `75328206895898ab99c1ac3098de6deceda09459` и текущей ревизией удалена одна migration (`20261118212000_restore_own_profile_identity_field_grants.sql`); остальные изменения диапазона — корректировки root UI/fallback и диагностических проверок.

## Delta после прошлой сверки

- `index.html` уточнил переход с GitHub Pages на Netlify и поведение при недоступности основного хоста; также изменились отображение профиля при недоступных данных и scope выхода из Supabase. Это часть исходного Supabase/Netlify сайта. Она не меняет YDB backend, серверную Яндекс ID авторизацию или RU shell.
- `scripts/check-fam-russia-reachability.mjs` теперь распознаёт HTTP 401 как достижимый защищённый API только при успешном флаге probe. Это исправляет диагностику и не является переносом API.
- Удалённая migration восстанавливала ограниченные Postgres column grants профиля. Эти grants не имеют прямого YDB DDL эквивалента; российский backend разрешает чтение и изменение профиля отдельными server-side маршрутами и параметризованными запросами.
- В проверенном диапазоне не добавлено новых Edge Functions или миграций данных, требующих немедленного переноса в RU-копию. Поведенческое соответствие всех 76 migrations/RLS/RPC/triggers и семи Edge Functions всё ещё требует полного аудита.

## Текущие проверки RU-копии

- Локально на Node `v22.15.0`: `npm ci` по backend lockfile, затем `npm test` — **300/300**.
- `npm ci` по compat lockfile и `node ru-migration/compat/verify.mjs` прошли: закреплённые Sharp/WebP, YDB query-client методы и AWS SDK exports. Cloud integration verifier не подключался к облаку.
- YDB CI [`101faf22`](https://github.com/spartakdubov059/fam-website/actions/runs/44656608418) успешно применила схемы 01–31, прошла синтетические интеграционные сценарии и удалила одноразовую базу. После CI backend/schema в `809f11e` не менялись.
- SDK/Sharp CI на кодовой базе [`a260f405`](https://github.com/spartakdubov059/fam-website/actions/runs/44654421824) завершилась успешно.
- Это локальная и ephemeral YDB проверка, не российский облачный staging. Полный security scan остаётся незавершённым; бесплатный облачный стенд с гарантированным пределом 0 ₽ не подтверждён. `main`, production и реальные школьные данные не использовались.
