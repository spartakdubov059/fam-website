# Адаптер FAM RU для Yandex Cloud Functions

`app/backend/cloud-function.cjs` экспортирует обработчик `handler` для runtime `nodejs22`. Он загружает ES-модуль `yandex-function.mjs`, который преобразует событие HTTP API Gateway в Node.js request, вызывает существующий router и возвращает HTTP-ответ в формате Cloud Functions. Статический RU-интерфейс также обслуживается тем же router.

Проверяемая совместимость runtime: [Node.js 22 поддерживается Cloud Functions](https://yandex.cloud/ru/docs/functions/concepts/runtime/). Формат запроса/ответа, `multiValueHeaders` и base64 для бинарных данных описан в [документации вызова функции](https://yandex.cloud/ru/docs/functions/concepts/function-invoke). Код содержит тесты маршрутизации, повторных `Set-Cookie`, бинарного медиа и загрузки CommonJS entrypoint.

## Результат локальной проверки

- Backend: `356/356` тестов на Node 22.23.5.
- SDK/Sharp: `SDK_COMPAT_PASS` на закреплённых версиях.
- Расписание: portable parser проверил 8 systemd timer-файлов.
- Реальный вызов функции, API Gateway, Yandex ID, YDB и S3 не выполнялся; CI и этот адаптер не доказывают облачную интеграцию.

## Ограничения бесплатного размещения

Yandex Cloud Functions предлагает месячную квоту бесплатных вызовов, но превышение квот тарифицируется. Квоты суммируются в рамках платёжного аккаунта. Бюджеты Yandex Cloud отправляют уведомления и сами не останавливают потребление. Поэтому наличие адаптера не разрешает создавать облачные ресурсы при требовании строго `0 ₽`. См. актуальные [условия free tier](https://yandex.cloud/ru/docs/billing/concepts/serverless-free-tier) и [поведение бюджета](https://yandex.cloud/ru/docs/billing/concepts/budget).

До staging остаются необходимы: проверенный механизм жёсткого нулевого расхода для всей цепочки, закрытый API Gateway → приватная функция, секреты Yandex ID/YDB/S3, подходящий callback URI, настройки размера/таймаута функции, развёртывание static assets и интеграционные тесты только на синтетических данных. Ни один cloud resource или платный trial этим изменением не создавался.
