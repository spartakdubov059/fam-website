# Проверка текущего RU снимка на Node 22 — 21 ноября 2026

Первый полный прогон был выполнен на кодовом снимке `1b5d45916c4500042d49f9000febdcfa22900a01`. После него добавлена проверка приватности школьной доски; кодовый commit [`575491ffe354472371205e59fb5da12790659229`](https://github.com/spartakdubov059/fam-website/commit/575491ffe354472371205e59fb5da12790659229) прошёл CI, а локальный повтор на текущем совпадающем дереве `f65fe0700a668ac1a2268adb71d980c9cfaaa3f4` прошёл **430/430**. Проверка касается изолированной ветки; это не проверка или изменение production.

## Среда и результаты

- Официальный архив Node.js `22.15.0` для macOS ARM64 загружен с `nodejs.org`; SHA-256 `6e278a107d50da24b644dd26810a639a5f8ca67b55086e6b693caabcbb759912` совпал с `SHASUMS256.txt`. Версии: Node `v22.15.0`, npm `10.9.2`.
- Backend: `npm ci` установил 87 пакетов; npm сообщил 0 vulnerabilities. `npm test` на исходном Node 22 снимке завершился успешно: **426/426**. Повтор на текущем кодовом дереве завершился **430/430**; полный вывод завершения содержал `# pass 430`, `# fail 0`.
- Compat: `npm ci` установил 88 пакетов; npm сообщил 0 vulnerabilities. `npm run check` завершился `SDK_COMPAT_PASS` для закреплённых YDB/AWS SDK и Sharp/WebP.
- Все 8 timer-файлов прошли `verify-systemd-timers.mjs` portable subset parser. На macOS нет `systemd-analyze`, поэтому системная проверка календарей не выполнялась.
- На точном GitHub code commit `575491ffe354472371205e59fb5da12790659229` оба workflow завершились `success`: [SDK/Sharp/package #44941925377](https://github.com/spartakdubov059/fam-website/actions/runs/44941925377) и [локальная YDB integration #44941925237](https://github.com/spartakdubov059/fam-website/actions/runs/44941925237). Первый собрал YCF ZIP, установил lockfiles, выполнил backend suite, проверил timer-файлы и нативный Sharp/SDK. Второй запустил disposable `ydbplatform/local-ydb` с закреплённым digest, применил RU схемы 01–33, выполнил synthetic integration и удалил контейнер.
- Облачный staging не выполнялся. Disposable local YDB и проверки совместимости SDK не доказывают работоспособность OAuth, YDB IAM, российского S3, API Gateway или расписаний в облаке.
- Полный security scan не завершился: Security workbench превысил 300-секундный таймаут и не вернул авторитетный scan ID/результат. Полного независимого security sign-off нет.
- Временный Node runtime хранится вне репозитория в `/tmp/fam-ru-node22-check`. `main`, production, реальные данные учеников и облачные ресурсы не изменялись. Remote `migration/yandex-cloud` получил только кодовые изменения в своей изолированной ветке и последующие документы.
