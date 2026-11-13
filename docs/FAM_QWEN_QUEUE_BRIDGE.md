# Безопасное подключение Qwen к очереди FAM

Статус: базовый queue bridge уже развёрнут в production; усиленный QA/PR lifecycle и producer cooldown находятся в draft PR #65 и не применены к production. Последняя проверка: 14 ноября 2026, около 00:30 МСК.

## Цель

Подключить бесплатную локальную модель Qwen2.5-Coder к существующей очереди `private.fam_agent_tasks`, сохранив изоляцию пользовательских данных и обязательную независимую проверку любого patch.

GitHub Actions workflow уже подключён к Supabase coder bridge: live очередь содержит четыре исторические `coder_patch_request`, а event log подтверждает четыре claim от `fam-agent-qwen-coder-v1` (одна completed, три failed). Это подтверждает использование очереди, но не полный production путь Qwen → независимый QA → draft PR. Текущая main-ветка и новый lifecycle в PR #65 имеют разные гарантии; ниже они разделены.

## Граница доверия

Qwen получает только:
- один заранее разрешённый `task_key`;
- агрегированные технические значения из ограниченного набора кодов ошибок и областей сайта;
- идентификатор задания, необходимый только для завершения аренды.

Qwen никогда не получает:
- `service_role`, Supabase secret key или токен Worker;
- SQL-доступ, содержимое таблицы очереди или произвольный `payload`;
- личные сообщения, объявления, профили, email, идентификаторы пользователей, обращения и сигналы безопасности;
- сырые логи, stack trace, URL запросов или свободный текст пользователей.

Задание не должно передавать модели текст из `title`, `description` или произвольного JSON `payload`. Текст инструкции строится на стороне GitHub Actions из локального allowlist по `task_key`.

## Развёрнутая базовая интеграция и текущее улучшение

- Production migration `20261111153059_fam_agent_coder_queue_bridge` зарегистрирована; deployed Edge Function `fam-agent-coder-bridge` — v1. Endpoint без JWT gateway ранее возвращал HTTP 401 без внутреннего токена.
- Production Cron `fam-agent-coder-task-producer` активен ежедневно в 03:10 UTC; Qwen workflow расписан на 03:15 UTC. Producer читает только агрегаты `private.fam_site_error_counts`, допускает один активный coder task и использует lease до 2 часов.
- Live history показывает 4 claim события для coder worker, 1 completed и 3 failed. Значения секретов не читались; события доказывают использование claim-bridge, но не наличие текущих GitHub секретов или успех inference для каждого задания.
- В main Qwen workflow работает по расписанию и вручную; предыдущая read-only проверка подтвердила, что на пустой очереди старый workflow всё ещё запускал download/build/inference. PR #65 меняет порядок: сначала claim, модель запускается только для выданной или ручной задачи.
- PR #65 добавляет отдельный trusted QA, draft PR lifecycle, подтверждение завершения после QA/PR и regression coverage. Его миграции ещё не развёрнуты; конкретно `finish_fam_agent_coder_task` в production всё ещё может поставить `model_completed` в `completed` до QA. Для одинаковой telemetry сигнатуры в PR также добавлен 7-дневный producer cooldown с PostgreSQL 17 тестом.

## RPC: production-контракт и ограничение

Production уже содержит claim/finish RPC, доступные только `service_role`. Их ограничения и текущий дефект финализации:

### `public.claim_fam_agent_coder_tasks(text, integer, integer)`

- Фиксированный worker id: `fam-agent-qwen-coder-v1`.
- Выбирает только `agent_key='technical'`, `task_type='coder_patch_request'`, `approval_required=false`, `source IN ('system','scheduled_audit')`.
- Использует `FOR UPDATE SKIP LOCKED`, lease и ограничение batch size до 1.
- Принимает только строго ограниченный payload с ключами `task_key`, `event_code`, `page_area`, `occurrences`; неизвестные ключи блокируют задание.
- Разрешённые task keys: `audit_frontend_runtime`, `audit_client_resilience`, `audit_accessibility`.
- `event_code` и `page_area` сверяются с существующими enum-ограничениями телеметрии. `occurrences` — целое неотрицательное число в ограниченном диапазоне.
- Возвращает только `id`, `task_key`, `event_code`, `page_area`, `occurrences`. Не возвращает title, description или payload.
- Записывает событие claim без содержимого пользовательских данных.

### `public.finish_fam_agent_coder_task(uuid, text, text)` в production

