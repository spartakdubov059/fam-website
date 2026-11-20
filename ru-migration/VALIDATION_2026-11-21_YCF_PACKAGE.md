# Проверка пакета Yandex Cloud Functions — 21 ноября 2026

Исходный код: [`6018da0093349d189265b1b1a08516346db40d89`](https://github.com/spartakdubov059/fam-website/commit/6018da0093349d189265b1b1a08516346db40d89), ветка `migration/yandex-cloud`. При сборке документов использовался branch tip `a1693f21d630bf224efa0fb9d00d00d5ed8934fa`; пакетировщик копирует только `app/backend` и `app/web`, код с момента `6018da0` не менялся.

## Результат

- `node ru-migration/deploy/package-yandex-function.mjs /tmp/fam-ru-ycf-a1693f21.zip`: архив **997 138 байт**, **127 файлов**, handler `index.handler`, runtime `nodejs22`; ZIP integrity прошла, размер меньше встроенного лимита 3.5 MB.
- Архив содержит RU HTML, backend entrypoint `yandex-function.mjs`, CommonJS wrapper `index.cjs` и lockfile. Исключённые директории и секреты сборщиком не включены.
- В распакованном архиве `npm ci --omit=dev` на **Node 22.15.0 / npm 10.9.2** завершился успешно: 87 пакетов установлено, npm audit — **0 vulnerabilities**. Node binary скачан из официального архива и SHA-256 проверен: `92eb58f54d172ed9dee320b8450f1390db629d4262c936d5c074b25a110fed02`.
- Точный packaged `index.cjs` / `index.handler` на Node 22.15.0: `GET /` вернул 200 с RU интерфейсом; WebP вернул 200 как base64 binary; `/api/health` и приватный `/api/v1/me` без credentials/adapters вернули 503 (fail closed).
- Полный backend набор на Node 22.15.0 из checkout того же code snapshot: **413/413**, SDK verifier и `git diff --check` прошли.

Это локальная проверка сборки и serverless event adapter, не вызов Yandex Cloud Function. Yandex API Gateway, OAuth, YDB, S3, DNS/HTTPS, IAM и расходы не проверялись. Пакет лежит только во временном каталоге `/tmp`; cloud resource не создавался.
