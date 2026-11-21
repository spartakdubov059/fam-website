# Проверка текущего RU снимка на Node 22 — 21 ноября 2026

Проверен HEAD `1b5d45916c4500042d49f9000febdcfa22900a01` локальной изолированной ветки `codex/fam-ru-progress-20261120`. Это не проверка или изменение production.

## Среда и результаты

- Официальный архив Node.js `22.15.0` для macOS ARM64 загружен с `nodejs.org`; SHA-256 `6e278a107d50da24b644dd26810a639a5f8ca67b55086e6b693caabcbb759912` совпал с `SHASUMS256.txt`. Версии: Node `v22.15.0`, npm `10.9.2`.
- Backend: `npm ci` установил 87 пакетов; npm сообщил 0 vulnerabilities. `npm test` завершился успешно: **426/426**.
- Compat: `npm ci` установил 88 пакетов; npm сообщил 0 vulnerabilities. `npm run check` завершился `SDK_COMPAT_PASS` для закреплённых YDB/AWS SDK и Sharp/WebP.
- Все 8 timer-файлов прошли `verify-systemd-timers.mjs` portable subset parser. На macOS нет `systemd-analyze`, поэтому системная проверка календарей не выполнялась.
- YDB disposable integration, GitHub CI для точного HEAD и облачный staging не выполнялись. Проверка совместимости SDK и локальные unit/UI тесты не доказывают работоспособность OAuth, YDB IAM, российского S3, API Gateway или расписаний в облаке.
- Полный security scan не завершился: Security workbench превысил 300-секундный таймаут и не вернул авторитетный scan ID/результат. Полного независимого security sign-off нет.
- Временный Node runtime хранится вне репозитория в `/tmp/fam-ru-node22-check`. `main`, remote `migration/yandex-cloud`, production, реальные данные учеников и облачные ресурсы не изменялись.
