# Проверка ограничения модерации фото — 21 ноября 2026

Кодовая ревизия: [`6018da0093349d189265b1b1a08516346db40d89`](https://github.com/spartakdubov059/fam-website/commit/6018da0093349d189265b1b1a08516346db40d89), ветка `migration/yandex-cloud`.

## Исправленный доступ

До исправления прямые маршруты pending-фото объявления, аватара и вложения идеи проверяли роль модератора и школу, но не активное ограничение аккаунта. Приостановленный модератор мог обойти блокировку очереди прямым GET по URL. Теперь backend запрашивает `getActiveAccountSuspension` с парой `(school_id, actor.id)`: активное ограничение даёт `403 account_suspended`; ошибка базы или отсутствие достоверной проверки блокирует доступ ответом `503`. GET не читает объект, PATCH не меняет статус фото. Автор идеи сохраняет собственный доступ к своему вложению.

Добавлены регрессионные сценарии на GET и PATCH фото объявления, GET аватара и вложения идеи для приостановленного модератора, отказ при ошибке проверки состояния, отсутствие чтения объектов и отсутствие решения. Проверено сохранение доступа владельца к собственному вложению. Прежние тесты межшкольного отказа сохранены.

## Результаты

- Целевые тесты `test/media-api.test.mjs test/avatar-review.test.mjs test/account-suspensions-api.test.mjs`: **28/28**.
- Полный backend suite `node --test test/*.test.mjs` на Node 22.15.0: **413/413**.
- `ru-migration/compat/verify.mjs`: `SDK_COMPAT_PASS` для pinned Sharp/WebP, YDB query-client методов и AWS exports.
- `git diff --check`: успешно.
- На точном кодовом коммите [`6018da0093349d189265b1b1a08516346db40d89`](https://github.com/spartakdubov059/fam-website/commit/6018da0093349d189265b1b1a08516346db40d89) GitHub Actions завершились успешно: [YDB integration #44828915964](https://github.com/spartakdubov059/fam-website/actions/runs/44828915964) создал disposable локальную YDB, применил изолированную схему, прогнал синтетическую интеграцию и удалил базу; [SDK/Sharp/package #44828915937](https://github.com/spartakdubov059/fam-website/actions/runs/44828915937) собрал пакет и прошёл backend, timer и SDK/image smoke-шаги. Combined status API показывает `statuses: []`, но это не отражает отдельные workflow runs.
- Попытка начать Standard security scan локального репозитория завершилась timeout после 300 секунд. Scan ID и отчёт не выданы; полный скан остаётся незавершённым.
- Узкий diff scan для диапазона `0105bc7..f353a69` также не стартовал: Codex Security вернул `Review changes requires a non-bare Git worktree with a resolvable HEAD`, хотя рабочий каталог подтверждён как non-bare, `HEAD` и оба commit SHA разрешаются. Scan ID не выдан.
- Ручно просмотрены все семь изменённых файлов в этом диапазоне: исправление media API, три регрессионных теста и четыре изменённых/добавленных документа. В изменённом коде проверены границы школы, fail-closed ответ при неизвестной блокировке, отсутствие чтения медиа/модерационного решения для заблокированного модератора и исключение для владельца вложения. Такой просмотр не заменяет полный автоматизированный или независимый аудит.

Проверки выполнены локально на синтетических запросах/данных. Российское облако, OAuth, S3, production и данные учеников не использовались. Исправление закрывает найденный путь доступа, но не является полным security review и не подтверждает cloud IAM/bucket policy.

## Дополнительное исправление прямого чтения идей

При сверке с `supabase/migrations/20261111164217_restrict_unapproved_ideas_from_council.sql` найден обход правила: route прямого чтения фото проверял роль и школу, но не статус `ai_status` самой идеи. Теперь YDB repository возвращает статус AI-проверки, а API разрешает совету читать только идеи со статусом `approved`; автор и администратор той же школы сохраняют доступ для своих сценариев. Изображение pending-идеи блокируется до чтения S3. Добавлены проверки pending/approved веток в `media-api.test.mjs` и получения статуса в `ydb-listings.test.mjs`.

Первый прогон локально на Node `v24.22.3` прошёл backend suite **414/414**, затронутые media/repository тесты **69/69** и `ru-migration/compat/verify.mjs`. Дополнительно использован заранее загруженный официальный Node `v22.15.0` / npm `10.9.2` из `/tmp/fam-ru-node22`: `npm ci --no-audit --no-fund` установил 87 пакетов по lockfile, затем `npm test` прошёл **414/414**, `compat/verify.mjs` и `compat/verify-systemd-timers.mjs` прошли, `npm audit --omit=dev` сообщил **0 vulnerabilities**. `git diff --check` прошёл. Это изменение ещё не запускалось в GitHub Actions и не прошло полный security scan. GitHub Actions текущей удалённой ревизии выше не подтверждают эту локальную правку.

Как отдельную проверку исходного FAM на Node 22.15.0 запущено `node --test tests/moderation/*.test.mjs tests/security/*.test.mjs`: **181/181**. Этот набор проверяет текущие Supabase/Netlify исходники, а не российскую копию и не архив с заявленными 220 тестами; его нельзя складывать с backend suite как один тестовый прогон.

После фикса локальный коммит `e0bbb3982f6fd919a9f33477e0e837324e45c248` создан в ветке `codex/fam-ru-progress-20261120` для неизменяемой проверки; он не отправлялся. Диагностика Codex Security подтвердила валидный non-bare worktree и точный диапазон `f353a692..e0bbb398`, но diff-scan повторно завершился ошибкой `Review changes requires a non-bare Git worktree with a resolvable HEAD`. Запуск полного Standard scan текущего `ru-migration` завершился timeout через 300 секунд без `scanId` или отчёта. Эти ошибки не означают отсутствие findings. Для нового коммита независимый security review и GitHub CI всё ещё ожидаются. Последующий корректный Node 22 прогон приведён выше.

## Follow-up: ограничение очереди школьных идей

Повторная проверка того же source policy выявила ещё три обхода: `/api/v1/school/ideas` возвращал council текст идеи со статусом `ai_status=pending`; council мог вызвать text-review route; транзакция разрешала council менять состояние текста и принимать решение по фото такой идеи напрямую. Теперь очередь фильтруется по роли (same-school admin видит pending text для взрослой проверки; council получает только AI-approved идеи), text moderation ограничена `school_admin` на API и в repository, а фото-решение для council требует AI-approved idea в транзакции.

Регрессии добавлены в `test/listings-api.test.mjs` и `test/ydb-listings.test.mjs`; synthetic disposable YDB сценарий в `compat/integration-ydb.mjs` расширен, но не выполнен локально (нет Docker/Podman/YDB CLI) и не запускался в CI. На Node 22.15.0 после `npm ci` полный backend suite прошёл **415/415**; `node --check compat/integration-ydb.mjs`, `compat/verify.mjs`, `compat/verify-systemd-timers.mjs` и `git diff --check` прошли. GitHub Actions и независимый security scan не выполнялись; изменение локальное и не опубликовано.
