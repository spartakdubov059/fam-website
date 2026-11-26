# Исходные Supabase migration references

Файлы в `supabase-migrations/` — точные read-only SQL-копии из `spartakdubov059/fam-website` `main` на `3f2f00f9a26be8254b1a2508eb569783461b1c3a` (25 ноября 2026). Они нужны для аудита и сопоставления с FAM RU. **Не запускать в Yandex Cloud/YDB и не применять к Supabase.** Наличие копии не означает перенос поведения.

Для подтверждения полного inventory и хешей используйте `node ru-migration/compat/verify-source-inventory.mjs origin/main`. Семантические соответствия и различия фиксируются в `SUPABASE_MIGRATION_INVENTORY_2026-11-20.md`.
