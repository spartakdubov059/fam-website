# Сверка FAM source → RU на 20 ноября 2026

## Дополнение: синхронизация двух последних миграций (22 ноября 2026)

Повторная проверка текущих refs выявила, что reference-каталог в `migration/yandex-cloud` содержал 78 файлов `supabase/migrations`, хотя `origin/main` `e0616c5cbd6448cc0cf231ec7957f0c2ec4338a4` содержит 80. В RU-ветку добавлены два отсутствовавших исходника: `20261121190000_restrict_listings_to_authenticated_same_school.sql` и `20261122012818_restrict_listing_image_reads_to_school_members.sql`. Git blob SHA каждого файла побайтно совпадает с blob того же пути в `origin/main`; итоговый каталог содержит 80 файлов.

Файлы добавлены как исходные reference-миграции для аудита переноса. SQL не запускался, Supabase не подключался, никакие production/RU данные или политики не менялись. Поведенческие соответствия в RU backend описаны в `SUPABASE_MIGRATION_INVENTORY_2026-11-20.md` и покрыты имеющимися API/media тестами; это не доказывает полноту облачного PostgreSQL RLS или S3 IAM.

## Source reference sync (21 ноября 2026)

`origin/main` сейчас указывает на `8c89f17acf8c550a14e821e864254ee06a8d28f1`. Для точной сверки в изолированную ветку восстановлены девять отсутствовавших SQL migration-файлов и обновлены шесть различавшихся Supabase Edge Function source-файлов. SHA Git blob каждого из 15 файлов совпадает с `origin/main`; SQL snapshot теперь содержит все 78 миграций. Это обновляет только исходные reference-файлы на этой ветке: production, `main` и RU YDB backend не менялись, новые Supabase функции не развёртывались. Важно: актуальный `fam-listing-image-worker` сохраняет обработчик очереди фото идей, хотя миграция `20261117120000` удалила отдельный orphan cron, который вызывал отсутствовавший endpoint. Наличие кода функции не означает активного расписания; RU-копия по-прежнему использует ручную проверку и не вызывает этот worker или внешнюю модель. Синхронизация исходников не закрывает поведенческий паритет: RU варианты и оставшиеся отличия по этим объектам указаны в [SUPABASE_MIGRATION_INVENTORY_2026-11-20.md](SUPABASE_MIGRATION_INVENTORY_2026-11-20.md), [SOURCE_PARITY_UPDATE_2026-11-20.md](SOURCE_PARITY_UPDATE_2026-11-20.md) и [EDGE_FUNCTION_COVERAGE_2026-11-20.md](EDGE_FUNCTION_COVERAGE_2026-11-20.md).

> Дополнение после проверки ancestry: текущая RU-ветка построена от `migration/yandex-cloud` `2795f05`, не от актуального `main` `5e749c5`. Полная проверка прямого диапазона выявила 9 SQL migrations и 6 Edge Function изменений, которых нет в исходной миграционной ветке. Большинство сценариев имеют отдельный YDB/API аналог в RU; различия и ограничения перечислены в [SOURCE_CROSSWALK_2026-11-20.md](SOURCE_CROSSWALK_2026-11-20.md). Поэтому утверждение ниже «новых неперенесённых изменений … не выявлено» относится только к прежней узкой сверке `7fd4182..5e749c5` и не означает полную паритетность `main` и RU.

## Текущее состояние RU-кода после добавления очереди (20 ноября 2026)

