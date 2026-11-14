# FAM AI Agents — актуальный контрольный статус

Снимок: 14 ноября 2026, 02:36 МСК. Проверки GitHub и Supabase выполнялись read-only. Изменения внесены только в открытый draft PR #65.

## Текущее состояние

- Supabase project `tfacqpljrvfpcrhdovbu`: `ACTIVE_HEALTHY`, PostgreSQL 17.11, регион `eu-central-1`. Активны 7 Edge Functions и 8 Cron. `fam-agent-worker` остаётся v17, `fam-agent-coder-bridge` — v1.
- За последние 7 дней worker Cron имел 944/944 успешных запусков. Это подтверждает успешные вызовы расписания, не результат каждой задачи.
- Production `coder_patch_request`: 1 `completed`, 3 `failed`; новых coder-задач нет. Последний daily report в legacy-таблице создан 13 ноября 04:00 UTC. Migration ledger заканчивается `20261113215610`; миграции PR #65/#74 в production не применены.
- Production Security Advisor сообщает 4 RLS-enabled таблицы без policy, `pg_net` в `public`, одну anon-доступную SECURITY DEFINER telemetry RPC, четыре authenticated School Pulse SECURITY DEFINER RPC и выключенную leaked-password protection. Performance Advisor сообщает 4 unindexed FK и 24 unused-index notices; Health Advisor пуст. Права, Auth, индексы и политики не менялись.
- Read-only HTTP probe публичного сайта `https://spartakdubov059.github.io/fam-website/` вернул 200.

## GitHub и проверки

