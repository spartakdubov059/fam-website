# Сверка миграций с исходным main — 25 ноября 2026

Read-only ref `origin/main`: `3f2f00f9a26be8254b1a2508eb569783461b1c3a`.

Команда `node ru-migration/compat/verify-source-inventory.mjs origin/main` сверяет каждый файл миграции из текущего исходного `main` с точной копией и с именами в инвентаре. SQL только читается и хешируется; никакая миграция не запускалась.
