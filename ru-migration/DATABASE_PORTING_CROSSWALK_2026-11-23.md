# Сверка схемы и функций FAM → FAM RU

Пересверено 23 ноября 2026. Исходник — удалённый ref FAM `main` на `cc8b59bd2517ddfe2b6488b16cff468e99c05980`; первоначальное сопоставление RU-кода сделано на `9d26433099e777d067e2785591dc5d87379d99e6`. Позднейшие проверки отдельных потоков и локальные исправления описаны в журнале прогресса; этот crosswalk не является полным повторным аудитом текущего кода `074bf17` или документационного HEAD `185ab40170eeac3c45d4fa12cff6a980afd2ba12`. Дополнение в конце документа фиксирует lifecycle port и его границы.

## Объём и метод

- В source `main`: 81 файл `supabase/migrations/*.sql`, 7 Edge Function entrypoints.
- Лексический поиск SQL-файлов нашёл 19 уникальных имен таблиц в `CREATE TABLE`, 52 имени функции в `CREATE OR REPLACE FUNCTION` и 5 имен триггеров в `CREATE TRIGGER`. Четыре функции сверх прежнего снимка добавлены миграцией `20261123001553_fam_qwen_lease_and_lifecycle.sql`. Это подсчёт по тексту, а не анализ итогового живого PostgreSQL-каталога: он не учитывает полностью динамический SQL и жизненный цикл `ALTER`/`DROP`.
- RU содержит 37 YQL-файлов и 39 объявлений `CREATE TABLE`. Схема и репозиторий проверены чтением кода, существующие интеграционные проверки указаны в других документах. Это не аудит реальных YDB grants/IAM и не эквивалент PostgreSQL RLS.

## Подсчёт исходных access-control DDL (лексический)

| Конструкция в `supabase/migrations/*.sql` | Совпадений текста | Ограничение подсчёта |
|---|---:|---|
| `CREATE POLICY` | 71 | Включает политики, которые позднее удаляются/заменяются; это не число конечных активных политик. |
| `GRANT` или `REVOKE` | 153 | Подсчёт строк с операторами; не свёрнут по объекту, роли и порядку миграций. |
| `ENABLE ROW LEVEL SECURITY` | 14 | Табличный итог требует проверки PostgreSQL catalog и FORCE/RLS role semantics. |
| `FORCE ROW LEVEL SECURITY` | 4 | Строки миграций, не подтверждение итогового состояния живой базы. |

Эти количества подтверждены повторным `rg` по текущим 81 SQL-файлам из `main` `cc8b59bd2517ddfe2b6488b16cff468e99c05980`. Они нужны только для оценки охвата аудита; в RU нет эквивалентного набора RLS policy DDL, поэтому каждую доступную операцию следует свести к actor/school/owner проверкам и минимальному Yandex IAM отдельно.

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
| `fam_site_error_counts` | `fam_site_error_counts`, `fam_site_error_digest_tasks` | Счётчики и digest перенесены в агрегированном виде. Digest синхронизирован с 15-минутным исходным расписанием; текст/PII не сохраняются. |
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
- `guard_last_school_admin`: в исходнике блокирует параллельное снятие/перенос последнего администратора advisory lock на школу и проверяет остаток администраторов. RU сохраняет инвариант в транзакциях `revokeSchoolRole` и `beginAccountDeletion` (`ru-migration/app/backend/repositories/ydb-listings.mjs`): сначала проверяется число активных администраторов, затем в той же транзакции меняется роль или активность и записывается job/audit. Закреплённый `@ydbjs/query@6.3.0` задаёт `serializableReadWrite` как режим `sql.begin` по умолчанию; документация YDB гарантирует сериализуемый результат успешных транзакций и отклонение конфликтующих. SDK не переигрывает эти транзакции без явного `idempotent: true`, что корректно для операций с одноразовым claim token и аудитом. При конфликте API оставляет защиту целой и возвращает ошибку доступности БД, допускающую повтор запроса. В `compat/integration-ydb.mjs` добавлены synthetic гонки для параллельного снятия роли и параллельного self-deletion двух администраторов; каждая требует ровно одного успешного изменения и ровно одного оставшегося active admin. Они подготовлены для disposable YDB CI, но в текущем окружении пока не запускались. Облачный staging не проверен. Источники: `supabase/migrations/20261109121716_enforce_atomic_last_school_admin_guard.sql` в снимке исходного `main`; YDB transaction contract — https://ydb.tech/docs/en/concepts/transactions.
- Семь функций Edge: `council-management`, `fam-agent-coder-bridge`, `fam-agent-worker`, `fam-listing-image-worker`, `moderate`, `school-admin-access`, `submit-content`. Основные пользовательские маршруты council, moderation, school access и submission представлены в RU backend с различиями; coder worker/model execution не переносится, image AI moderation заменена ручной очередью, внешний текст/model safety не является полным аналогом. См. `EDGE_FUNCTION_COVERAGE_2026-11-20.md`.
- Фоновое расписание `fam-agent-site-error-audit` в исходной миграции — `*/15 * * * *`. RU systemd/Yandex расписание теперь `00,15,30,45` каждой UTC-часа. Остальные cron/workers имеют отдельные частичные реализации и задокументированные ограничения в `CRON_PORTING.md`.

