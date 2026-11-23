# Точная копия исходных SQL migrations — 23 ноября 2026

Read-only source ref: `origin/main` / `6e958f65f6d59dcf7ee1711199fb553dd66c794c`.

Проверка `node ru-migration/compat/verify-source-inventory.mjs origin/main` завершилась:

```
SOURCE_MIGRATION_INVENTORY_PASS: 87 upstream files, 87 local copies, 87 inventory names; 0 blob mismatches.
```

Четыре недостающие точные SQL-копии добавлены в `source-reference/supabase-migrations`. SQL не исполнялся; YDB семантический parity новых Qwen/INSPECTOR migrations не реализован и остаётся отдельным разрывом. Qwen runtime не включён, облачные ресурсы не создавались.
