# FAM RU — реестр фоновых заданий

Сверено с SQL-миграциями исходного FAM. Расписания выражены в UTC, как настроен исходный `pg_cron`. Ни одно задание не включается автоматически в российской копии: сначала должны быть перенесены вызываемые процедуры, проверены права и повторы, затем выполнены синтетические интеграционные проверки.

| Задание | UTC cron | Исходная процедура/вызов | Исходная миграция | Статус переноса |
|---|---:|---|---|---|
| `fam-agent-coder-task-producer` | `10 3 * * *` | `private.enqueue_fam_agent_coder_task()` | `20261111153059_fam_agent_coder_queue_bridge.sql` | Не перенесено |
| `fam-agent-orchestrator-daily-digest` | `5 6 * * *` | `private.refresh_and_enqueue_fam_agent_daily_digest()` | `20261110170529_route_daily_operational_report_to_orchestrator.sql` | Не перенесено |
| `fam-agent-technical-system-health` | `10 6 * * *` | `private.enqueue_fam_agent_system_health_check()` | `20261110171353_add_read_only_fam_technical_health_agent.sql` | Не перенесено |
| `fam-agent-site-error-audit` | `*/15 * * * *` | `private.enqueue_fam_agent_site_error_digest()` | `20261110173255_fam_site_error_monitoring.sql` | Не перенесено |
| `fam-agent-school-daily-report` | `0 6 * * *` | `private.refresh_fam_agent_school_daily_reports()` | `20261109152842_school_scoped_agent_reports_and_free_analysts.sql` | Не перенесено |
| `fam-listing-image-moderation-every-minute` | `* * * * *` | HTTP POST в исходный Supabase Edge Function `fam-listing-image-worker` | `20261110210025_add_persistent_listing_image_review_queue.sql` | Не переносить исходный URL; функция/очередь не перенесены |
| `fam-agent-daily-report` | `0 6 * * *` | `private.refresh_fam_agent_daily_report()` | `20261109144741_create_fam_agent_daily_reports.sql` | Не перенесено |

## Безопасная очистка загрузок

Российский backend дополнительно удаляет приватные загрузки объявлений, которые старше семи дней, не привязаны к объявлению и успешно получены из YDB через временную lease. Для уже установленного изолированного Linux-хоста подготовлены выключенные по умолчанию units: `deploy/systemd/fam-ru-pending-media-cleanup.timer` запускает cleanup каждые шесть часов по UTC, а service запускает `cleanup-pending-media.mjs` отдельным непривилегированным пользователем. Timer не включался и не устанавливался; сначала требуются проверенная бесплатная среда, настройки Яндекс ID/YDB/S3 и интеграционная проверка на синтетических данных. Этот сервисный таймер не заменяет семь перечисленных выше заданий FAM.

## Условия переноса

- Реализовать каждую процедуру на российском backend и явно закрепить идемпотентность, блокировки, повторы и журналирование.
- Заменить прямой вызов Supabase Edge Function внутренним российским обработчиком после переноса и проверки очереди изображений.
- Рассчитать расписания в UTC, отдельно документировать нужное московское время.
- До полного переноса всех обработчиков оставить задания выключенными. Не добавлять облачные cron-сервисы, платные функции или тестовые вызовы исходных production URL.
- Запускать только в одноразовом окружении и на синтетических данных; провайдерские задания по отчётам и агентам могут обращаться к внешним моделям и отдельно требуют проверки отсутствия расходов.
