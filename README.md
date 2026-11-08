# FAM — Свои рядом

FAM — школьная платформа для объявлений, идей и полезных инициатив.

## Документация проекта

- [Рабочие роли команды и план внедрения](docs/AGENT_ROLES.md)
- [Журнал изменений](CHANGELOG.md)
- [Серверная модерация](supabase/functions/moderate/index.ts) и [второй ИИ-эксперт](supabase/functions/moderate/dispute-reviewer.ts)
- [GitHub Actions: тесты модерации](.github/workflows/moderation-regression.yml)
- [Автоматические тесты модерации](tests/moderation/content-safety.test.mjs)
- [Локальный модуль контактной и тематической проверки](supabase/functions/moderate/content-safety.js)
- [Отправка пользовательского контента](supabase/functions/submit-content/index.ts)

## Правила безопасности

- Секретные API-ключи хранятся только в серверных Secrets Edge Functions.
- Не помещайте ключи, токены и реальные персональные данные в репозиторий.
- Не считайте материал проверенным, если модерация вернула ошибку или состояние ожидания.
- Изменения политик доступа, базы данных и серверных функций должны проходить проверку и фиксироваться в журнале изменений.

- [Русскоязычные тестовые примеры модерации](tests/moderation/cases.json)

## Локальные проверки модерации

Запуск регрессионных тестов контактных данных и локальных правил:

```bash
node --test tests/moderation/*.test.mjs tests/security/*.test.mjs
```

- [Проверка доступа Ученического совета](supabase/functions/school-admin-access/index.ts)
