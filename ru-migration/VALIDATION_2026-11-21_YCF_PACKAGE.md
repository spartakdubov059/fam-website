# Проверка пакета Yandex Cloud Functions — 21 ноября 2026

## Повторная проверка текущего локального кода

После CI-снимка ниже пакет повторно собран из кода HEAD `1b5d45916c4500042d49f9000febdcfa22900a01`; поздний commit `954c1c06` меняет только документацию. Официальный Node `22.15.0` macOS ARM64 проверен SHA-256 `6e278a107d50da24b644dd26810a639a5f8ca67b55086e6b693caabcbb759912`. Архив текущего пакета — **997 829 байт**, **127 файлов**, `index.handler`, runtime `nodejs22`; `npm ci --omit=dev` установил 87 пакетов, 0 vulnerabilities. Прямой вызов packaged handler на синтетических запросах вернул `GET /` — 200, `/assets/banner-1.webp` — 200 с base64, `/api/health` и `/api/v1/me` без credentials — 503 (fail closed). Пакет: `/tmp/fam-ru-ycf-current-954c1c06.zip`. Облачная функция не создавалась и не вызывалась.

Исходный код: [`6018da0093349d189265b1b1a08516346db40d89`](https://github.com/spartakdubov059/fam-website/commit/6018da0093349d189265b1b1a08516346db40d89), ветка `migration/yandex-cloud`. При сборке документов использовался branch tip `a1693f21d630bf224efa0fb9d00d00d5ed8934fa`; пакетировщик копирует только `app/backend` и `app/web`, код с момента `6018da0` не менялся.

## Результат

- `node ru-migration/deploy/package-yandex-function.mjs /tmp/fam-ru-ycf-a1693f21.zip`: архив **997 138 байт**, **127 файлов**, handler `index.handler`, runtime `nodejs22`; ZIP integrity прошла, размер меньше встроенного лимита 3.5 MB.
- Архив содержит RU HTML, backend entrypoint `yandex-function.mjs`, CommonJS wrapper `index.cjs` и lockfile. Исключённые директории и секреты сборщиком не включены.
- В распакованном архиве `npm ci --omit=dev` на **Node 22.15.0 / npm 10.9.2** завершился успешно: 87 пакетов установлено, npm audit — **0 vulnerabilities**. Node binary скачан из официального архива и SHA-256 проверен: `92eb58f54d172ed9dee320b8450f1390db629d4262c936d5c074b25a110fed02`.
- Точный packaged `index.cjs` / `index.handler` на Node 22.15.0: `GET /` вернул 200 с RU интерфейсом; WebP вернул 200 как base64 binary; `/api/health` и приватный `/api/v1/me` без credentials/adapters вернули 503 (fail closed).
- Полный backend набор на Node 22.15.0 из checkout того же code snapshot: **413/413**, SDK verifier и `git diff --check` прошли.
- На точном кодовом коммите [`6018da0093349d189265b1b1a08516346db40d89`](https://github.com/spartakdubov059/fam-website/commit/6018da0093349d189265b1b1a08516346db40d89) успешно завершились оба GitHub Actions workflow: [YDB integration #44828915964](https://github.com/spartakdubov059/fam-website/actions/runs/44828915964) и [SDK/Sharp/package #44828915937](https://github.com/spartakdubov059/fam-website/actions/runs/44828915937). В первом workflow шаги старта/удаления disposable DB и синтетической интеграции — success; во втором успешно завершились сборка пакета, locked installs, backend suite, systemd timer checks и native image/SDK checks.

Это локальная проверка сборки и serverless event adapter, не вызов Yandex Cloud Function. Yandex API Gateway, OAuth, YDB, S3, DNS/HTTPS, IAM и расходы не проверялись. Пакет лежит только во временном каталоге `/tmp`; cloud resource не создавался.
