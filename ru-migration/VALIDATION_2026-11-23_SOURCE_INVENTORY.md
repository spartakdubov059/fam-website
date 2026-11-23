# Проверка исходных SQL-миграций — 23 ноября 2026

Для FAM `main` `241e3d302f4afcceb57a75a977053fa1125d8a9a` выполнена локальная read-only проверка списка и Git blob SHA всех `supabase/migrations/*.sql`:

```text
SOURCE_MIGRATION_INVENTORY_PASS: 83 upstream files, 83 local copies, 83 inventory names; 0 blob mismatches.
Source ref: origin/main (241e3d302f4afcceb57a75a977053fa1125d8a9a). SQL was read and hashed only; no migrations were executed.
```

Проверка состоит из 80 SQL-файлов в source checkout, трёх исходных файлов в `source-reference/supabase-migrations`, 83 уникальных имён в `SUPABASE_MIGRATION_INVENTORY_2026-11-20.md` и сравнения blob SHA с Git tree `origin/main`.

Повторить после `git fetch origin main`:

```sh
node ru-migration/compat/verify-source-inventory.mjs origin/main
```

Валидатор доказывает только полноту перечня и побайтовое соответствие SQL-файлов указанному Git ref. Он не применяет SQL, не определяет результирующие PostgreSQL grants/RLS/RPC и не доказывает семантический паритет с YDB. `psql`, PostgreSQL server и контейнерный runtime в этой среде не обнаружены, поэтому итоговый каталог PostgreSQL не проверен.
