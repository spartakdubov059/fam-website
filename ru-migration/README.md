Warning: truncated output (original token count: 11471)
Total output lines: 119

# FAM RU — изолированная миграция на российскую инфраструктуру

## Текущее состояние — 23 ноября 2026

- Последний опубликованный commit `migration/yandex-cloud`: [`b4d7c48`](https://github.com/spartakdubov059/fam-website/commit/b4d7c48bfd88e14b99de7dcb79d3ab25d66936be). Remote `main` при проверке: `bdb8325843f4d02590723d396d5b3f803d04618a`; эта работа передвигала только migration branch. Production, Netlify/Supabase, облачные ресурсы и реальные данные учеников не использовались.
- На Node `22.15.0` полный backend/UI suite: **501/501**; `compat/verify.mjs`: `SDK_COMPAT_PASS`. По exact head зелёные [disposable YDB integration #45114386830](https://github.com/spartakdubov059/fam-website/actions/runs/45114386830) и [SDK/Sharp CI #45114386784](https://github.com/spartakdubov059/fam-website/actions/runs/45114386784). YDB workflow применил схемы 01–37 и проверил синтетические репозитории/API, гонки регистрации и школьных администраторов, расписанный отчёт, bootstrap первого администратора, метрики/повторные coder leases и приватный S3 adapter через локальный HTTP; тестовая база удалена cleanup step. Это не Yandex Cloud staging.
- Архитектура использует Yandex Cloud, но запуск остаётся закрыт до подтверждения строго нулевого счёта, безопасных YDB IAM/Object Storage/OAuth/Postbox настроек и полного security/staging QA. Бесплатные месячные квоты не являются гарантией stop-at-zero. Личные/школьные реальные данные не импортировались.
- Текущий source `main` имеет 83 SQL migrations; все три последних файла, отсутствовавшие в локальном source snapshot, сохранены с точными Git blob SHA в [source-reference/supabase-migrations](source-reference/supabase-migrations/). Они предназначены только для сверки, не для запуска или применения.
- Перенос ещё неполный: автоматическая image-review очередь/vision worker и исходный AI coder/orchestrator не перенесены; также нужны полный текущий source-to-RU semantic audit, cloud IAM/media/OAuth checks и независимый security sign-off. См. [security review](SECURITY_REVIEW_2026-11-22.md), [migration coverage](MIGRATION_COVERAGE_2026-11-20.md), [database crosswalk](DATABASE_PORTING_CROSSWALK_2026-11-23.md), [inventory](SUPABASE_MIGRATION_INVENTORY_2026-11-20.md). Журнал выполнения ведётся рядом с рабочей папкой: `outputs/FAM_RU_PROGRESS_2026-11-20.md`.
- Обновление от 23 ноября: RU bridge поддерживает закрытый `metrics` action для агрегатов по фиксированному списку agent/status; ответ не содержит task ID, текста, payload или школьных/пользовательских данных. YDB queue восстанавливает только собственные просроченные coder leases с оставшимися попытками: сначала задача возвращается в очередь, старые lease/stage поля очищаются, затем claim выдаёт новый capability token. Финальный commit [`b4d7c48`](https://github.com/spartakdubov059/fam-website/commit/b4d7c48bfd88e14b99de7dcb79d3ab25d66936be) прошёл [disposable YDB integration #45114386830](https://github.com/spartakdubov059/fam-website/actions/runs/45114386830) и [SDK/Sharp CI #45114386784](https://github.com/spartakdubov059/fam-website/actions/runs/45114386784); локальный suite — 501/501.
- Локальная предшествующая история сохранена в `codex/famru-local-history-final-20261123`; GitHub connector не мог отправить локальные git objects, поэтому remote migration branch хранит import snapshot commit `727c56e` поверх прежнего remote head, затем последовательные проверочные исправления. Основная ветка не переписывалась.

Разделы ниже содержат исторические заметки и доказательства для отдельных этапов; их прошлые формулировки вроде «текущая локальная ветка» могли устареть. Для статуса и readiness ориентируйтесь на эту сводку и на датированные записи журнала.

**Исторический snapshot от 18 ноября 2026:** commit `fb6db48ea936b3b463e9ea48c8306f9ed0987f82` прошёл [YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44214855146) со схемами 01–30 и [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44214855038), включая проверку systemd-календарей на Linux. На этом snapshot локально прошли `297/297` тестов и проверка шести расписаний. Более новое состояние приведено выше и в [истории сверки source → RU](SOURCE_SYNC_2026-11-20.md).





**Историческая запись о ветке на момент подготовки данного раздела:** локальная review-ветка `codex/fam-ru-photo-access-guard`; целевая ветка `migration/yandex-cloud`. Текущие refs и проверки приведены в начале файла.
Цель — подготовить российскую копию FAM отдельно от действующего сайта. Ветка `main`, текущий FAM, Netlify/Supabase и реальные данные учеников не используются для этих проверок.

## Обновление исходного FAM от 21 ноября 2026

В свежем `main` `147ec7903148bfface274c4e681aabb299252dcf` появилась политика приватности доски: объявления видны только участникам своей школы; гостям показывается вход. Это поведение перенесено в RU API, YDB school-scoped запрос, выдачу фото и счётчик занятых мест. Локальные backend/UI тесты прошли `430/430`; на commit [`575491f`](https://github.com/spartakdubov059/fam-website/commit/575491ffe354472371205e59fb5da12790659229) успешны [disposable YDB integration](https://github.com/spartakdubov059/fam-website/actions/runs/44941925237) и [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44941925377). Подробности: [проверка ограничения доски](VALIDATION_2026-11-21_SCHOOL_LISTING_PRIVACY.md). В следующем коммите [`ea7325e`](https://github.com/spartakdubov059/fam-website/commit/ea7325e187887dddf47457b71acd97107dac3145) добавлена защита форм объявления и идеи от быстрых повторных отправок; целевые тесты прошли **14/14**, полный набор — **432/432**. Обновлённые Netlify production workflow и сборка выпуска намеренно …7471 tokens truncated…ов, открытых обращений и статусов идей. Отчёт не содержит свободного текста, имён, идентификаторов или содержимого переписки, не вызывает модель и не публикуется через пользовательский API. Добавлены схема `21_agent_daily_reports.yql`, одноразовый YDB интеграционный сценарий и systemd unit/timer на 06:00 UTC; расписание не установлено и не включено. На коммите `933edbbc29bc1df5b21ed7f4d5266191cf2cc2b2` прошли [SDK/Sharp CI — 227/227 тестов](https://github.com/spartakdubov059/fam-website/actions/runs/43640649867) и [одноразовая YDB интеграция](https://github.com/spartakdubov059/fam-website/actions/runs/43640649790) с синтетической базой. Остальные пять исходных расписаний пока не перенесены.

### Обезличенная телеметрия интерфейса FAM RU (15 ноября 2026)
Ошибки RU-shell отправляют только закрытый список кодов и зон на `/api/v1/site-errors`. Backend отвергает другой источник и неизвестные значения, не читает текст ошибки, ограничивает тело запроса 1 КБ и хранит не более 1000 событий на код/зону за час. Для строк задан 30-дневный TTL; фоновая очистка YDB может происходить позже срока. На коммите `8edb376a7de905afba6d40bafb86d3c38410ce72` прошли [SDK/Sharp CI — 236/236 тестов](https://github.com/spartakdubov059/fam-website/actions/runs/43643594379) и [одноразовая YDB интеграция](https://github.com/spartakdubov059/fam-website/actions/runs/43643594372), включая проверку нового порога. Использовалась только временная локальная YDB и синтетические записи. Расписание исходного аудитора, очередь фоновых задач и digest остаются выключенными и неперенесёнными. **21 ноября 2026:** аудит обнаружил, что агрегаты и digest без школьного фильтра были доступны школьному администратору; endpoint и его интерфейс удалены из школьной панели. Счётчики остаются внутренней операционной телеметрией и не выдаются через школьный API. Исправление: коммит `6128443cb2090e81fac6a409907e93c9e0fb3559`; после него прошли `425/425` backend-тестов и `compat/verify.mjs`.


### Свежая проверка YDB (14 ноября 2026)

Исторический одноразовый YDB прогон временных ограничений использовал синтетическую identity с заранее заданным свежим временем входа; он проверяет только DB/API транзакции при таком доверенном входном сигнале. Текущий Yandex ID адаптер не может сформировать этот сигнал, поэтому прогон не доказывает возможность выполнить выдачу/снятие через реальный вход. На ревизии [`8e56eff`](https://github.com/spartakdubov059/fam-website/commit/8e56eff44a73ef69069a00f60462793f6a8ec1fd) доступны исторические [YDB workflow](https://github.com/spartakdubov059/fam-website/actions/runs/43603508334) и [SDK/Sharp workflow](https://github.com/spartakdubov059/fam-website/actions/runs/43603508464). Облачное окружение не создавалось, подтверждённого бесплатного подключения нет; см. `PORTING_INVENTORY.md`.


### Снятие школьных ролей
В российской копии добавлено снятие роли участника Совета или второго администратора школы. Проверка свежего входа, школьной изоляции и защиты последнего администратора выполняется сервером в транзакции; изменение атомарно записывается в аудит. Синтетические проверки прошли: [YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/43606730112) и [backend/SDK CI](https://github.com/spartakdubov059/fam-website/actions/runs/43606730061), оба на коммите ff9e3375dbcc643f76ff01b21afbd7a851effe02. Полный перенос остаётся незавершённым.


### Новая школьная лента (14 ноября 2026)

Школьные объявления, важные новости, открытые события, опросы и уникальное голосование перенесены в изолированную ветку. Node 22 backend suite прошёл `174/174`; [одноразовая YDB интеграция](https://github.com/spartakdubov059/fam-website/actions/runs/43610052824) и [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/43610052928) прошли на коммите `c07c46f543b198d1ec1af09aa1361478c9045a9a`. Это не облачный staging: реальный OAuth/хостинг не настроены, `main` и production не затронуты, платные ресурсы не создавались.


### Собственное удаление аккаунта (14 ноября 2026)
Удаление теперь идёт через российский backend: требуется свежее подтверждение Яндекс ID, точная фраза, защита последнего администратора, очистка S3 и транзакционная очистка YDB. На коммите `02c5db8a9c0661c3f66698343cfb679c5d57dfe0` прошли `182/182` backend-теста, [YDB integration](https://github.com/spartakdubov059/fam-website/actions/runs/43613056160) и [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/43613056158). Реальные аккаунты и облачное staging не использовались; удаление аккаунта через заявку Совета остаётся отдельной незавершённой функцией.


**Обновление 22 ноября 2026:** добавлена YDB schema `34_source_lookup_indexes.yql` для cleanup медиа и school-scoped safety attribution; на точном commit `6497b402ad99a7808fde688f93d823968694aa7c` disposable YDB CI #44951135661 и SDK/Sharp CI #44951135767 завершились успешно. Автоматический image classifier и Qwen worker не подключены; cloud staging, Yandex IAM и безусловный расход `0 ₽` не подтверждены.


**Обновление 22 ноября 2026:** карточка объявления получила диалог подробностей с доступным управлением, безопасным отображением текста и одобренным same-origin фото. Удалённая SDK/Sharp CI #44951920176 и synthetic YDB CI #44951920097 прошли на exact commit `87f1526f930d9b45a324c12ff238243562d45ae1`; браузерное визуальное QA и cloud staging ещё не выполнены.
