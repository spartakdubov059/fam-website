# Проверка FAM RU — 20 ноября 2026

## Актуальное уточнение (20 ноября 2026)

- Текущая `migration/yandex-cloud` указывает на документационный commit [`83a8c3f`](https://github.com/spartakdubov059/fam-website/commit/83a8c3f82d0935a32f4dbe21daa7ed615c4cc8a4), его родитель — [`7c4586f`](https://github.com/spartakdubov059/fam-website/commit/7c4586f32fef6b4497048fbf77dfa4ae99065d0a). Оба коммита меняют только этот журнал; исходное локальное дерево до его правки совпадало с [`a729b6f`](https://github.com/spartakdubov059/fam-website/commit/a729b6f8ed7b80ef5dcb7f421e84412245d63885). Истории Git локальной и удалённой веток расходятся, поэтому обычный push из checkout не использовать.
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

