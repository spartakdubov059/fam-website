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

## Проверка текущего пакета и handler — 23 ноября 2026

- Из актуального tip `migration/yandex-cloud` [`ace5d5e`](https://github.com/spartakdubov059/fam-website/commit/ace5d5e340293b72d4e02a45dde25a591d5e155b) собран архив **1 025 409 байт / 141 файл**, `index.handler` и `timer.handler`, runtime `nodejs22`. Изменений `app/backend`, `app/web` или `deploy` от последнего успешного code CI [`6550992`](https://github.com/spartakdubov059/fam-website/commit/655099268ab12cadcf8be97ba95c7f5e3754afb1) до этого tip нет.
- `package-yandex-function.mjs` проверил ZIP integrity и встроенный предел 3,5 MB. Отдельный просмотр состава подтвердил наличие UI, 37 схем YDB, обоих handler wrappers и pinned lockfile; `test`, `node_modules`, `.git`, `.env`, `.pem` и `.key` в ZIP не обнаружены.
- Прямой smoke test упакованного CommonJS handler на доступном Node `24.22.3` с установленными в checkout точными версиями из lockfile прошёл: `GET /` — **200** с CSP; `/assets/banner-1.webp` — **200** в base64 WebP; `/api/health` и `/api/v1/me` без облачных adapters/учётных данных — **503** (fail closed). Старт функции не подключался к Yandex Cloud.
- В локальном окружении отсутствует `npm`, поэтому повторная свежая установка зависимостей внутри распакованного ZIP не выполнена; smoke использовал установленный набор, сверенный по версиям (`@aws-sdk/client-s3@3.1167.0`, `@ydbjs/auth@6.3.1`, `@ydbjs/core@6.3.1`, `@ydbjs/query@6.3.0`, `sharp@0.35.5`). На Node `22.23.5` остаётся действительным exact CI выше.
- Архив `FAM_RU_ycf_package_ace5d5e.zip` сохранён в локальном `outputs` вне репозитория, SHA-256 `355c097f426712ebb2a008932b18601221e5f1ea54b5a3e8b171895d1be77d98`. Он собран только для review; Cloud Function, API Gateway и платные ресурсы не создавались.
