# Облачная система ИИ-агентов FAM — текущее состояние

Последняя сверка production: 13 ноября 2026, 09:17 UTC. Изменения ниже в черновых PR не считаются установленными в production.

## Карта ролей и доказательств

| Роль | Уже существует | Реально работает | Чего пока нет | Следующий шаг |
|---|---|---|---|---|
| Orchestrator | Supabase Worker, очередь и дневные Cron | Worker v17 обработал разрешённые агрегированные типы задач; все 6 `fam-agent-*` Cron были активны, последние запуски успешны | Динамического маршрутизатора ролей, дедупликации и сроков задач на уровне ИИ нет | Сохранить детерминированный безопасный контур и расширять только с отдельными проверками |
| Monitoring | Client telemetry, hourly site-error audit и Supabase health task | Worker проверяет allowlisted события, Cron и счётчики; Worker Cron запускается каждые 5 минут | Runtime-ошибки браузеров посетителей не поступают в новый Actions monitor | Draft PR #75 добавляет публичный smoke сайта и GitHub Actions каждые 30 минут; он ещё не активен |
| Analyst | Allowlisted счётчики и статическая группировка сигналов в Reporter PR | Выдаёт только помеченные гипотезы по агрегатам | Подтверждённого root cause без stack trace или дополнительных данных нет | Не выдавать гипотезы за доказанную причину |
| Coder | Qwen2.5-Coder-7B-Instruct-GGUF через llama.cpp на GitHub runner в PR #65 | Synthetic run [#43371755985](https://github.com/spartakdubov059/fam-website/actions/runs/43371755985) подготовил patch; QA проверил его на чистом checkout | Полный production queue → Qwen → QA → PR путь не подтверждён; текущие production задачи кодера ещё не дали такого результата | Сохранить ограничения путей, точные edit-операции, раздельные jobs и проверять сквозной путь после отдельного разрешённого rollout |
| QA | Required Russian content safety CI; patch QA в PR #65 | Независимый job без секретов и write-доступа применяет patch к чистой базе, запускает регрессии и проверки синтаксиса | Нет доказательств полного набора браузерных и мобильных пользовательских сценариев для каждого patch | Расширять проверки вместе с реальными тестами конкретного поведения |
| Reviewer | Статический Reviewer в PR #65 | Повторно сверяет patch, safety result, base SHA и успешный QA | Это не второй ИИ и не независимое подтверждение семантической корректности | Считать отчёт только автоматической проверкой перед draft PR |
| Security / Performance | Отдельные статические сканеры patch в PR #65 | Security блокирует известные опасные шаблоны; Performance выявляет ограниченный набор эвристик | Нет полноценного runtime security-аудита, browser profiling или измерений на устройствах | Оставлять ограничения отчётов видимыми и направлять неоднозначные случаи человеку |
| PR Manager | Workflow создаёт отдельную ветку и draft PR после QA | Текущий код не переводит PR в ready и не вызывает merge | Server-side одобрение владельца не включено: ruleset для `main` требует 0 approvals; job имеет `contents:write` и `pull-requests:write` | Настроить обязательный review в GitHub ruleset до признания merge защищённым |
| Deployment Monitor | Reporter PR читает GitHub deployment и проверяет публичный сайт | В PR #65 формируется агрегированный снимок; живые endpoints сайта были доступны при read-only проверке 09:29 UTC | Reporter migration и bridge-поля не развернуты; нет server-side gate на merge/deploy | Рассматривать Reporter только как подготовленный код до отдельного review и rollout |
| Reporter | Ежедневный приватный Reporter в PR #65 | PostgreSQL 17 integration [#43398041286](https://github.com/spartakdubov059/fam-website/actions/runs/43398041286) прошёл на изолированной БД | Production-таблица отчётов хранит прежние 4 поля; полный новый отчёт ещё не пишется | Проверить миграцию и bridge отдельно; не применять их к production автоматически |

## Production-снимок

- Supabase project `tfacqpljrvfpcrhdovbu` был `ACTIVE_HEALTHY`, PostgreSQL 17.11.
- Шесть агентских Cron были активны; последний Worker запуск в 09:15 UTC завершился успешно. Worker запускается каждые 5 минут — это периодический polling, не непрерывный мониторинг.
- Очередь содержала 81 задачу: 78 `completed`, 3 `failed`. Среди 4 `coder_patch_request`: 1 завершена, 3 завершились ошибкой после одной попытки; у всех `max_attempts=2`.
- Edge Functions: `fam-agent-worker` v17 и `fam-agent-coder-bridge` v1. Reporter и bounded retry migrations из PR #65/#74 не применены.
- Draft PR #65 содержит Reporter и новый coder pipeline; draft PR #74 — ограниченный retry; draft PR #75 — Actions/site monitor. Ни один не объединён. Production DB, Functions, Auth/RLS, данные и настройки не менялись.

## Модель, расходы и ограничения

Qwen запускается на временном GitHub runner и вызывается только когда очередь или владелец предоставляют задачу; при пустой очереди скачивание модели и сборка llama.cpp пропускаются. Workflow использует открытые веса и не подключает платный inference API. Patch ограничен разрешёнными клиентскими и документационными путями, проверяется отдельно и не применяется к `main` напрямую.

Статический Reviewer, Security и Performance не являются независимыми ИИ-моделями. Synthetic patch run доказывает работу тестового пути, но не доказывает автоматическую обработку production-задач.

**Merge gate не завершён.** Draft-state и отсутствие команды merge в текущем workflow не заменяют серверное правило: имеющий write-доступ token может обратиться к GitHub API, а ruleset допускает 0 approving reviews. Из доступной read-only GitHub интеграции изменить ruleset нельзя. Не утверждать, что владелец защищён от обхода прямым API, пока в GitHub не включено обязательное approving review.

## Доказательства

- Синтетический patch и QA: [Actions run #43371755985](https://github.com/spartakdubov059/fam-website/actions/runs/43371755985).
- Reporter PostgreSQL 17 fixture: [Actions run #43398041286](https://github.com/spartakdubov059/fam-website/actions/runs/43398041286).
- Bounded retry PostgreSQL 17 fixture: [Actions run #43393080561](https://github.com/spartakdubov059/fam-website/actions/runs/43393080561).
- Облачный monitor regressions, включая зависшие workflow: [Actions run #43402532087](https://github.com/spartakdubov059/fam-website/actions/runs/43402532087).