- `main`: `7a463458ba5ca2d9be2bf67d4f5931271e2c3478`.
- [PR #65](https://github.com/spartakdubov059/fam-website/pull/65): open, draft, mergeable; head `bc5dd0195d1e96ed0b50979888887483ae4d6aae`. Regression, owner approval verifier, Coder QA PostgreSQL, Reporter PostgreSQL, telemetry PostgreSQL и Russian content safety прошли. Netlify deploy preview готов. PR не объединён.
- [PR #74](https://github.com/spartakdubov059/fam-website/pull/74): open, готов к review, mergeable.
- [PR #75](https://github.com/spartakdubov059/fam-website/pull/75): open, draft, mergeable.
- Локально на Node 22 прошёл полный moderation/security набор: 284/284. Worker suite отдельно: 8/8.

## Проверенные ограничения

- В PR #65 Worker теперь прекращает запрос ошибкой, если RPC завершения вернул не `true`. Production Worker остаётся v17, поэтому исправление там не действует до отдельного rollout.
- Два hosted synthetic Qwen runs на SHA `7c1439c297df0ec08036356b317bc60b2d8dc055` реально выполнили скачивание/проверку Qwen2.5 весов, сборку pinned `llama.cpp`, генерацию точного patch и независимую QA на чистом fixture; оба job успешны и сохранили `fam-qwen-exact-edit-smoke` artifact: [push run](https://github.com/spartakdubov059/fam-website/actions/runs/43445287038), [PR run](https://github.com/spartakdubov059/fam-website/actions/runs/43445293786). Это доказывает синтетический model path, но не production queue → Qwen → QA → PR; свежих production coder-задач нет.
- Отдельный локальный synthetic pipeline тест покрывает trusted QA, статические Reviewer/Security/Performance-проверки и finish bridge.
- Reviewer, Security и Performance являются статическими/тестовыми проверками, не независимыми ИИ-моделями. Публичный `main` ruleset требует 0 одобрений; owner gate из PR #65 не действует на main до отдельного принятия/настройки.
- Нативный HTTP-ответ production Worker при `finish_fam_agent_task=false` не проверялся, поскольку это потребовало бы изменения/развёртывания production. Конфигурация существующей ChatGPT automation не найдена в доступных локальных файлах/API; карточка automation была открыта, но настройки прочитать не удалось.

Production, `main`, миграции, Cron, Auth/RLS, secrets, очередь и пользовательские данные этим аудитом не менялись.

## Read-only повторная сверка — 14 ноября 2026, 12:09 UTC

- В фактической схеме очередь находится в `private.fam_agent_tasks`; запросы читали только статусы/времена и поля управления, без payload, result summary и пользовательских данных. В `coder_patch_request` по-прежнему 1 `completed` и 3 `failed`; все четыре задачи созданы 11 ноября. Последняя завершённая — `audit_frontend_runtime` в 19:26 UTC; последний `audit_accessibility` завершился failed в 19:52 UTC. С 11 ноября новых coder-задач нет.
- Очередь также показывает ежедневные `daily_report_digest` и `system_health_check` со статусом completed, а `site_error_digest` продолжает завершаться примерно раз в час. Последний daily digest завершился 14 ноября в 04:00:02 UTC.
- Все 8 активных Cron на момент снимка имели последний статус `succeeded`. Это подтверждает последний запуск каждого задания, а не полноту каждого результата или непрерывное наблюдение.
- Migration ledger всё ещё заканчивается `20261113215610` (72 записи); миграции PR #65/#74 не применялись.
- PR #65 остаётся open/draft/mergeable на head `82bd7a3d774173ecee2f03a1cb13d9e3a9ebab04`. На этом SHA успешно завершились Regression suite, Russian content safety tests, owner approval verifier и PostgreSQL Coder QA, Reporter и telemetry интеграции; Netlify preview готов. PR не объединён.
- Эти данные подтверждают работоспособность расписания и ежедневной агрегированной отчётности, но не production запуск coder-модели: очередь не выдала новых заданий после 11 ноября. Worker v17 и production finish RPC остаются без изменений; исправления PR не действуют в production.

Все запросы в этой сверке были read-only; production, `main`, конфигурация GitHub и пользовательские данные не менялись.

## Подтверждение правил защиты main через GitHub API — 14 ноября 2026, 12:10 UTC

- Анонимный read-only GitHub REST API вернул активный repository ruleset `FAM — защита main` (ID `27066766`), применённый только к `refs/heads/main`.
- Он запрещает удаление и non-fast-forward, разрешает только squash merge, требует status check `Russian content safety tests` и не задаёт bypass actors.
- Параметры pull request: `required_approving_review_count=0`, stale approvals не dismiss-ятся, code-owner review и approval последнего push выключены. Следовательно, обязательная проверка статуса сама по себе не требует review для всех PR.
- Встроенная workflow-проверка дополнительно требует актуальное одобрение владельца только для веток `codex/fam-run-*`; она не заменяет общее серверное правило branch protection.
- Подключённый GitHub API credential не имеет доступной операции обновления ruleset, а GitHub web app в доступной UI-сессии не открыл страницу настроек. Конфигурацию не менял. Требуется отдельный authorized write path для установки хотя бы одного обязательного approving review; пользователь ранее разрешил выбрать рациональное усиление.

## Сверка live coder contracts и PR — 14 ноября 2026, 12:16 UTC

- Supabase source read-only: `fam-agent-worker` остаётся ACTIVE v17, SHA-256 `07340a16acfcb08fa38e292292a89ac2da49b0b231dfc6e5fac415ddd57a5a5c`; `fam-agent-coder-bridge` остаётся ACTIVE v1, SHA-256 `ad27b05de9e35a07ec8e0eb2ab066a16568ecf1afc5f22f4387a908d0efd1ed6`.
- В production Worker v17 результат `finish_fam_agent_task` учитывается только при `saved === true`, но `false` не приводит к исключению; handler продолжает цикл и может вернуть HTTP 200 с `ok:true`. Это позволяет расписанию выглядеть успешным при несохранённой задаче.
- Реальное production `public.finish_fam_agent_coder_task` — SECURITY INVOKER с пустым `search_path`. Оно переводит `model_completed` прямо в `completed`, хотя текст результата говорит, что исправление ещё ожидает независимой проверки. Production bridge v1 принимает только старые коды `model_completed/model_no_patch/model_failed/model_blocked` и вызывает только этот RPC.
- PR #65 заменяет Worker finish на fail-closed helper. Для coder queue PR добавляет отдельный `finish_fam_agent_coder_task_with_pr`, новые коды `model_review/model_timeout` и фиксирует завершение patch-задачи после trusted QA, создания draft PR и обязательного check. Этот контракт остаётся только в PR до отдельного безопасного rollout; production функции, bridge и схема не изменялись.
- На текущем локальном HEAD целевые тесты Worker, coder bridge и workflow прошли 45/45; latest hosted Regression, owner gate, три PostgreSQL интеграции и Russian content safety также прошли на PR head `a1f8ef482cbcf00df10e8adee2592fff338c293c`.

Live source и SQL определения читались без вызова RPC, секретов и пользовательских данных. Production не менялся.
