Warning: truncated output (original token count: 7897)
Total output lines: 83

# FAM RU — изолированная миграция на российскую инфраструктуру

**Последняя проверка кода — commit `6bcc87fe050e3e9260df4346d26feaf86ebeaec1` (18 ноября 2026):** [одноразовая YDB интеграция](https://github.com/spartakdubov059/fam-website/actions/runs/44204474631) успешно применила схемы 01–29 и прошла синтетические проверки приложения с четырьмя lookup-индексами; тестовая база была удалена. [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44204474686) прошёл `292/292` backend-теста на Node 22, закреплённые зависимости и нативную обработку изображений; проверены шесть systemd timer-файлов и их календарные выражения. Это одноразовая локальная YDB в CI, не российское облачное staging. Бесплатный хост, облачные credentials и production OAuth не настроены; независимый security audit не завершён. `main`, production и реальные данные учеников не затронуты.





**Рабочая ветка: `migration/yandex-cloud`. Не сливать в main и не развёртывать на production.**
Цель — подготовить российскую копию FAM отдельно от действующего сайта. Ветка `main`, текущий FAM, Netlify/Supabase и реальные данные учеников не используются для этих проверок.

## Подтверждено сейчас

- Повторная проверка чистого checkout на ветке `migration/yandex-cloud`, commit `095c02d863da9cf09b8e522788a1d3ee55311057`: `npm ci` и `npm test` на Node 22.15.0 прошли (`166/166`); `ru-migration/compat/verify.mjs` подтвердил pinned YDB/AWS SDK и Sharp/WebP. Для кода на родительском commit `ff9e3375dbcc643f76ff01b21afbd7a851effe02` GitHub Actions успешно выполнил одноразовую YDB интеграцию [#43606730112](https://github.com/spartakdubov059/fam-website/actions/runs/43606730112) и SDK/Sharp CI [#43606730061](https://github.com/spartakdubov059/fam-website/actions/runs/43606730061). `095c02d` после этого менял только документацию. Облачного staging нет.
- Актуальный прогон: commit `89cbdd98691a6cf7d3ebf305cf50ff25fa608bc0` восстановил полный RU shell, добавил форму заявки на удаление аккаунта, историю заявителя и очередь школьного администратора с безопасным отклонением. Локально прошли `160/160` backend-тестов; [Node 22 SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/43597570797) успешно установил закреплённые SDK, повторил backend-тесты и проверил нативную обработку изображений. [Одноразовая YDB интеграция](https://github.com/spartakdubov059/fam-website/actions/runs/43597187699) прошла на синтетических данных для предыдущего коммита с тем же backend/schema. Российского облачного staging нет.
- На commit `d50c900b7c9011589a61da5e7f0fab249e8899dd` прошли [138 backend-тестов на Node 22, установка закреплённых SDK и Sharp](https://github.com/spartakdubov059/fam-website/actions/runs/43517554535) и [интеграция на одноразовой локальной YDB](https://github.com/spartakdubov059/fam-websi…5897 tokens truncated…fam-website/actions/runs/43643594372), включая проверку нового порога. Использовалась только временная локальная YDB и синтетические записи. Расписание исходного аудитора, очередь фоновых задач и digest остаются выключенными и неперенесёнными.


### Свежая проверка YDB (14 ноября 2026)

Управление временными ограничениями школы прошло одноразовую интеграцию на синтетических данных YDB: выдача/снятие, школьная изоляция, защита от дубликатов, аудит и свежая аутентификация. Проверенный коммит: `8e56eff44a73ef69069a00f60462793f6a8ec1fd`; [YDB workflow](https://github.com/spartakdubov059/fam-website/actions/runs/43603508334), [SDK/Sharp workflow](https://github.com/spartakdubov059/fam-website/actions/runs/43603508464). Облачное окружение не создавалось: подтверждённого бесплатного подключения и credentials нет. Перенос FAM остаётся незавершённым; см. `PORTING_INVENTORY.md`.


### Снятие школьных ролей
В российской копии добавлено снятие роли участника Совета или второго администратора школы. Проверка свежего входа, школьной изоляции и защиты последнего администратора выполняется сервером в транзакции; изменение атомарно записывается в аудит. Синтетические проверки прошли: [YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/43606730112) и [backend/SDK CI](https://github.com/spartakdubov059/fam-website/actions/runs/43606730061), оба на коммите ff9e3375dbcc643f76ff01b21afbd7a851effe02. Полный перенос остаётся незавершённым.


### Новая школьная лента (14 ноября 2026)

Школьные объявления, важные новости, открытые события, опросы и уникальное голосование перенесены в изолированную ветку. Node 22 backend suite прошёл `174/174`; [одноразовая YDB интеграция](https://github.com/spartakdubov059/fam-website/actions/runs/43610052824) и [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/43610052928) прошли на коммите `c07c46f543b198d1ec1af09aa1361478c9045a9a`. Это не облачный staging: реальный OAuth/хостинг не настроены, `main` и production не затронуты, платные ресурсы не создавались.


### Собственное удаление аккаунта (14 ноября 2026)
Удаление теперь идёт через российский backend: требуется свежее подтверждение Яндекс ID, точная фраза, защита последнего администратора, очистка S3 и транзакционная очистка YDB. На коммите `02c5db8a9c0661c3f66698343cfb679c5d57dfe0` прошли `182/182` backend-теста, [YDB integration](https://github.com/spartakdubov059/fam-website/actions/runs/43613056160) и [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/43613056158). Реальные аккаунты и облачное staging не использовались; удаление аккаунта через заявку Совета остаётся отдельной незавершённой функцией.
