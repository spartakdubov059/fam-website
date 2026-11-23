# Адаптер FAM RU для Yandex Cloud Functions

`deploy/package-yandex-function.mjs` собирает два entrypoint для runtime `nodejs22`: `index.handler` преобразует событие HTTP API Gateway в Node.js request, вызывает существующий router и обслуживает RU-интерфейс; `timer.handler` обрабатывает закрытые Yandex Timer trigger события через allowlist фоновых заданий. Разворачивайте их как две отдельные функции и не подключайте timer-функцию к публичному API Gateway. Расписание, scope и переменные окружения см. в [YANDEX_CLOUD_TIMER_JOBS.md](YANDEX_CLOUD_TIMER_JOBS.md).

Проверяемая совместимость runtime: [Node.js 22 поддерживается Cloud Functions](https://yandex.cloud/ru/docs/functions/concepts/runtime/). Формат запроса/ответа, `multiValueHeaders` и base64 для бинарных данных описан в [документации вызова функции](https://yandex.cloud/ru/docs/functions/concepts/function-invoke). Код содержит тесты маршрутизации, повторных `Set-Cookie`, бинарного медиа и загрузки CommonJS entrypoint.

## Результат локальной проверки

- На кодовом commit `b100428`: `493/493` backend/UI теста на Node 22.15.0.
- SDK/Sharp: `SDK_COMPAT_PASS` на закреплённых версиях.
- Расписание: portable parser проверил 7 устанавливаемых systemd timer-файлов; синтетические Yandex Timer event tests прошли.
- Реальный вызов функции, API Gateway, Yandex ID, YDB и S3 не выполнялся; CI и этот адаптер не доказывают облачную интеграцию.

## Сборка пакета функции

Сборщик `deploy/package-yandex-function.mjs` формирует ZIP с `index.handler`, `timer.handler`, Node.js backend, RU web assets, `package.json` и закреплённым lockfile. Он исключает `node_modules`, тесты, `.env` и ключевые файлы; отказывается перезаписывать существующий файл и останавливается при превышении лимита прямой загрузки. Порог `3.5 MB` указан в [официальной инструкции создания Cloud Function](https://yandex.cloud/ru/docs/functions/quickstart/create-function/node-function-quickstart); более крупный исходный архив инструкция предлагает загружать через Object Storage.

Команда:

```sh
node ru-migration/deploy/package-yandex-function.mjs /tmp/fam-ru-yandex-function.zip
```

Повторная проверка на commit `89cef58` (23 ноября 2026): собран ZIP размером `1,021,629` байт (141 файл; SHA-256 `bd76e7e90e7d7f8013beed84999c58761861fbe6891cc949d1e9aa7aa196b83e`), runtime `nodejs22`, entrypoints `index.handler` и `timer.handler`. В свежую распакованную копию установлены 87 закреплённых пакетов через `npm ci`. С пустым окружением HTTP-вход вернул `GET /` с HTTP 200 и интерфейсом FAM RU. Timer-вход принял синтетическое событие с точным форматом Yandex Timer и без DB-конфигурации отказал закрыто (`FAM_RU_TIMER_JOB_FAILED:runtime_health`). Сборщик проверил архив на исключённые тесты/секреты и лимит прямой загрузки 3.5 MB. Это не проверка фактического запуска Cloud Functions, YDB, OAuth или S3 в облаке.

Повторная проверка точного локального кода `ffa0511` на Node 22.15.0: backend/UI suite `494/494`, целевая группа `yandex-function.test.mjs` — `9/9`, SDK verifier `SDK_COMPAT_PASS`, portable calendar parser проверил 7 устанавливаемых таймеров. Сквозной синтетический тест подтверждает, что контекстный IAM-токен доходит до email sender через Yandex Function adapter, сервер и listings API, но не попадает в challenge или HTTP response. Это соответствует [форме invocation context](https://yandex.cloud/ru/docs/functions/lang/nodejs/context), где для функции с service account доступен `context.token.access_token`; Yandex Postbox принимает IAM token в `X-YaCloud-SubjectToken` ([документация аутентификации Postbox](https://yandex.cloud/ru/docs/postbox/api-ref/authentication)). Сценарий использует только синтетический токен и sender mock; реальное письмо не отправлялось.

Свежий пакет [FAM_RU_Yandex_Function_ffa0511.zip](/Users/spartakdubov/Documents/Codex/2026-11-13/referenced-chatgpt-conversation-this-is-an-2/outputs/FAM_RU_Yandex_Function_ffa0511.zip) имеет размер 1,021,746 байт (141 файл), SHA-256 `114ee793ff15e01d0ec88ef395c3058d34bec05bde453cd595a2c2b4f30d1a08`. Из отдельной распаковки на Node 22.15.0 `npm ci --omit=dev` установил 87 пакетов и сообщил 0 vulnerabilities; packaged HTTP handler вернул 200, Timer handler на корректном синтетическом событии без YDB-конфигурации завершился ожидаемым закрытым отказом `FAM_RU_TIMER_JOB_FAILED:runtime_health`. Это локальная проверка ZIP/handler; точные GitHub CI, disposable YDB, реальный Postbox, IAM и облачный вызов не выполнялись.

Повторная упаковка текущего RU code snapshot `5462b22` (локальный checkout `ab41b8c`, 23 ноября 2026): [fam-ru-yandex-function-ab41b8c.zip](/Users/spartakdubov/Documents/Codex/2026-11-13/referenced-chatgpt-conversation-this-is-an-2/outputs/fam-ru-yandex-function-ab41b8c.zip), 1,023,648 байт, 141 entry, SHA-256 `684dae01f0026bdfe9788ead391a7dda74317456dc5f344691ae0b75008fca87`. Сборщик подтвердил два entrypoint, runtime `nodejs22`, отсутствие включённых тестов, `node_modules` и секретных файлов, лимит 3.5 MB. В отдельную распаковку установлены 87 закреплённых пакетов командой `npm ci --omit=dev` при Node `v22.15.0`; упакованный HTTP handler вернул FAM RU HTML (`200`, 2,160 байт), а Timer handler на валидном синтетическом событии без DB credentials завершился ожидаемым fail-closed `FAM_RU_TIMER_JOB_FAILED:runtime_health`. На той же ревизии `compat/verify-systemd-timers.mjs` проверил все 7 deployable timer calendars через portable subset parser, `compat/verify.mjs` завершился `SDK_COMPAT_PASS` для pinned Sharp/WebP, YDB query-client и AWS SDK exports. Полный `systemd-analyze` остаётся задачей Linux CI. Cloud Function, Gateway, Timer, email или пользовательская БД не создавались и не вызывались; это упаковочная и локальная проверка, не Yandex Cloud integration/CI.

## Ограничения бесплатного размещения

Yandex Cloud Functions предлагает месячную квоту бесплатных вызовов, но превышение квот тарифицируется. Квоты суммируются в рамках платёжного аккаунта. Бюджеты Yandex Cloud отправляют уведомления и сами не останавливают потребление. Поэтому наличие адаптера не разрешает создавать облачные ресурсы при требовании строго `0 ₽`. См. актуальные [условия free tier](https://yandex.cloud/ru/docs/billing/concepts/serverless-free-tier) и [поведение бюджета](https://yandex.cloud/ru/docs/billing/concepts/budget).

До staging остаются необходимы: проверенный механизм жёсткого нулевого расхода для всей цепочки, закрытый API Gateway → приватная функция, секреты Yandex ID/YDB/S3, подходящий callback URI, настройки размера/таймаута функции, развёртывание static assets и интеграционные тесты только на синтетических данных. Ни один cloud resource или платный trial этим изменением не создавался.


## API Gateway specification template

The checked OpenAPI skeleton is [deploy/api-gateway.openapi.yaml](deploy/api-gateway.openapi.yaml). It maps / and /{proxy+} to the same private Cloud Function, uses payload format 0.1 (the adapter reads httpMethod, path, query parameters and headers), and requires an explicit immutable function version tag. Replace every REPLACE_WITH_... placeholder before creating a gateway; do not paste secrets into this file.

Use two separate service accounts: the gateway caller gets functions.functionInvoker on this one function only; the function runtime account receives only the YDB database and Object Storage bucket permissions the backend needs. The gateway is public to serve the app, while the function stays private; end-user API authorization remains in the RU backend. Do not grant database or bucket permissions to the gateway caller.

The YAML was parsed and its two route integrations checked locally. No gateway or function was created, and this template does not prove IAM, OAuth, YDB/S3 connectivity, or a 0 ₽ cost ceiling.


## Environment variable inventory

Use the non-secret placeholder list in [deploy/yandex-cloud.env.example](deploy/yandex-cloud.env.example); keep actual values in the deployment secret settings and out of Git, API Gateway context, and frontend files.

Required: FAM_RU_DATABASE_URL and exactly one auth mode. Yandex ID web auth requires FAM_RU_YANDEX_CLIENT_ID, FAM_RU_YANDEX_REDIRECT_URI, and FAM_RU_SESSION_SECRET (at least 32 bytes). Register the exact HTTPS callback path /auth/yandex/callback. The alternative bearer mode uses FAM_RU_AUTH_ISSUER, FAM_RU_AUTH_AUDIENCE, and FAM_RU_AUTH_JWKS_URL.

Photo uploads and reviews also require FAM_RU_S3_ENDPOINT, FAM_RU_S3_BUCKET, FAM_RU_S3_ACCESS_KEY_ID, and FAM_RU_S3_SECRET_ACCESS_KEY; FAM_RU_S3_REGION is optional and defaults to ru-central1. Leave media disabled until the bucket is private and its access scope is checked. FAM_RU_SAFETY_HMAC_KEY is optional; use a separate random value when setting it. FAM_RU_YDB_METADATA_URL is normally omitted in Yandex Cloud Functions. Leave FAM_RU_CODER_WORKER_TOKEN unset unless a separately audited trusted worker is configured.

Do not configure FAM_RU_ALLOW_INITIAL_ADMIN_BOOTSTRAP in the public runtime. The one-time bootstrap is a separately gated operator command. The example file contains placeholders only; it is not a deployable environment file.
