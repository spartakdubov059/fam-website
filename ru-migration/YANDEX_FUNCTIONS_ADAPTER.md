# Адаптер FAM RU для Yandex Cloud Functions

`app/backend/cloud-function.cjs` экспортирует обработчик `handler` для runtime `nodejs22`. Он загружает ES-модуль `yandex-function.mjs`, который преобразует событие HTTP API Gateway в Node.js request, вызывает существующий router и возвращает HTTP-ответ в формате Cloud Functions. Статический RU-интерфейс также обслуживается тем же router.

Проверяемая совместимость runtime: [Node.js 22 поддерживается Cloud Functions](https://yandex.cloud/ru/docs/functions/concepts/runtime/). Формат запроса/ответа, `multiValueHeaders` и base64 для бинарных данных описан в [документации вызова функции](https://yandex.cloud/ru/docs/functions/concepts/function-invoke). Код содержит тесты маршрутизации, повторных `Set-Cookie`, бинарного медиа и загрузки CommonJS entrypoint.

## Результат локальной проверки

- Backend: `356/356` тестов на Node 22.23.5.
- SDK/Sharp: `SDK_COMPAT_PASS` на закреплённых версиях.
- Расписание: portable parser проверил 8 systemd timer-файлов.
- Реальный вызов функции, API Gateway, Yandex ID, YDB и S3 не выполнялся; CI и этот адаптер не доказывают облачную интеграцию.

## Сборка пакета функции

Сборщик `deploy/package-yandex-function.mjs` формирует ZIP с `index.handler`, Node.js backend, RU web assets, `package.json` и закреплённым lockfile. Он исключает `node_modules`, тесты, `.env` и ключевые файлы; отказывается перезаписывать существующий файл и останавливается при превышении лимита прямой загрузки. Порог `3.5 MB` указан в [официальной инструкции создания Cloud Function](https://yandex.cloud/ru/docs/functions/quickstart/create-function/node-function-quickstart); более крупный исходный архив инструкция предлагает загружать через Object Storage.

Команда:

```sh
node ru-migration/deploy/package-yandex-function.mjs /tmp/fam-ru-yandex-function.zip
```

Пакет проверен локально: `976900` байт, 121 файл, после чистого `npm ci` в распакованной папке `index.handler` вернул `GET /` с HTTP 200 и интерфейсом FAM RU. Это только проверка содержимого/entrypoint ZIP, не реальный вызов Cloud Functions.

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
