# Email step-up: лимиты и блокировка кода — 23 ноября 2026

В YDB integration harness добавлены синтетические сценарии для пяти неверных кодов, блокировки текущего кода, 60-секундного интервала между отправками и максимума трёх писем в час. Изменение кода находится в восстановленном полном harness на commit [`a227abe`](https://github.com/spartakdubov059/fam-website/commit/a227abe9886afe8b5622093755a330898006a1ec).

Проверки:

- Целевой локальный Node 22.15.0 набор step-up/background/timer: **17/17**; `node --check ru-migration/compat/integration-ydb.mjs` прошёл.
- Точный [disposable YDB CI #45217047649](https://github.com/spartakdubov059/fam-website/actions/runs/45217047649) применил схему 01–37, успешно выполнил шаг `Exercise schema and repository with synthetic data`, последующие школьный отчёт, bootstrap, S3 adapter и удаление временной базы.
- Точный [SDK/Sharp CI #45217047719](https://github.com/spartakdubov059/fam-website/actions/runs/45217047719) успешен. Полный `integration-ydb.mjs` после восстановления имеет Git blob SHA `ac8323352239b492fab67c3566ad2d31aefdfbbb`, тот же SHA у локального tracked source; его размер локально — 137 957 байт.

Предыдущий workflow [#45216568177](https://github.com/spartakdubov059/fam-website/actions/runs/45216568177) завершился ошибкой парсинга: при первой API-публикации большой файл был усечён, и предупреждение об усечении попало в начало исходника. Полный файл восстановлен отдельным commit и побайтно сверён до успешного повторного CI. Ошибочный запуск не является отрицательным результатом сценариев; повторный прогон на восстановленном точном файле — успешный.

Письма не отправлялись: интеграция использует синтетический callback sender и временную локальную YDB. Реальный Yandex Postbox, IAM и российское облако не проверялись. Облачные ресурсы, реальные данные, `main` и production не использовались.
