# Сверка схемы и функций FAM → FAM RU

Пересверено 23 ноября 2026. Последний source ref — FAM `main` [`241e3d302f4afcceb57a75a977053fa1125d8a9a`](https://github.com/spartakdubov059/fam-website/commit/241e3d302f4afcceb57a75a977053fa1125d8a9a); SQL-инвентарь был подготовлен на `bdb8325843f4d02590723d396d5b3f803d04618a`, и новый read-only прогон подтвердил совпадение всех 83 файлов по именам и Git blob SHA с текущим `main` — см. [проверку](VALIDATION_2026-11-23_SOURCE_INVENTORY.md). Локальная checkout содержит 80 исходных файлов, ещё три точные read-only копии хранятся отдельно. Первоначальное сопоставление RU-кода сделано на `9d26433099e777d067e2785591dc5d87379d99e6`. Этот crosswalk не является полным повторным семантическим аудитом. RU-кодовый коммит `1249736` дополнительно переносит безопасные diagnostic IDs последнего source bridge; Qwen/model execution и создание PR не включены.

## Объём и метод

- В source snapshot `bdb8325`: 83 файла `supabase/migrations/*.sql`, 7 Edge Function entrypoints. Root source checkout содержит 80 SQL файлов; ещё 3 точных upstream-файла сохранены в [`source-reference/supabase-migrations`](source-reference/supabase-migrations/) с проверенными Git blob SHA. Это только read-only evidence: их нельзя запускать на YDB или Supabase. Source `main` позже продвинулся до `e574e905`, где 84-я migration учтена ниже как ещё не перенесённая. Семантическая замена остаётся отдельной от наличия исходных SQL-файлов.
- Лексический поиск SQL-файлов нашёл 19 уникальных имён таблиц в `CREATE TABLE`, 53 имени функции в `CREATE OR REPLACE FUNCTION` и 5 имён триггеров в `CREATE TRIGGER`. Четыре lifecycle-функции добавлены миграцией `20261123001553_fam_qwen_lease_and_lifecycle.sql`, а агрегатная метрика — `20261123013500_fam_agent_task_metrics.sql`. Это подсчёт по тексту, а не анализ итогового живого PostgreSQL-каталога: он не учитывает полностью динамический SQL и жизненный цикл `ALTER`/`DROP`.
- RU содержит 37 YQL-файлов и 39 объявлений `CREATE TABLE`. Схема и репозиторий проверены чтением кода, существующие интеграционные проверки указаны в других документах. Это не аудит реальных YDB grants/IAM и не эквивалент PostgreSQL RLS.

## Подсчёт исходных access-control DDL (лексический)

| Конструкция в `supabase/migrations/*.sql` | Совпадений текста | Ограничение подсчёта |
|---|---:|---|
| `CREATE POLICY` | 71 | Включает политики, которые позднее удаляются/заменяются; это не число конечных активных политик. |
| `GRANT` или `REVOKE` | 153 | Подсчёт строк с операторами; не свёрнут по объекту, роли и порядку миграций. |
| `ENABLE ROW LEVEL SECURITY` | 14 | Табличный итог требует проверки PostgreSQL catalog и FORCE/RLS role semantics. |
| `FORCE ROW LEVEL SECURITY` | 4 | Строки миграций, не подтверждение итогового состояния живой базы. |

Эти количества относились к предыдущему source snapshot `cc8b59b`. Source snapshot `bdb8325843f4d02590723d396d5b3f803d04618a` содержит 83 SQL-файла; source `main` `e574e905` содержит 84. Подсчёты нужны только для оценки охвата аудита; RPC crosswalk пока основан на старом snapshot. В RU нет эквивалентного набора RLS policy DDL, поэтому каждую доступную операцию следует свести к actor/school/owner проверкам и отдельно подтвердить минимальный Yandex IAM.

## Таблицы, создаваемые исходными миграциями

| Исходная таблица | RU таблицы / маршрут | Итог и существенное различие |
|---|---|---|
| `event_occupancy` | `fam_event_occupancy`, `fam_event_registrations`; event API и атомарные repository операции | Поведение занятости/резервации покрыто синтетической YDB интеграцией; облачные транзакции и IAM не проверены. |
| `content_rate_limits` | `fam_submission_quotas`; submit-content API | Общий лимит публикаций перенесён в RU квоту, включая аватар; отличается моделью и проверяется приложением. |
| `school_admin_requests` | `fam_school_role_requests`, аудит; school-role API | Расширен до школьных ролей; отдельная таблица не сохранена. Политики базы заменены серверными проверками. |
| `council_admin_audit` | `fam_school_admin_audit` и события аудита ролей | Смысловой аналог; состав событий не тождественен всем исходным trigger side effects. |
| `account_deletion_requests` | `fam_account_deletion_requests`, `fam_account_deletion_open`, `fam_account_deletion_jobs` | Разделено на заявку, ключ открытой заявки и выполняемую job; переход `cancelled` источника не найден в активных потоках. |
| `fam_safety_incidents` | `fam_safety_incidents` | Аналог; приватность/retention реализованы RU схемой и backend, облачные ACL не подтверждены. |
| `account_suspensions` | `fam_account_suspensions`, `fam_account_suspension_open`, `fam_account_suspension_audit` | Разделено по текущему/историческому состоянию; отказ записи реализован API, а не DB trigger. |
| `fam_agent_ideas` | `fam_agent_ideas` | Сохранено ограниченное хранилище предложений; RU generation детерминирована и без внешней модели. |
| `fam_agent_tasks` | `fam_agent_tasks`, `fam_agent_task_events` | RU очередь ограничивает payload allowlist агрегированных технических событий; Qwen/code execution не включены. Последний lifecycle diff источника добавлен RU репозиторием с отдельным claim token, ограниченными lease и стадиями. Это не перенос модели, инструментов или автоматического PR runner.
| `fam_agent_daily_reports` | `fam_agent_daily_reports`, `fam_agent_school_daily_reports` | Глобальная отчётность частично разделена на школьные и агрегатные очереди; все источники метрик/функций не эквивалентны. |
| `notification_reads` | `fam_notification_reads` | Аналог состояния прочтения; проверяется серверным API. |
| `fam_site_error_counts` | `fam_site_error_counts`, `fam_site_error_digest_tasks` | Счётчики и digest перенесены в агрегированном виде. Digest синхронизирован с итоговым исходным расписанием — каждый час в `:30` UTC; текст/PII не сохраняются. |
| `listing_image_moderation_queue` | `fam_pending_media`, `fam_avatar_reviews`, закрытый media API | Только частичная замена: автоматический внешний vision worker намеренно отсутствует, фото проходят ручную проверку. |
| `avatar_image_moderation_queue` | `fam_pending_media`, `fam_avatar_reviews` | Только частичная замена с ручной проверкой, без автоматического model-backed решения. |
| `fam_school_announcements` | одноимённая YDB таблица | Перенесена школьная публикация через серверный API; YDB IAM не проверен. |
| `fam_school_polls` | одноимённая YDB таблица | Перенесены школьные опросы и серверная проверка ролей; расширение вариантов проверено в RU коде. |
| `fam_school_poll_votes` | одноимённая YDB таблица | Перенесено голосование через server route; это не Postgres RPC/RLS parity. |

Базовые исходные таблицы `user_profiles`, `listings`, `ideas`, `messages`, `favorites`, `event_registrations` и `pending_messages` не создаются этими выборочно найденными `CREATE TABLE` выражениями в текущем наборе миграций; они сопоставлены с `fam_user_profiles`, `fam_listings`, `fam_ideas`, `fam_messages`, `fam_favorites`, `fam_event_registrations` и `fam_pending_messages` по RU начальной схеме и API.

RU-специфические таблицы без прямой отдельной исходной таблицы включают: `fam_pending_media`, `fam_idea_images`, `fam_profile_requests`, `fam_school_role_request_audit`, `fam_account_deletion_open`, `fam_account_deletion_jobs`, `fam_account_suspension_open`, `fam_account_suspension_audit`, `fam_agent_daily_digest_tasks`, `fam_site_error_digest_tasks`, `fam_school_content_audit`, `fam_initial_school_admin_bootstrap`, `fam_role_email_verifications`, `fam_step_up_email_challenges`. Они поддерживают RU архитектуру или закрывают процессы несколькими объектами; это не новые пользовательские данные из production.

## Функции, триггеры, RLS и фоновая обработка

- 52 уникальных текстовых имени `CREATE OR REPLACE FUNCTION` не являются 52 отдельными бизнес-возможностями: миграции заменяют версии функций. Их поштучное сопоставление с аргументами, grants, SECURITY DEFINER/search_path и результатами ещё не завершено.
- Шесть обнаруженных текстовых объявлений trigger и пять уникальных имен: `guard_last_school_admin` (две версии в миграциях), `fam_suspension_write_guard`, `profiles_guard_identity_update`, `reserve_event_seat_before_write`, `release_event_seat_after_write`. Это лексическая выборка: итоговую активность/привязки следует сверить с итоговым DDL, а не по числу объявлений.
- RU переносит контроль в API и YDB транзакции; это не перенос RLS/grants в эквивалентные YDB политики. Нельзя считать облачную авторизацию подтверждённой до проверки runtime service account и ограничений IAM.
- `fam_suspension_write_guard`: source trigger проверяет `auth.uid()` перед изменением каждой public table; без пользователя (`auth.uid() IS NULL`) он пропускает системную запись. RU API заменяет это контролем маршрута: runtime оборачивает все listings и media записи в `createSuspensionWriteGuard`; account deletion API отдельно блокирует удаление чужого аккаунта и review actions активного администратора, но сохраняет self-deletion. Модульные тесты проверяют общий write/read split, media handlers и исключение self-deletion. Прямой доступ к YDB в обход этих API должен быть исключён service-account/IAM; текущая проверка репозитория не доказывает это облачное ограничение.
- `profiles_guard_identity_update`: source trigger не разрешает самоназначение роли/школы и нормализует class/staff verification поля. RU `PATCH /api/v1/me` и repository update связывают запись с парой verified `issuer`/`subject`; SQL меняет display name и person-type поля, не `school_id` или `role`. Repository regression test также передаёт поддельные `role`/`school_id` и требует, чтобы они не попали в YDB update. Cloud IAM и database grants остаются непроверенными.
- `guard_last_school_admin`: в исходнике блокирует параллельное снятие/перенос последнего администратора advisory lock на школу и проверяет остаток администраторов. RU сохраняет инвариант в транзакциях `revokeSchoolRole` и `beginAccountDeletion` (`ru-migration/app/backend/repositories/ydb-listings.mjs`): сначала проверяется число активных администраторов, затем в той же транзакции меняется роль или активность и записывается job/audit. Закреплённый `@ydbjs/query@6.3.0` задаёт `serializableReadWrite` как режим `sql.begin` по умолчанию; документация YDB гарантирует сериализуемый результат успешных транзакций и отклонение конфликтующих. SDK не переигрывает эти транзакции без явного `idempotent: true`, что корректно для операций с одноразовым claim token и аудитом. При конфликте API оставляет защиту целой и возвращает ошибку доступности БД, допускающую повтор запроса. Synthetic гонки для параллельного снятия роли и параллельного self-deletion двух администраторов проверены в точном disposable YDB CI [#45221304505](https://github.com/spartakdubov059/fam-website/actions/runs/45221304505) на code commit `98fffa6`: в каждом сценарии ровно одно изменение успешно, и остаётся ровно один активный администратор. Одноразовая база удалена; Yandex Cloud staging не проверен. Источники: `supabase/migrations/20261109121716_enforce_atomic_last_school_admin_guard.sql` в снимке исходного `main`; YDB transaction contract — https://ydb.tech/docs/en/concepts/transactions.
- Семь функций Edge: `council-management`, `fam-agent-coder-bridge`, `fam-agent-worker`, `fam-listing-image-worker`, `moderate`, `school-admin-access`, `submit-content`. Основные пользовательские маршруты council, moderation, school access и submission представлены в RU backend с различиями; coder worker/model execution не переносится, image AI moderation заменена ручной очередью, внешний текст/model safety не является полным аналогом. См. `EDGE_FUNCTION_COVERAGE_2026-11-20.md`.
- Исходная миграция `fam-agent-site-error-audit` впервые создавала расписание `*/15`, но последующая `20261110181754_20261110180500_fam_agent_moscow_morning_schedule.sql` перевела его на `30 * * * *`; позднейший migration `20261111183253_monitor_qwen_coder_producer_schedule.sql` сохраняет именно `:30` в health audit. RU systemd/Yandex, queue slot validation, digest idempotency and stale-queue health gates now match hourly `:30`. Остальные cron/workers имеют отдельные частичные реализации и задокументированные ограничения в `CRON_PORTING.md`.

## Оставшиеся обязательные проверки

1. Проверить по PostgreSQL parser/catalog все строки из `RPC_SECURITY_CROSSWALK_2026-11-23.md`, включая grants/revokes, итоговые SECURITY/search_path и request/response контракт; текущий каталог — lexical стартовая сверка.
2. Сверить итоговые активные триггеры и RLS/policy state после всех 83 миграций; значения DDL-операторов остаются только ориентиром lexical scan.
3. Для каждой из семи Edge Functions закрыть сценарии и явно принять/реализовать отличия, особенно email confirmation, moderation/model safety, worker/coder execution и media flows.

## Обновление source `main` и RU coder lifecycle — 23 ноября 2026

- Предыдущий скриптовый подсчёт `cc8b59b` дал 81 SQL migration path, 7 Edge Function entrypoints; 19 уникальных `CREATE TABLE`, 52 уникальных `CREATE OR REPLACE FUNCTION`, 5 уникальных `CREATE TRIGGER`. Source snapshot `bdb8325` содержит 83 SQL paths, 7 entrypoints, 53 уникальных RPC имени; точные имена проверены для того snapshot. На последнем `main` `e574e905` уже 84 SQL paths; новый RPC и итоговый lexical inventory в старый список пока не включены.
- RU теперь поддерживает lease-bound `start`, `heartbeat`, и упорядоченные стадии `model_generated`, `qa_passed`, `pr_created`, `qa_failed`, `model_no_patch`, `model_failed`, `model_blocked`. На YDB task дополнительно требуется одноразовый claim token, а не только worker bearer; максимальные lifecycle lease ограничены 30 минутами, дальнейшее продление — двумя часами. Успешный `finish` допускает только `model_no_patch`; подтверждение `model_completed` отклоняется.
- Добавлена synthetic YDB integration последовательность для start/heartbeat/model/QA/PR стадии и проверки освобождения аренды после PR handoff. Её синтаксис и локальная имитационная часть проходят; точная последовательность против YDB пока не проверена, потому что нет локального YDB/Docker и текущий diff не опубликован для disposable GitHub Actions.
- Этот port реализует состояние очереди, но не исполняет Qwen, shell/tools или GitHub PR операции. Он не делает полную эквивалентность source workflow; независимый security review обязателен.

## Проверка RU coder claim относительно источника — 23 ноября 2026

- В `claimSafeCoderTask` RU раньше выбирал задачи по времени создания, а source RPC сначала сортирует по `priority` (`urgent`, `high`, `normal`, затем прочие). RU query и unit assertion обновлены на коммите [`a327510`](https://github.com/spartakdubov059/fam-website/commit/a32751087ae460ada7da175e32171486bc843d47).
- Для одной синтетической coder-задачи запущены два параллельных claim. Условие «выдана ровно одна аренда» прошло в [disposable YDB integration #45175534283](https://github.com/spartakdubov059/fam-website/actions/runs/45175534283); SDK/Sharp workflow #45175534306 прошёл также. Это исправляет семантику выбора и проверяет конкурентный доступ на тестовой YDB, но не запускает Qwen и не проверяет cloud IAM.

## Повторная сверка с обновившимся `main` — 23 ноября 2026

- После branch tip `60b724f` исходный `main` обновился до `e574e905da574356eb847ec4a92b3ea64894adfa` (PR #157). Теперь там **84 SQL migration**, включая `20261123194000_fam_inspector_bounded_coder_enqueue.sql`; предыдущий RU inventory содержал 83 имени. Read-only сравнение найдено: ровно этот файл отсутствует в RU документах, иных пропусков и лишних имён нет.
- Migration добавляет allowlisted `INSPECTOR → coder_patch_request` сигнал, дедупликацию/cooldown и claim только для технического worker. Она ограничивает типы событий/полей и не записывает workflow logs. Связанные текущие upstream правки в `fam-agent-coder-bridge` включают enqueue entrypoint. RU намеренно не исполняет Qwen, shell/tools или автоматическое создание PR; поэтому безопасное решение сейчас — документировать функциональный разрыв, а не включать этот поток без независимой проверки и разрешённых российских model/worker ресурсов.
- RU branch и рабочий checkout остались `60b724fa7a851a6b64c8e9f2920b4913a0c0b8bb`; `main` только прочитана. Новая migration не применяется ни к RU YDB, ни к production. Потребуется обновить function/RPC инвентарь и рассмотреть перенос только после отдельного threat review orchestration.
4. Получить бесплатное безопасное окружение с проверяемым hard stop стоимости; без него облачные ресурсы не включать. В доступных условиях гарантированного 0 ₽ cloud staging нет.
5. После статического закрытия parity выполнить disposable YDB + private S3 integration на синтетических данных, затем проверить OAuth/Postbox, IAM, backup/restore и права без подключения реальных школьных записей.

На дату документа Yandex Cloud staging не создан. Ни одна проверка здесь не разрешает публикацию, перенос реальных данных, платную подписку или изменение `main`/production.