Изолированная RU-ветка на кодовом commit [`0d3be3a`](https://github.com/spartakdubov059/fam-website/commit/0d3be3a5a5b5ea0466340b1e794cff75babed647) прошла [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44690234889) (`327/327`) и [YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44690234948). В последнем добавлены synthetic проверки конкурентной идемпотентной постановки и эксклюзивного lease четырёх разрешённых типов agent-задач. Документальное подтверждение: [`2bac542`](https://github.com/spartakdubov059/fam-website/commit/2bac54249b223d887f810c5b72bdc38a76b5f0a8). Main остаётся `5e749c5`; облачного staging и полного аудита переноса нет.

## Повторная сверка актуального ref (20 ноября 2026)

Повторная прямая проверка GitHub ref разрешила `main` в [`5e749c5`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579), parent [`7532820`](https://github.com/spartakdubov059/fam-website/commit/75328206895898ab99c1ac3098de6deceda09459). Локальная tracking-ссылка `origin/main` в рабочем checkout отставала на `7fd4182`, поэтому прежняя запись выше была устаревшей. Историю `main` не менял.

RU-ветка на [`a34e41e`](https://github.com/spartakdubov059/fam-website/commit/a34e41ee1c91a4e05b97f25e31ec0ffb7db29cd6) не содержит commit `5e749c5` как предка, но включает его функциональное расширение опросов отдельным commit [`f23d42b`](https://github.com/spartakdubov059/fam-website/commit/f23d42b4fa14dd2add9dc899177739e7589ce838): 2–8 вариантов, диапазон голоса 0–7 и проверка индекса относительно конкретного опроса в YDB. Значит, прежнее утверждение, что 2–8 — расширение только относительно текущего `main`, уже неверно.

Проверенные изменения между `7fd4182` и текущим `main` включают уточнение fallback-auth и readiness (`b5b3773`, `7532820`) и расширение опросов (`5e749c5`). RU-оболочка использует собственные Yandex/OIDC auth и backend, поэтому Supabase/Netlify redirect/session правки не переносятся как код; восьмивариантные опросы уже реализованы в RU. Новых неперенесённых изменений, требующих отдельного RU-патча, в этой целевой сверке не выявлено. Это не доказывает полное поведенческое соответствие всех миграций/RLS/RPC/Edge Functions.

Текущая RU-ветка на [`d900cd1`](https://github.com/spartakdubov059/fam-website/commit/d900cd1377b5a3577050552daaaa371a5374ea50) fail-closed отвергает пустой, дублированный и противоречивый отчёт о таймерах. CI подтвердил `316/316` backend-тестов, SDK/Sharp проверку и одноразовую интеграцию с локальной YDB на синтетических данных. Российского облачного staging это не подтверждает.

## Проверенные ревизии предыдущего сравнения

- Тогда сравнивались FAM commit [`5e749c56b9270efbfdf1f48cefe6e8d95a01c579`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579) и RU commit [`f23d42b4fa14dd2add9dc899177739e7589ce838`](https://github.com/spartakdubov059/fam-website/commit/f23d42b4fa14dd2add9dc899177739e7589ce838).
- На сравнительной ревизии `5e749c5` было 78 SQL migration-файлов и 7 Edge Functions; исходный snapshot `7fd4182` содержал 76 migrations. Сейчас `5e749c5` снова является текущей вершиной `main`.

## Отличия ревизии `5e749c5` от `7fd4182`

Commit [`5e749c5`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579) расширил опросы с 2–4 до 2–8 вариантов, ограничил индекс голоса диапазоном 0–7 и добавил миграцию Postgres. В RU-копии этот сценарий синхронизирован в `f23d42b`: UI создаёт и показывает до восьми вариантов, API принимает только индексы 0–7, YDB репозиторий проверяет индекс относительно числа ответов конкретного опроса, синтетический YDB интеграционный сценарий создаёт восьмивариантный опрос и голосует за индекс 7. На RU-ревизии локально прошли `311/311` тестов; [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508222) и [одноразовая YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508156) прошли.

Остальные изменения этой ревизии:

- В `school-pulse.js` сохраняется текущая hero-карточка после обновления ленты и карусель доступна при отказе загрузки. Российская оболочка использует отдельный список school-pulse и не имеет этой карусели.
- В `index.html` обычные GitHub Pages визиты переводятся на Netlify даже при сохранённой локальной Supabase-сессии; на Pages остаются URL auth callbacks. Это относится к Supabase/Netlify маршрутизации исходной оболочки.
- Были обновлены PostgreSQL CI тесты и лимит вариантов. Эти сведения описывают ревизию `5e749c5`, которая снова является текущим ref `main`.

Российская ветка не содержит всех изменений upstream main: полное поведенческое соответствие интерфейса, SQL/RLS/RPC и Edge Functions всё ещё не доказано. Облачный staging и реальные OAuth/S3/YDB не настроены.

## Delta текущего main после snapshot `7fd4182`

- Commit `b5b3773` исправил определение доступности Supabase/Netlify и безопасный fallback на GitHub Pages. Commit `7532820` не разрешает переход на Netlify без явного `health.ok === true`, сохраняет локальную auth-сессию при выходе и показывает состояние «профиль временно недоступен», если чтение профиля завершилось ошибкой. Эти изменения относятся к исходной Supabase/Netlify оболочке и не добавляют YDB backend endpoint.
- Добавлена migration `20261118212000_restore_own_profile_identity_field_grants.sql`. Она требует включённый RLS, возвращает authenticated `SELECT` только на `person_type`, `staff_position`, `staff_verification_status` и `UPDATE` только на `person_type`, `staff_position`; поля роли и статуса проверки остаются серверными. В RU-копии изменение профиля разрешено только через `/api/v1/me`: сервер связывает запрос с проверенной Яндекс/OIDC личностью, проверяет активность профиля и в транзакции переводит изменённые сведения сотрудника в `pending` проверку. Это функциональный эквивалент в YDB backend, а не перенос Postgres grants.
- В диапазоне не добавились Edge Functions и расписания. Полное поведенческое соответствие миграций/RLS/RPC/triggers и семи Edge Functions ещё не подтверждено.

## Проверки RU-копии на ревизии `bbb1644`

- GitHub Actions SDK/Sharp успешно выполнил закреплённые установки, backend suite, проверку systemd расписаний и нативную Sharp/WebP проверку: [run 44667460743](https://github.com/spartakdubov059/fam-website/actions/runs/44667460743).
- Одноразовая YDB интеграция успешно применила схемы 01–31, выполнила синтетические сценарии и удалила тестовую базу: [run 44667460572](https://github.com/spartakdubov059/fam-website/actions/runs/44667460572).
- Backend suite на предыдущем кодовом snapshot `cf628fe` прошёл локально `300/300`; в ревизии `bbb1644` кодовый тестовый набор изменён только временем fixture ежедневного digest, и соответствующая CI ступень завершилась успешно. Облачного staging, реального OAuth и S3 не было.

Это не российское облачное staging. Бесплатный хост и способ гарантировать предел расходов 0 ₽ не подтверждены; реальные данные пользователей не использовались.
