# FAM — Свои рядом

FAM — школьная платформа для объявлений, идей и полезных инициатив.

## Документация проекта

- [Рабочие роли команды и план внедрения](docs/AGENT_ROLES.md)
- [Журнал изменений](CHANGELOG.md)
- [Серверная модерация](supabase/functions/moderate/index.ts), [Эксперт FAM](supabase/functions/moderate/dispute-reviewer.ts), [агент фотографий](supabase/functions/moderate/image-reviewer.ts) и [агент безопасности участников](supabase/functions/moderate/user-safety-agent.ts)
- [GitHub Actions: тесты модерации](.github/workflows/moderation-regression.yml)
- [Автоматические тесты модерации](tests/moderation/content-safety.test.mjs)
- [Локальный модуль контактной и тематической проверки](supabase/functions/moderate/content-safety.js)
- [Отправка пользовательского контента](supabase/functions/submit-content/index.ts)
- [Иерархия агентов и правила безопасности](docs/AGENT_ROLES.md)
- [Журнал безопасности и приватных фото](supabase/migrations/20261108202805_add_fam_safety_incidents_and_private_image_staging.sql)

## Правила безопасности

- Секретные API-ключи хранятся только в серверных Secrets Edge Functions.
- Не помещайте ключи, токены и реальные персональные данные в репозиторий.
- Не считайте материал проверенным, если модерация вернула ошибку или состояние ожидания.
- Изменения политик доступа, базы данных и серверных функций должны проходить проверку и фиксироваться в журнале изменений.

- [Русскоязычные тестовые примеры модерации](tests/moderation/cases.json)

## Локальные проверки модерации

Запуск регрессионных тестов контактных данных и локальных правил:

```bash
node --test tests/moderation/*.test.mjs
```

- [Проверка доступа Ученического совета](supabase/functions/school-admin-access/index.ts)
- [Фоновый исполнитель безопасных задач FAM](supabase/functions/fam-agent-worker/index.ts)

Фоновый исполнитель намеренно использует отдельный секрет `FAM_AGENT_WORKER_TOKEN` вместо пользовательского JWT (`verify_jwt=false` в настройках функции). Без корректного серверного токена он отвечает отказом; его SQL-очередь независимо разрешает только безопасную проверку очереди без пользовательских данных. Не размещайте этот токен в браузерном коде или репозитории.
