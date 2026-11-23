# Исходные Supabase migration references

Снимок взят read-only из `spartakdubov059/fam-website` на `main` `bdb8325843f4d02590723d396d5b3f803d04618a` 23 ноября 2026 года. Эти три файла сохранены только для аудита и source-to-RU crosswalk. **Не запускать в Yandex Cloud/YDB и не применять к Supabase.** RU-эквиваленты реализуются отдельно в `app/backend` и `app/backend/schema`; поведенческие отличия и проверки описаны в `SUPABASE_MIGRATION_INVENTORY_2026-11-20.md`.

Файловые Git blob SHA сверены с GitHub:

- `20261123001553_fam_qwen_lease_and_lifecycle.sql`: `064767e7631d8e1176250c04c6ae196a75e0e8c8`
- `20261123013000_fam_qwen_retry_recovery.sql`: `21d441622576eb15feca86cea99419f21afb4cdb`
- `20261123013500_fam_agent_task_metrics.sql`: `9f56490135f37c2d694a7d3dd8445ee32193ceae`
