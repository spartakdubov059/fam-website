# Дополнение к реестру миграций (2026-11-20)

Источник повторно сверён с GitHub: `main` на `af1f0086066d18b3d814dd535f06eda733ae58de`. В дереве этого коммита 78 SQL-файлов в `supabase/migrations/`. Реестр `SUPABASE_MIGRATION_INVENTORY_2026-11-20.md` содержит 73 уникальные migration-строки; ниже добавлены пять пропусков. Это дополнение не меняет исходный реестр и не доказывает полноту всей миграции.

| SQL migration | Объекты/требования | Оценка RU и доказательства |
|---|---|---|
| `20261109134709_correct_event_registration_cancellation_rpc.sql` | Состояния регистрации; резервирование места; отмена собственной активной записи; безопасный вызов RPC. | **Замена с отличием, поведение покрыто синтетическим YDB CI.** RU использует серверный `cancelEventRegistration` с actor из проверенной авторизации; отменённая запись сохраняется со статусом `cancelled`, а не удаляется. Отмена и повторная регистрация входят в event occupancy parity review в основном реестре; см. workflow #44781191568 и #44786678706. SQL-права PostgreSQL напрямую не переносятся: клиент не подключается к YDB. |
| `20261109134755_add_missing_school_workflow_foreign_key_indexes.sql` | Индексы FK для deletion requests, suspensions, council audit и school-admin requests. | **Не проверено.** Не сопоставлены все десять индексов с YDB secondary indexes/ключами запросов и планами запросов. Наличие таблиц или primary key не считается эквивалентом индекса. |
| `20261109135927_tighten_event_cancellation_and_private_agent_queue_rls.sql` | DELETE только собственной активной регистрации; приватность трёх таблиц очереди агентных задач. | **Частично.** Отмена собственной записи проходит через API и покрыта event occupancy CI. Полная изоляция таблиц очереди, эквивалентность `FORCE ROW LEVEL SECURITY` и запрет client roles не проверены как отдельный security test. |
| `20261109140920_secure_public_image_write_paths.sql` | Запрет клиентской записи в публичные image buckets и прямого изменения `avatar_url`; публикация только после серверной модерации. | **Замена с отличием, маршрут загрузки частично проверен.** RU принимает изображения в приватное pending S3-хранилище, назначает ключ на сервере, обрабатывает через Sharp и выдаёт публичное фото только через проверенный backend-путь после одобрения. CI #44793200966: 382/382 backend tests, включая совместимость SDK/Sharp; это не доказывает настройку прав реального S3 bucket. |
| `20261109142627_make_suspended_storage_guards_restrictive.sql` | Restrictive INSERT/UPDATE/DELETE guards для объектов приостановленных пользователей. | **Не проверено.** В RU не переносится PostgreSQL RLS как механизм; требуется доказать единый отказ всех media write/delete маршрутов для suspended actor и тесты каждой операции. Одного статуса приостановки в БД недостаточно. |

## Подсчёт

- Источник на зафиксированном `main`: 78 SQL migrations.
- Предыдущий реестр: 73 уникальные строки; пять строк перечислены выше.
- После добавления дополнения охвачены все 78 имён migration-файлов. Это только полнота списка. Семантический аудит всех SQL-изменений, индексов, политик, cron/worker и паритета остаётся открытым.

## Проверенные артефакты

- RU event schema: `ru-migration/app/backend/schema/06_event_registrations.yql`.
- RU registration/cancellation implementation: `ru-migration/app/backend/repositories/ydb-listings.mjs`, authenticated API routes in `ru-migration/app/backend/services/listings-api.mjs`.
- RU image staging: `ru-migration/app/backend/media/pending-images.mjs`, `ru-migration/app/backend/media/s3-pending-store.mjs`.
- Disposable YDB and SDK/Sharp CI links are recorded in `VALIDATION_2026-11-20_CI.md`. These runs use synthetic data; no production database or student records were accessed.

## Ограничение проверки

Внешний Yandex Cloud staging не создан: нет подтверждённого доступного подключения/бюджета с жёстким пределом расходов. Бесплатный тариф сам по себе не гарантирует нулевую стоимость и порог бюджета не останавливает ресурсы. Поэтому любые реальные облачные интеграции остаются незапущенными.
