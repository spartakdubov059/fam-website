# Безопасное подключение Qwen к очереди FAM

Статус: проектирование завершено; production-изменения не применялись.

## Цель

Подключить бесплатную локальную модель Qwen2.5-Coder к существующей очереди `private.fam_agent_tasks`, сохранив изоляцию пользовательских данных и обязательную независимую проверку любого patch.

Сейчас Qwen запускается в GitHub Actions и анализирует репозиторий по расписанию или ручной задаче. Он **не получает задания из Supabase**. Этот документ фиксирует безопасный контракт для следующего этапа.

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

## Контракт RPC (предлагаемый)

Нужны две новые функции, доступные только `service_role`:

### `public.claim_fam_agent_coder_tasks(text, integer, integer)`

- Фиксированный worker id: `fam-agent-qwen-coder-v1`.
- Выбирает только `agent_key='technical'`, `task_type='coder_patch_request'`, `approval_required=false`, `source IN ('system','scheduled_audit')`.
- Использует `FOR UPDATE SKIP LOCKED`, lease и ограничение batch size до 1.
- Принимает только строго ограниченный payload с ключами `task_key`, `event_code`, `page_area`, `occurrences`; неизвестные ключи блокируют задание.
- Разрешённые task keys: `audit_frontend_runtime`, `audit_client_resilience`, `audit_accessibility`.
- `event_code` и `page_area` сверяются с существующими enum-ограничениями телеметрии. `occurrences` — целое неотрицательное число в ограниченном диапазоне.
- Возвращает только `id`, `task_key`, `event_code`, `page_area`, `occurrences`. Не возвращает title, description или payload.
- Записывает событие claim без содержимого пользовательских данных.

### `public.finish_fam_agent_coder_task(uuid, text, text)`

- Проверяет точное совпадение task id, фиксированного worker id, состояния `claimed` и непросроченной аренды.
- Разрешённые result codes: `model_completed`, `model_no_patch`, `model_failed`, `model_blocked`.
- В БД записывает заранее определённое короткое описание по result code; не принимает свободный текст модели.
- Не объединяет PR и не публикует изменения.

Обе функции должны быть `SECURITY INVOKER`, с пустым `search_path`, явными полными именами объектов, отзывом EXECUTE у `PUBLIC/anon/authenticated` и выдачей EXECUTE только `service_role`.

## Контракт Edge Function

Новая функция `fam-agent-coder-bridge` принимает только POST:
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

## Обязательные проверки до включения

- unit tests на allowlist task keys, payload keys, enum-коды, числовые границы, UUID, invalid result codes и oversized request;
- SQL tests: нельзя claim-ить задачи с approval_required=true, неправильным agent/task type, неизвестными payload keys, истёкшими попытками или уже действующей арендой;
- тест, что RPC не возвращают title/description/payload и не дают EXECUTE anon/authenticated;
- Edge Function smoke test с неверным и верным токеном;
- GitHub Actions run без секретов (старый режим) и с секретами (очередь);
- подтверждение, что независимый QA job по-прежнему запускается отдельно и никакое авто-merge/production deploy не добавлено.

## Что намеренно не сделано

- Production SQL не выполнялся, миграция не применялась.
- Edge Function не развёртывалась.
- Секреты GitHub не создавались и не запрашивались в чате.
- Существующий Worker и пользовательские роли/RLS не менялись.
- Qwen не получил права на merge, deploy, Auth, RLS, миграции или изменение секретов.

Перед активацией нужен отдельный просмотр SQL-миграции и явное подтверждение её применения к production. После этого можно подключить GitHub Actions secret через интерфейс GitHub без передачи секрета в чат.
