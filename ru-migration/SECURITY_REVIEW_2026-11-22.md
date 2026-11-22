# Офлайн security review FAM RU — 22 ноября 2026

Автоматизированный Standard scan был выполнен на неизменяемом снимке ветки `migration/yandex-cloud`, commit [`4cd328e`](https://github.com/spartakdubov059/fam-website/commit/4cd328ef9cf3f0b61475a21feb8c85cb07d7fd8b). Впоследствии ручная сверка с исходной политикой профилей FAM обнаружила, что одобренный аватар в этом снимке можно было прочитать без входа и публично кешировать. Исправление внесено в commit [`2c6b12e`](https://github.com/spartakdubov059/fam-website/commit/2c6b12e14f157ae9e50935979139c1177039ae9b): чтение доступно только владельцу активного профиля, ответы `private, no-store`; добавлены тесты гостя, другого участника и другой школы. На исправленном коммите успешно прошли [SDK/Sharp CI #44981040324](https://github.com/spartakdubov059/fam-website/actions/runs/44981040324) и [синтетическая YDB CI #44981040394](https://github.com/spartakdubov059/fam-website/actions/runs/44981040394).

Полный машиночитаемый отчёт исходного сканирования хранится локально вне репозитория:

`/Users/spartakdubov/.codex/state/plugins/codex-security/scans/fam-ru-remote-head/unversioned_20261122T025626Z_n32jr_ts/report.md`

## Результат

- На исходном снимке сканер сообщил **0 подтверждённых находок** в восьми рассмотренных областях. Этот результат не относится к исправленному коду и оказался неполным: последующая ручная сверка выявила описанный выше дефект приватности аватара, который теперь исправлен и покрыт регрессионным тестом.
- Сканирование было офлайн, без исходных изменений, облачных ключей, production-доступа и данных учеников. Исправление после сканирования прошло указанные CI, включая YDB на синтетических данных.
- Исследованы в частности `server.mjs`, `runtime.mjs`, Yandex ID/OIDC, database actor resolver, media API/S3 adapter, listings API/repository, coder-task bridge/queue и браузерный каталог RU.

## Ограничения

- Управляемый deep scan не запустился: среда не предоставила требуемый read-only профиль для worker. Выполнен Standard source review одним проверяющим; независимой второй проверки и повторного сканирования нового снимка не было.
- Проверка не подтверждает настройки Yandex IAM, OAuth приложения, реальной политики Object Storage, сетевых ACL, service account, секретов, установленных таймеров или работу облачного staging.
- Полный поведенческий паритет с 80 SQL-миграциями, 7 Edge Functions, RLS/grants/RPC/triggers и всеми экранами не доказан. Инвентаризация имён и сопоставленные функции — не замена полной пооперационной проверке.
- Поэтому результат означает только отсутствие подтверждённых дефектов в просмотренных поверхностях; он не является разрешением на эксплуатацию с реальными школьными данными.

## Решение по staging

Staging не создавался. В текущих условиях нельзя доказать безусловную стоимость `0 ₽` или проверить правильность реальной облачной конфигурации. Чтобы сохранить это требование, изменения ресурсов, включение расписаний и публикация остаются остановлены.

## Проверка HTTP-заголовков — 23 ноября 2026

В текущем RU code commit [`04d3bb2`](https://github.com/spartakdubov059/fam-website/commit/04d3bb21a8ded7e498d26c1822ef611d5835f3b5) общий набор `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` и host-only HSTS применяется к статике, JSON, медиа, OAuth-redirects и ошибкам адаптера Yandex Cloud Functions. Для страниц сохраняется строгая CSP без `unsafe-inline`. Node 22 backend suite прошёл **471/471** в [SDK/Sharp CI #45074378620](https://github.com/spartakdubov059/fam-website/actions/runs/45074378620); disposable YDB integration со схемой, синтетическими данными, тестом school-admin bootstrap, local HTTP S3 adapter и удалением временной базы прошла [CI #45074378635](https://github.com/spartakdubov059/fam-website/actions/runs/45074378635). Это кодовый контроль: фактическое прохождение заголовков через настроенный Yandex endpoint и live TLS остаётся непроверенным.