## Оставшиеся обязательные проверки

1. Проверить по PostgreSQL parser/catalog все строки из `RPC_SECURITY_CROSSWALK_2026-11-23.md`, включая grants/revokes, итоговые SECURITY/search_path и request/response контракт; текущий каталог — lexical стартовая сверка.
2. Сверить итоговые активные триггеры и RLS/policy state после всех 81 миграции; текущие количества 71 policy, 153 grant/revoke, 14 enable-RLS и 4 force-RLS — только ориентир lexical scan.
3. Для каждой из семи Edge Functions закрыть сценарии и явно принять/реализовать отличия, особенно email confirmation, moderation/model safety, worker/coder execution и media flows.

## Обновление source `main` и RU coder lifecycle — 23 ноября 2026

- Повторный скриптовый подсчёт удалённого Git tree `cc8b59b`: 81 SQL migration path, 7 Edge Function entrypoints; 19 уникальных `CREATE TABLE`, 52 уникальных `CREATE OR REPLACE FUNCTION`, 5 уникальных `CREATE TRIGGER`. В source добавлена одна миграция с четырьмя lifecycle RPC функциями.
- RU теперь поддерживает lease-bound `start`, `heartbeat`, и упорядоченные стадии `model_generated`, `qa_passed`, `pr_created`, `qa_failed`, `model_no_patch`, `model_failed`, `model_blocked`. На YDB task дополнительно требуется одноразовый claim token, а не только worker bearer; максимальные lifecycle lease ограничены 30 минутами, дальнейшее продление — двумя часами. Успешный `finish` допускает только `model_no_patch`; подтверждение `model_completed` отклоняется.
- Добавлена synthetic YDB integration последовательность для start/heartbeat/model/QA/PR стадии и проверки освобождения аренды после PR handoff. Её синтаксис и локальная имитационная часть проходят; точная последовательность против YDB пока не проверена, потому что нет локального YDB/Docker и текущий diff не опубликован для disposable GitHub Actions.
- Этот port реализует состояние очереди, но не исполняет Qwen, shell/tools или GitHub PR операции. Он не делает полную эквивалентность source workflow; независимый security review обязателен.
4. Получить бесплатное безопасное окружение с проверяемым hard stop стоимости; без него облачные ресурсы не включать. В доступных условиях гарантированного 0 ₽ cloud staging нет.
5. После статического закрытия parity выполнить disposable YDB + private S3 integration на синтетических данных, затем проверить OAuth/Postbox, IAM, backup/restore и права без подключения реальных школьных записей.

На дату документа Yandex Cloud staging не создан. Ни одна проверка здесь не разрешает публикацию, перенос реальных данных, платную подписку или изменение `main`/production.