- Проверяет task id, фиксированный worker id, состояние `claimed` и непросроченную аренду.
- Принимает фиксированные result codes и не принимает свободный текст модели.
- **Ограничение:** `model_completed` переводит задачу в `completed` до независимого QA и PR. Поэтому текущий production финализатор нельзя считать безопасным для patch-задач.
- PR #65 добавляет QA/PR-aware завершение с `pr_url`/`commit_sha`; соответствующие миграции проверены в PostgreSQL 17 fixture, но не применены к production.

RPC используют `SECURITY INVOKER`, пустой `search_path`, явные полные имена объектов и ограниченные grants: EXECUTE отозван у `PUBLIC/anon/authenticated` и оставлен `service_role`.

## Развёрнутый контракт Edge Function

`fam-agent-coder-bridge` принимает только POST:
- `{ "action": "claim" }`
- `{ "action": "finish", "task_id": "<uuid>", "result_code": "<allowlisted-code>" }`

Аутентификация — существующий `FAM_AGENT_WORKER_TOKEN` через заголовок `x-fam-agent-token`; сравнение секрета — constant-time. Секрет хранится только в Supabase Vault/Secrets и GitHub Actions Secrets, никогда в исходниках или логах.

Edge Function вызывает только две фиксированные RPC. Никакого произвольного имени RPC, SQL, передачи payload или проксирования запросов.

## GitHub Actions

После сборки локальной модели workflow может:
1. Если заданы `FAM_AGENT_BRIDGE_URL` и `FAM_AGENT_WORKER_TOKEN`, запросить одно задание.
2. Проверить UUID, task key и типы всех возвращённых значений.
3. Построить инструкцию только из локального allowlist.
4. Запустить существующий Qwen pipeline.
5. Отправить фиксированный result code. При аварии lease истекает и задание может быть безопасно повторено.

Если секреты не заданы или очередь пуста, текущий плановый аудит продолжает работать как раньше. Ручная задача владельца имеет приоритет над очередью.

## Проверки: подтверждённое и оставшееся

- **Unit-контракт bridge:** allowlist task keys, UUID, числовые пределы, фиксированные result codes, отсутствие свободного payload и обработка ошибок покрыты `tests/security/fam-agent-bridge.test.mjs`; свежий Regression workflow прошёл на PR head `6a6085d`.
- **SQL permissions и queue:** claim/finish restrictions и QA-aware lifecycle проходят PostgreSQL 17 integration fixture в [Coder QA run #43511906576](https://github.com/spartakdubov059/fam-website/actions/runs/43511906576). Fixture не подключается к production.
- **Edge authentication:** production запрос к bridge без внутреннего токена ранее получил HTTP 401; live history показывает, что queue claim вызывался coder worker. Значения токенов не читались.
- **Синтетический Qwen patch:** отдельный старый smoke run `#43371755985` сформировал patch на fixture и прошёл независимую regression QA; он не работал с production queue и не создавал PR из неё.
- **Остаётся не доказано:** свежий сквозной production run от реального queue claim через Qwen, trusted QA, PR creation и сохранение PR URL/SHA в production queue.
- **Остаётся не включено:** QA-aware completion migration из PR #65 и серверное owner approval для main. Не выполнять production migration или менять правила доступа в рамках этой проверки.

## Границы текущего состояния и следующий безопасный этап

- В рамках текущего аудита production менялся только чтением. Действующие worker, coder bridge, Cron и миграции были развёрнуты независимо от этой ветки; audit не менял production SQL, функции, секреты, Auth/RLS или пользовательские данные.
- Значения GitHub/Supabase секретов не читались. Исторические coder claim events подтверждают использование bridge, но не доказывают, что необходимые секреты доступны сейчас или что каждый claim завершился успешным inference.
- Текущий production `finish_fam_agent_coder_task` всё ещё может пометить `model_completed` как `completed` до QA. До рассмотрения и отдельного разрешённого rollout QA-aware миграции из PR #65 завершение задачи не подтверждает проверенный patch.
- Полный production путь Qwen → независимый QA → draft PR и post-deploy QA пока не подтверждены. PR #65 остаётся draft; активный ruleset main требует 0 approvals, поэтому owner approval gate не действует в main.
- Не включать дополнительные секреты или production migrations только на основании этого документа. Для следующего этапа сначала review PR и отдельно определить проверяемую схему запуска trusted CI и native merge approval.
