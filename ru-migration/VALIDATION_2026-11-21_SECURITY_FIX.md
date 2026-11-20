# Проверка ограничения модерации фото — 21 ноября 2026

Кодовая ревизия: [`0105bc770b44f6d8acf101755c1e0a768646e2ec`](https://github.com/spartakdubov059/fam-website/commit/0105bc770b44f6d8acf101755c1e0a768646e2ec), ветка `migration/yandex-cloud`.

## Исправленный доступ

До исправления прямой маршрут pending-фото `/api/v1/listings/:id/photo` проверял для GET и PATCH роль модератора и школу, но не активное ограничение аккаунта. После проверки школы backend теперь запрашивает `getActiveAccountSuspension` с парой `(school_id, actor.id)`: активное ограничение даёт `403 account_suspended`; отсутствие метода/UUID или ошибка базы блокирует доступ ответом `503`. GET не читает объект изображения, PATCH не меняет статус фото.

Добавлены регрессионные сценарии на GET и PATCH для приостановленного модератора, отказ при ошибке проверки состояния, отсутствие чтения объекта и отсутствие решения. Прежний тест межшкольного отказа сохранён.

## Результаты

- Целевые тесты `test/media-api.test.mjs test/account-suspensions-api.test.mjs`: **23/23**.
- Полный backend suite `node --test test/*.test.mjs`: **411/411**.
- `ru-migration/compat/verify.mjs`: `SDK_COMPAT_PASS` для pinned Sharp/WebP, YDB query-client методов и AWS exports.
- `git diff --check`: успешно.
- Combined GitHub status на точном tip: `statuses: []` — CI checks не опубликованы.
- Попытка начать Standard security scan локального репозитория завершилась timeout после 300 секунд. Scan ID и отчёт не выданы; полный скан остаётся незавершённым.

Проверки выполнены локально на синтетических запросах/данных. Российское облако, OAuth, S3, production и данные учеников не использовались. Исправление закрывает найденный путь доступа, но не является полным security review и не подтверждает cloud IAM/bucket policy.
