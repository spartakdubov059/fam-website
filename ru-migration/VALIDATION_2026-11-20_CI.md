# Проверка FAM RU — 20 ноября 2026

- Обновлены только CI actions на изолированной ветке `migration/yandex-cloud`: checkout v7, setup-node v7, upload-artifact v6. Автоматическое кэширование npm отключено; зависимости продолжают устанавливаться через `npm ci` по lock-файлам.
- [SDK/Sharp CI](https://github.com/spartakdubov059/fam-website/actions/runs/44635841849) — успешно. Node 22; установленные YDB/AWS SDK, Sharp и весь backend suite.
- [Disposable YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/44635918742) — успешно. Схема и интеграционные сценарии проверены на синтетической локальной базе; контейнер удаляется шагом cleanup.
- Повторный локальный backend suite: 299/299 прошло на Node v24.22.1. Локальный Node вне заданного диапазона проекта (22.15–<23), поэтому версию Node 22 подтверждает CI.
- Предыдущие workflow показывали предупреждения о принудительном запуске старых actions на Node 24; новые workflow используют actions с официальным Node 24 runtime.
- Профильный Codex Security diff scan не стартовал: инструмент вернул «Review changes requires a non-bare Git worktree with a resolvable HEAD» даже для чистой отдельной worktree на точном диапазоне. Security review не считать завершённым.
- Российский облачный staging, production, `main` и реальные данные не затрагивались. Бесплатная публичная среда с жёсткой защитой от списаний не подтверждена.

