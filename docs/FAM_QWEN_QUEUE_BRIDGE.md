# Безопасное подключение Qwen к очереди FAM

Статус: реализация подготовлена в PR #38; production-миграция и Edge Function ещё не применялись/не развёртывались.

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

## Реализация в PR #38\n\nПодготовлены файлы:\n- `supabase/migrations/20261111170000_fam_agent_coder_queue_bridge.sql` — две RPC, privacy-safe producer и ежедневное Cron-расписание.\n- `supabase/functions/fam-agent-coder-bridge/index.ts` — POST-only мост с ограниченным телом запроса, проверкой токена и фиксированными RPC.\n- `scripts/fam-agent-bridge.mjs` — клиент GitHub Actions с локальным allowlist инструкций и фиксированными result codes.\n- `tests/security/fam-agent-bridge.test.mjs` — тесты формы задания, UUID, диапазонов, кодов результата и клиента моста.\n- `.github/workflows/fam-codex-developer.yml` — опциональный claim/finish; если секреты отсутствуют или очередь пуста, сохраняется прежний режим.\n\nПроизводитель запускается ежедневно в 03:10 UTC, Qwen workflow — в 03:15 UTC. Производитель использует только агрегаты `private.fam_site_error_counts` и создаёт не более одного активного coder-задания. Аренда задания — до 2 часов.\n\n## Контракт RPC (предлагаемый)

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
\n\n## Текущий статус активации\n\nКод подготовлен в ветке PR, но ещё не активирован в production. Для включения потребуется: (1) проверить и отдельно подтвердить применение SQL-миграции, которая также создаёт Cron job; (2) развернуть `fam-agent-coder-bridge` с `--no-verify-jwt` и существующими `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`/service key и `FAM_AGENT_WORKER_TOKEN`; (3) добавить в GitHub Actions secrets `FAM_AGENT_BRIDGE_URL` и `FAM_AGENT_WORKER_TOKEN` через интерфейс GitHub. Секрет не передавать в чат. После этого выполнить ручной workflow_dispatch и проверить claim/finish, не разрешая автоматическое объединение PR.\n