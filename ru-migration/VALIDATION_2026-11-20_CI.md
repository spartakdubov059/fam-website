# Проверка FAM RU — 20 ноября 2026

## Последняя проверка чувствительной аутентификации

- Проверенный код: [`0d41c98`](https://github.com/spartakdubov059/fam-website/commit/0d41c9824a8c38416e13879d8ad73f0e64ab1440). Точный [SDK/Sharp workflow #44770366256](https://github.com/spartakdubov059/fam-website/actions/runs/44770366256) завершился успешно: **362/362** backend-теста, pinned SDK/Sharp/WebP и 8 systemd timers.
- Точный [disposable YDB workflow #44770366230](https://github.com/spartakdubov059/fam-website/actions/runs/44770366230) успешно применил схему 01–33 и выполнил synthetic integration. Контейнер удалён cleanup-шагом.
- Новые проверки подтверждают, что `force_confirm` и локальное время сессии не дают свежую аутентификацию; только проверенный OIDC `auth_time` может пройти чувствительный gate. Поэтому обычные Яндекс ID cookie-сессии fail-closed на операциях удаления и блокировки. Это ограничение нужно снять только после поддержки проверяемого provider auth-time или независимого сильного фактора.
- Облачный staging не развёртывался, реальные данные и платные ресурсы не использовались; `main` и production не затрагивались. Эти тесты не являются полным security sign-off.

## Последняя повторная проверка — 20 ноября 2026

- Кодовый commit [a7c1ab8](https://github.com/spartakdubov059/fam-website/commit/a7c1ab8ebb4b7af557fa38017b1f4b621aa68680) уточнил синтетическую проверку двух локальных safety-маркеров: запрос выбирает категорию угрозы явно и не зависит от одинаковых временных меток инцидентов.
- [SDK/Sharp CI #44767160863](https://github.com/spartakdubov059/fam-website/actions/runs/44767160863) прошёл: **359/359** backend-тестов, 8 systemd timer-файлов, SDK/Sharp и WebP проверки.
- [Disposable YDB CI #44767161011](https://github.com/spartakdubov059/fam-website/actions/runs/44767161011) успешно применил схемы 01–33 и выполнил synthetic integration; новые категории адресной травли и прямых личных оскорблений остаются в ручной очереди, а исходный текст не сохраняется. Контейнер тестовой базы удалён cleanup-шагом.
- Это CI с временной локальной YDB и синтетическими профилями, не облачный staging. Платные облачные ресурсы и production не использовались; реальные данные учеников не затрагивались.

## Latest exact-commit CI result

- Branch `migration/yandex-cloud` points to [`4699a06`](https://github.com/spartakdubov059/fam-website/commit/4699a0668da486e0881efabece3ce1f3ef69a8d7). Runtime readiness now reports healthy only when auth, YDB and object storage are configured.
- [SDK/Sharp workflow #44761633630](https://github.com/spartakdubov059/fam-website/actions/runs/44761633630) passed on Node 22: **350/350** backend tests, pinned SDK/Sharp and WebP checks, and 8 systemd timer files validated.
- [Disposable YDB workflow #44761633682](https://github.com/spartakdubov059/fam-website/actions/runs/44761633682) passed schema 01–33 and synthetic integration, including account deletion/role controls, school isolation, media cleanup and review, queues, quotas, indexes, listings, favorites, ideas, messages and events. The local test container was removed by the workflow cleanup step.
- These are local code/CI checks, not a deployed Yandex Cloud staging environment. No cloud resource, production account, or real student data was used. `main` remains `5e749c56b9270efbfdf1f48cefe6e8d95a01c579`.

## Перепроверка после обновления карты исходника

- Текущая карта ancestry и 9 миграций/6 Edge Function изменений зафиксирована в [SOURCE_CROSSWALK_2026-11-20.md](SOURCE_CROSSWALK_2026-11-20.md); она уточняет предыдущую узкую сверку в `SOURCE_SYNC_2026-11-20.md`.
- На чистом изолированном checkout feature-ветки запущен Node `v22.23.5` (диапазон package: `>=22.15 <23`): `npm test --prefix ru-migration/app/backend` — **331/331 passed**.
- `node ru-migration/compat/verify.mjs` вывел `SDK_COMPAT_PASS`; `node ru-migration/compat/verify-systemd-timers.mjs` проверил 7 timer-файлов; `git diff --check` прошёл.
- Документальный commit [`7287907`](https://github.com/spartakdubov059/fam-website/commit/7287907e02eea46b26615eb0088f983ebb22c238) добавляет crosswalk и не меняет код. Для него новые GitHub CI workflow не запускались; предшествующие зелёные CI относятся к кодовому commit [`fb1f3d2`](https://github.com/spartakdubov059/fam-website/commit/fb1f3d2abc7c739b5d55d65e88fda376e85fb4fc).
- Повторные GitHub refs после обновления: `main` `5e749c56`, `migration/yandex-cloud` `2795f05a`, feature `7287907e`. Первые две ветки не изменены. Это не облачный staging и не полный security review.

## Перенос безопасного coder producer в feature branch

- Коммит [`f611526`](https://github.com/spartakdubov059/fam-website/commit/f6115268a5d914c5f79970a0e42a99e184a2f00b) добавил RU producer для постановки ручной проверки только по агрегированным allowlisted событиям. Модель и инструменты не запускаются; задача не входит в автоматический allowlist worker.
- Коммит [`88a63bc`](https://github.com/spartakdubov059/fam-website/commit/88a63bc5e39853ff95ba6a83610b430485f1bad4) добавил synthetic YDB сценарий порога и идемпотентности. [Disposable YDB CI #44701308296](https://github.com/spartakdubov059/fam-website/actions/runs/44701308296) и [SDK/Sharp CI #44701308311](https://github.com/spartakdubov059/fam-website/actions/runs/44701308311) завершились успешно. Локально: 331/331 backend-тестов, SDK compat verifier и portable timer validation прошли.
- При подготовке интеграционного сценария первоначальная загрузка большого файла была обрезана и CI корректно упал на синтаксической ошибке. Файл восстановлен из локального Git blob с проверкой SHA; успешный CI выше выполнен уже на полном файле.
- Изменения только в `codex/fam-ru-offline-safety-review`. `main` и `migration/yandex-cloud` не менялись. YDB была одноразовой локальной базой GitHub CI, не российским облачным staging.

## Срок хранения безопасной очереди

- Новая схема `33_fam_agent_task_retention.yql` включает YDB TTL на `finished_at` для завершённых задач и `created_at` для событий очереди (180 дней). Незавершённые задачи с `finished_at = NULL` сохраняются; повторный захват сбрасывает время завершения.
- Коммит [`fb1f3d2`](https://github.com/spartakdubov059/fam-website/commit/fb1f3d2abc7c739b5d55d65e88fda376e85fb4fc) прошёл [disposable YDB CI #44702250049](https://github.com/spartakdubov059/fam-website/actions/runs/44702250049) и [SDK/Sharp CI #44702250295](https://github.com/spartakdubov059/fam-website/actions/runs/44702250295). Схема 33 применена на временной локальной YDB; локальная команда `verify.mjs` не интерпретирует YQL TTL.

## Актуальная проверка веток и CI (20 ноября 2026)

- На кодовом commit [`0d3be3a`](https://github.com/spartakdubov059/fam-website/commit/0d3be3a5a5b5ea0466340b1e794cff75babed647) оба workflow повторно завершились успешно: [SDK/Sharp CI #44690234889](https://github.com/spartakdubov059/fam-website/actions/runs/44690234889) — `327/327` backend-тестов, pinned SDK/Sharp и systemd timers; [YDB CI #44690234948](https://github.com/spartakdubov059/fam-website/actions/runs/44690234948) — схемы 01–32 и synthetic integration, включая две конкурентные постановки одной задачи (создаётся одна запись) и два конкурентных worker захвата (один lease). CI использовал только временную локальную тестовую YDB.
- Последний кодовый commit [`a192e84`](https://github.com/spartakdubov059/fam-website/commit/a192e840affea8913035d21b2710d27752d28f19) прошёл [SDK/Sharp CI #44689197713](https://github.com/spartakdubov059/fam-website/actions/runs/44689197713): `327/327` тестов, без ошибок, SDK exports, Sharp/WebP и таймеры. [Одноразовая YDB CI #44689197677](https://github.com/spartakdubov059/fam-website/actions/runs/44689197677) успешно применила схемы 01–32 и выполнила synthetic integration, включая идемпотентную safe-agent очередь и lease. Инвентаризация этих изменений: [`33f902a`](https://github.com/spartakdubov059/fam-website/commit/33f902ab83f7d13edf790c549b72edeef2aa3914).
- Свежие refs: GitHub `main` — [`5e749c5`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579) (78 migrations, 7 Edge Functions); `migration/yandex-cloud` — `33f902a` (код прошёл CI на его родителе `a192e84`). `main` не менялась.
- CI использует GitHub-hosted runner и временную локальную YDB; это не российский облачный staging. `yc` CLI, Yandex Cloud credentials, OAuth, S3 и бесплатный облачный хост с гарантией 0 ₽ не подтверждены.

- Повторно полученные refs: GitHub `main` — `7fd418246653f92b53f66bc29fa224d95d04d5cf` (76 migrations, 7 Edge Functions); `migration/yandex-cloud` — [`d900cd1377b5a3577050552daaaa371a5374ea50`](https://github.com/spartakdubov059/fam-website/commit/d900cd1377b5a3577050552daaaa371a5374ea50). Commit `5e749c5` не является предком текущего `main`; детали — в [SOURCE_SYNC](SOURCE_SYNC_2026-11-20.md).
- На `d900cd1` [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44684140252) завершилась успешно: `316/316` backend-тестов, `0` ошибок, pinned `npm ci`, проверка systemd unit-ов, Sharp/WebP и SDK verifier.
- [Одноразовая YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44684140282) завершилась успешно: схема применена, синтетические сценарии прошли, временная локальная база удалена.
- Новый регрессионный тест проверяет, что сводный health report отклоняет пустой, дублированный, повреждённый или противоречивый результат проверки таймеров даже при `ok: true` на верхнем уровне.
- Это GitHub Actions и локальная временная YDB, не облачный российский staging. `yc` CLI и конфигурация Yandex Cloud в окружении не обнаружены; credentials, OAuth, S3 и бесплатный облачный хостинг не подтверждены.

## Актуальное уточнение (20 ноября 2026)

- Commit [`f23d42b`](https://github.com/spartakdubov059/fam-website/commit/f23d42b4fa14dd2add9dc899177739e7589ce838) перенёс актуальное требование source `main` для школьных опросов: 2–8 вариантов, голос до индекса 7. Обновлены UI, policy, API, YDB repository и synthetic integration: создаётся poll из восьми ответов, голос по индексу 7 проходит, индекс 8 отвергается, сводка включает восемь счётчиков. Локально на Node 22.15.0 прошли `311/311` тестов, SDK verifier и `git diff --check`; [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508222) и [одноразовая YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44681508156) завершились успешно. Это тестовая YDB, не российский облачный staging.

- Кодовый commit [`0ab1ca4`](https://github.com/spartakdubov059/fam-website/commit/0ab1ca41943d3bcc39e987b8b0b3b9d8059f3eff) проверяет read-only пять ожидаемых RU systemd units: загрузку и включение таймера, совпадение парной службы, активность и следующий запуск, результат последнего выполнения и свежесть последнего запуска. Числовые пределы свежести — 26 часов для суточных, 7 часов для очистки медиа, 2 часа для ежечасной сводки. В выводе только allowlisted имена и булевы признаки; даты и журналы исключены. На Node 22.15.0 прошли `311/311` тестов и SDK compatibility verifier; [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44679022508) и [одноразовая YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44679022480) успешны. Прямой вызов на macOS без systemd возвращает безопасный `ok:false`; это не реальный staging.

- Кодовая ревизия [`ef81c80`](https://github.com/spartakdubov059/fam-website/commit/ef81c806f9ac611452ec4ba36ea75e837e38d009) добавила fail-closed проверку активной блокировки во все школьные административные маршруты: safety и технические уведомления, обзор школы, агентские панели, роли, очереди заявок/модерации, мероприятия и удаления. Добавлены тесты, что заблокированный администратор не читает школьный обзор, не отзывает роли, не открывает очередь и не принимает решение по объявлению. Локально на Node 22.15.0 прошли `307/307` backend-тестов и `ru-migration/compat/verify.mjs` (`SDK_COMPAT_PASS`); `git diff --check` чистый.
- Для `ef81c80` успешно завершились [SDK/Sharp workflow, run 44674528985](https://github.com/spartakdubov059/fam-website/actions/runs/44674528985) и [одноразовая YDB CI, run 44674528757](https://github.com/spartakdubov059/fam-website/actions/runs/44674528757). YDB проверялась в локальном временном CI окружении на синтетических данных; это не российский облачный staging.
- Предыдущие записи ниже относятся к старым ревизиям и сохранены как история. `main` осталась на `7532820`; production и реальные данные не затрагивались.

- После последнего commit с изменением кода [`bbb1644`](https://github.com/spartakdubov059/fam-website/commit/bbb1644d1da8614597570655d10c62b4030a2146) в `migration/yandex-cloud` добавлялись только документационные коммиты: [`a729b6f`](https://github.com/spartakdubov059/fam-website/commit/a729b6f8ed7b80ef5dcb7f421e84412245d63885), [`7c4586f`](https://github.com/spartakdubov059/fam-website/commit/7c4586f32fef6b4497048fbf77dfa4ae99065d0a), [`83a8c3f`](https://github.com/spartakdubov059/fam-website/commit/83a8c3f82d0935a32f4dbe21daa7ed615c4cc8a4) и [`89ee1c0`](https://github.com/spartakdubov059/fam-website/commit/89ee1c06d04236817283b513e9c2cfc7cec40976). Локальное дерево до обновления этого журнала совпадало с деревом `a729b6f`, но Git-истории локальной и удалённой веток расходятся; обычный push из checkout не использовать.
- Последний commit с изменённым кодом — [`bbb1644`](https://github.com/spartakdubov059/fam-website/commit/bbb1644d1da8614597570655d10c62b4030a2146). Для него завершились успешно [SDK/Sharp CI, run 44667460743](https://github.com/spartakdubov059/fam-website/actions/runs/44667460743) и [одноразовая YDB CI, run 44667460572](https://github.com/spartakdubov059/fam-website/actions/runs/44667460572). Первый workflow проверяет pinned SDK/Sharp и backend suite; второй — схемы и синтетические сценарии на локальной временной YDB с последующей очисткой.
- Для `a729b6f` новых проверок нет: в нём менялась только документация; предыдущие зелёные workflow относятся к `bbb1644`, не к `a729b6f`.
- Повторить Node suite локально в текущем checkout не удалось: shell сообщает `node: command not found`. Успехи выше — удалённые CI результаты, а не новый локальный запуск.
- Это по-прежнему не российский cloud staging. Полный перенос фоновой очереди `fam-agent-worker`, автоматической модерации изображений и остальных исходных backend-функций не подтверждён; полный security review и QA остаются незавершёнными.

- Обновлены только CI actions на изолированной ветке `migration/yandex-cloud`: checkout v7, setup-node v7, upload-artifact v6. Автоматическое кэширование npm отключено; зависимости продолжают устанавливаться через `npm ci` по lock-файлам.
- [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44635841849) — успешно. Node 22; установленные YDB/AWS SDK, Sharp и весь backend suite.
- [Disposable YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44635918742) — успешно. Схема и интеграционные сценарии проверены на синтетической локальной базе; контейнер удаляется шагом cleanup.
- Повторный локальный backend suite: 299/299 прошло на Node v24.22.1. Локальный Node вне заданного диапазона проекта (22.15–<23), поэтому версию Node 22 подтверждает CI.
- Предыдущие workflow показывали предупреждения о принудительном запуске старых actions на Node 24; новые workflow используют actions с официальным Node 24 runtime.
- Профильный Codex Security diff scan не стартовал: инструмент вернул «Review changes requires a non-bare Git worktree with a resolvable HEAD» даже для чистой отдельной worktree на точном диапазоне. Security review не считать завершённым.
- Российский облачный staging, production, `main` и реальные данные не затрагивались. Бесплатная публичная среда с жёсткой защитой от списаний не подтверждена.


## Дополнение: удаление связанных медиа, 20 ноября 2026

- Сверено удаление аккаунта: инвентарь теперь объединяет безопасный owner-prefix S3 с приватными ключами идей и аватаров, выбранными из YDB; основной и recovery-путь используют общую проверку ключей. При ошибке YDB/S3 удаление остаётся fail-closed.
- В точной вершине ветки `c090e0ae409afa7f794a173fb0aaba0b53561d75` GitHub Actions прошли: [SDK/Sharp #44773720085](https://github.com/spartakdubov059/fam-website/actions/runs/44773720085) и [одноразовая YDB #44773719757](https://github.com/spartakdubov059/fam-website/actions/runs/44773719757). Оба job — success; ресурсы staging не создавались.
- Detached checkout этой точной вершины локально прошёл backend suite **364/364**, без пропусков; `git diff --check` прошёл в рабочей копии до публикации.
- Это точечное покрытие удаления аккаунта, не полный security audit или parity всех Supabase RLS/RPC/triggers и Edge Functions.

## Дополнение: анонимизация и очистка состояния аккаунта, 20 ноября 2026

- При удалении аккаунта очищаются приватные строки очереди аватаров, уведомления и квоты. В школьном аудите ID автора заменяется постоянной меткой; в safety-записях удаляются actor/target, origin и выдержка текста, а агрегированный fingerprint остаётся для школьной статистики.
- Точная ревизия `e64fbc23490ae665af06ef1b8a0e2b24e1070b50`: backend suite **365/365** в detached checkout; [SDK/Sharp CI #44775225474](https://github.com/spartakdubov059/fam-website/actions/runs/44775225474) и [одноразовая YDB CI #44775225712](https://github.com/spartakdubov059/fam-website/actions/runs/44775225712) — success.
- Проверка охватывает этот путь удаления; полный аудит миграции, auth staging и паритет всех исходных функций по-прежнему не подтверждены.

## Дополнение: синтетическая YDB-проверка удаления, 20 ноября 2026

- Disposable YDB сценарий расширен: перед удалением создаются pending-аватар, уведомление, квота, audit и safety incident. Интеграция проверяет удаление приватных ключей и пользовательских строк, замену actor в аудите и очистку прямой attribution/evidence в safety-записи.
- Точная ревизия `233debf762855d79bacbc22109846f98645d1dc0`: [YDB CI #44775812119](https://github.com/spartakdubov059/fam-website/actions/runs/44775812119) — success, disposable DB cleanup выполнен; [SDK/Sharp CI #44775812071](https://github.com/spartakdubov059/fam-website/actions/runs/44775812071) — success. Detached backend suite на той же вершине: **365/365**, без skipped.
- Это проверяет перечисленные synthetic deletion flows, но не все Supabase RLS/RPC/triggers или полноценный российский cloud staging.

## Проверка квот контента по исходной SQL-миграции

Точная веточная ревизия `ce9884aefbfd0c35c629e394b448d0b79b74fc22`:

- [SDK/Sharp и backend suite #44780591200](https://github.com/spartakdubov059/fam-website/actions/runs/44780591200) — success; build Yandex Functions package, весь backend suite **369/369**, timers, нативный Sharp и SDK smoke checks.
- [Disposable YDB #44780591234](https://github.com/spartakdubov059/fam-website/actions/runs/44780591234) — success; schema и synthetic integration прошли, в том числе 8 разрешённых сообщений/мин, отказ 9-го, 5 идей/час, отказ 6-й, ручная message queue и cross-school recipient отказ. Временная локальная CI база удалена.
- Upstream источник лимитов: `20261108004943_enforce_server_side_content_moderation.sql` на `main` `5e749c56b9270efbfdf1f48cefe6e8d95a01c579`. Это подтверждает квоты и соответствующие сценарии, не полный перенос всех grants/policies этой миграции или всего Supabase.

## Проверка rolling rate limit сообщений

Точная кодовая ревизия `603dab5cd83e67f448d5ba218a1ae6721f9ca140` проверяет окно от последнего сообщения, как в upstream `private.can_send_message`: 8-е сообщение проходит, 9-е до истечения минуты возвращает `rate_limited`, после 60 секунд тишины счётчик сбрасывается.

- [SDK/Sharp и backend suite #44781191006](https://github.com/spartakdubov059/fam-website/actions/runs/44781191006) — success, 369/369 backend-тестов, timers, SDK/Sharp.
- [Disposable YDB #44781191568](https://github.com/spartakdubov059/fam-website/actions/runs/44781191568) — success; YDB schema и синтетическая интеграция прошли, ephemeral база удалена.
- `main` остался на `5e749c56b9270efbfdf1f48cefe6e8d95a01c579`; российская ветка изолирована.

## Сверка регистрации и видимости занятости мероприятий

На кодовом коммите [9cf449a](https://github.com/spartakdubov059/fam-website/commit/9cf449a5b17dd95e6d60209856f2b53c9ea8a49a) исправлена видимость счётчика мест: публичный маршрут теперь возвращает число только для активного мероприятия, иначе — `404 event_unavailable`. В YDB добавлен запрос со связью occupancy с активным event. Также синтетическая интеграция проверяет повторную запись после отмены и гонку отмены с повторной записью; после гонки проверяется, что активная запись и счётчик согласованы.

- [SDK/Sharp CI #44786678750](https://github.com/spartakdubov059/fam-website/actions/runs/44786678750) — success, backend suite **370/370**, без пропусков.
- [Disposable local YDB CI #44786678706](https://github.com/spartakdubov059/fam-website/actions/runs/44786678706) — success; synthetic integration выполнена на временной локальной YDB и база удалена.
- Тесты используют синтетические аккаунты. Это не российский облачный staging; main, production и реальные данные не затрагивались.


## Проверка лимита аватаров и приватного медиахранилища

На кодовой ревизии [62305a5](https://github.com/spartakdubov059/fam-website/commit/62305a501f3f82c99c1d0317fe6b39277fc6b314) добавлен avatar-specific upload endpoint с лимитом 2 MiB. Перед созданием заявки сервер повторно проверяет размер сохранённого объекта; объект больше 2 MiB отклоняется с 413 и не попадает в очередь.

- [SDK/Sharp CI #44788806256](https://github.com/spartakdubov059/fam-website/actions/runs/44788806256) — success: **370/370** backend tests, сборка пакета Yandex Cloud Functions, pinned YDB/AWS SDK и Sharp/WebP smoke test.
- [Disposable YDB CI #44788806129](https://github.com/spartakdubov059/fam-website/actions/runs/44788806129) — success: схема и интеграционные сценарии на временной локальной YDB с синтетическими данными; контейнер удалён.
- В тесте аватаров отдельно проверяется, что размер свыше 2 MiB не создаёт заявку на модерацию.
- Cloud staging не создавался: подключение и бесплатная квота не подтверждены. Main, production и реальные школьные данные не затрагивались.


## Продолжение UI-паритета: профиль и Афиша

На коммите [22c05a7](https://github.com/spartakdubov059/fam-website/commit/22c05a7e90211e12a5f989b40d1adc5707fcfe71) подключён модуль настроек профиля в shell и добавлен отдельный фильтр «Афиша», включающий только записи с `is_event=true`.

- [SDK/Sharp CI #44789909380](https://github.com/spartakdubov059/fam-website/actions/runs/44789909380) — success, **371/371** backend tests, systemd timer validation и pinned SDK/Sharp/WebP checks.
- [Disposable YDB CI #44789909334](https://github.com/spartakdubov059/fam-website/actions/runs/44789909334) — success; схема и synthetic integration на disposable local YDB, с cleanup.
- Эти проверки не подтверждают полный паритет SPA и не являются cloud staging QA.


## Проверка Афиши и занятости мест

На кодовой ревизии [7fd8f02](https://github.com/spartakdubov059/fam-website/commit/7fd8f025f089fccbea321c86f9302316af69ac8d) добавлена проверка остатка мест для мероприятий с ограниченной вместимостью. Запрос выполняется только по нажатию пользователя, без массового fan-out при загрузке карточек; ответ строго проверяет диапазон счётчика и cache-control `no-store`.

- [SDK/Sharp CI #44790532457](https://github.com/spartakdubov059/fam-website/actions/runs/44790532457) — success, **372/372** backend tests и SDK/Sharp/WebP/timer checks.
- [Disposable YDB CI #44790532340](https://github.com/spartakdubov059/fam-website/actions/runs/44790532340) — success; synthetic repository integration прошла на одноразовой локальной YDB, cleanup выполнен.
- Эти тесты подтверждают только UI/API сценарий занятости; полный frontend parity и облачный staging не подтверждены.


## Проверка мобильной навигации

На ревизии [91d90e8](https://github.com/spartakdubov059/fam-website/commit/91d90e87f4435f4825e5e362f95751ce8b42c659) добавлена fixed bottom navigation с кнопками «Доска», «Афиша», «Сообщения», «Профиль». Переходы используют доступные same-origin UI/API; Афиша включает тот же event-only фильтр. Стили учитывают safe area и клавиатурную фокусировку.

- [SDK/Sharp CI #44791312376](https://github.com/spartakdubov059/fam-website/actions/runs/44791312376) — success, **374/374** backend tests; SDK/Sharp/WebP и systemd timers проверены.
- [Disposable YDB CI #44791312484](https://github.com/spartakdubov059/fam-website/actions/runs/44791312484) — success; disposable local YDB integration и cleanup завершились успешно.
- Изменение покрыто unit-проверками навигации и source-level shell isolation test; это не полный browser/device QA.


## Проверка главной карусели RU

На коммите [10ac3c0](https://github.com/spartakdubov059/fam-website/commit/10ac3c0248ff089cf6dc7b2af2a6036f6955315f) добавлена главная карусель из шести локальных banner-файлов с текстовыми alt, ручными кнопками и точками управления со screen-reader labels. Автопрокрутка отключена.

- [SDK/Sharp CI #44791905879](https://github.com/spartakdubov059/fam-website/actions/runs/44791905879) — success, **376/376** backend tests и SDK/Sharp/WebP/timer checks.
- [Disposable YDB CI #44791906120](https://github.com/spartakdubov059/fam-website/actions/runs/44791906120) — success, disposable local YDB synthetic integration и cleanup.
- Юнит-проверки проверяют создание точек, переход next/previous и ручной выбор слайда. Полный визуальный QA на реальных мобильных браузерах пока не проводился.


## Проверка приватной истории собственных идей

На кодовом коммите [58201a9](https://github.com/spartakdubov059/fam-website/commit/58201a9643d71dadd88ee8242b8d127b208c9a15) добавлен `GET /api/v1/me/ideas`: YDB query ограничен actor user ID, school ID и 50 результатами. API закрыт для гостя и профиля без школы. UI показывает только статусы/текст собственных идей и использует приватный endpoint изображений, который отдельно проверяет владельца или школьного модератора.

- [SDK/Sharp CI #44792802094](https://github.com/spartakdubov059/fam-website/actions/runs/44792802094) — success, **381/381** backend tests; SDK/Sharp/WebP/timers прошли.
- [Disposable YDB CI #44792801248](https://github.com/spartakdubov059/fam-website/actions/runs/44792801248) — success с synthetic integration и удалением одноразовой базы.
- Unit tests проверяют school/user scoping, 50-row cap, guest isolation и безопасный DOM rendering; это не browser QA.


## Навигация к истории идей профиля

На ревизии [8b4e77e](https://github.com/spartakdubov059/fam-website/commit/8b4e77eae249e62203fe58b6bc5965dfe7cf020a) профильная кнопка мобильной навигации сначала ведёт к приватной истории идей, если она доступна пользователю, и затем к настройкам профиля. Для гостя сохраняется переход к доступному разделу без открытия приватной истории.

- [SDK/Sharp CI #44793200966](https://github.com/spartakdubov059/fam-website/actions/runs/44793200966) — success, **382/382** backend tests.
- [Disposable YDB CI #44793200980](https://github.com/spartakdubov059/fam-website/actions/runs/44793200980) — success с synthetic integration и cleanup.

## Проверка guard для медиа — 20 ноября 2026

- Кодовый commit [64e4512](https://github.com/spartakdubov059/fam-website/commit/64e4512c0b89bc5f8c8927d859c3f5f6224888da) добавил синтетическую интеграционную проверку общего suspension guard с Media API: блокируются POST объявления/аватара, PATCH модерации изображения и DELETE pending-фото; репозиторий и объектное хранилище не вызываются.
- Точный [SDK/Sharp CI #44794320383](https://github.com/spartakdubov059/fam-website/actions/runs/44794320383) успешен: **383/383 backend-теста**, 8 systemd timer-файлов, YDB/AWS SDK compatibility и реальная Sharp/WebP обработка.
- Точный [Disposable YDB CI #44794320445](https://github.com/spartakdubov059/fam-website/actions/runs/44794320445) успешен на том же commit: схема применена, synthetic integration выполнена, временная база удалена cleanup-шагом. Облачный staging не создавался; облачные настройки YDB и S3, бюджет и IAM права остаются непроверенными.


## Afisha navigation regression — 20 ноября 2026

- Кодовый commit [84a8152](https://github.com/spartakdubov059/fam-website/commit/84a8152bf1eff4651737295d62061b9394c7c119) обновил мобильный переход «Афиша»: активируется фильтр событий и открывается начало школьной ленты; дальше располагается отфильтрованный список событий.
- [SDK/Sharp CI #44795219430](https://github.com/spartakdubov059/fam-website/actions/runs/44795219430): success, **383/383 backend/UI tests**, pinned SDK/Sharp и 8 systemd timer-файлов.
- [Disposable YDB CI #44795219480](https://github.com/spartakdubov059/fam-website/actions/runs/44795219480): success; synthetic integration и cleanup. Ни облачные ресурсы, ни реальные данные не использовались.
- Визуальное объединение типов карточек в одну сетку исходной Afisha остаётся незавершённым.


## Индексы школьных workflow — 20 ноября 2026

- На code commit [fd5b251](https://github.com/spartakdubov059/fam-website/commit/fd5b25138c579fb0297902d9570dad4dd9598b19) в `schema/29_fk_lookup_indexes.yql` добавлены 9 GLOBAL secondary indexes по найденным RU-полям заявок, блокировок и административного аудита. Индекс source `account_suspensions.target_id` уже покрывается ведущим полем RU primary key `(target_id, suspension_id)`.
- Точный [Disposable YDB CI #44799171636](https://github.com/spartakdubov059/fam-website/actions/runs/44799171636) успешно применил весь schema bundle и прошёл synthetic repository integration; временная база удалена.
- [SDK/Sharp CI #44799171773](https://github.com/spartakdubov059/fam-website/actions/runs/44799171773) завершился успешно: 383/383 backend/UI tests, pinned SDK, Sharp/WebP и timer checks.
- Проверено применение DDL, но не `EXPLAIN`-планы реальных RU запросов, selection planner или нагрузка на read/write units в Yandex Cloud. Облачные индексы не создавались.

## Публичные маршруты приватной очереди — 20 ноября 2026

- На коммите [c3b90e2](https://github.com/spartakdubov059/fam-website/commit/c3b90e2658802220984f4d3915828f6082f433fe) добавлен тест, который отправляет GET/POST к предполагаемым HTTP-путям трёх private YDB queue tables. Сервер возвращает `404 not_found` и не передаёт запрос generic user API. Fallback неизвестных `/api/*` путей теперь отвечает 404; известные API без настроенного backend по-прежнему fail closed как 503.
- Точный [SDK/Sharp CI #44800059646](https://github.com/spartakdubov059/fam-website/actions/runs/44800059646) прошёл **384/384** теста, проверил 8 timer-файлов, pinned YDB/AWS SDK и Sharp/WebP.
- Точный [Disposable YDB CI #44800060406](https://github.com/spartakdubov059/fam-website/actions/runs/44800060406) завершился успешно с synthetic integration и cleanup.
- Проверен публичный HTTP boundary; облачные YDB IAM/service-account права и эквивалент `FORCE ROW LEVEL SECURITY` не проверены, т.к. облачный staging не настроен.
