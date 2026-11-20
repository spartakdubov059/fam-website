# FAM RU — проверка на 2026-11-20

## Исправление очередей отчётов

- Ветка: `migration/yandex-cloud`; восстановленное изменение зафиксировано в [`80923c2`](https://github.com/spartakdubov059/fam-website/commit/80923c2325ddc0926ff562b9806d5f04ee534664).
- Причина предыдущего сбоя: commit [`7c3dfec`](https://github.com/spartakdubov059/fam-website/commit/7c3dfec48f122170f82197c1672dde268ab8ed1d) содержал текст предупреждения об обрезке вывода внутри `ydb-listings.mjs`; этот commit был отклонён CI и не развёртывался.
- Исправление восстановило полный репозиторный файл и добавило только ручную проверку агрегатов двух RU очередей. Запросы не выбирают содержимое отчётов, пользовательские идентификаторы или сообщения; запуск не включает таймер.
- Локально: backend `node --test ru-migration/app/backend/test/*.test.mjs` — **298/298**; `node ru-migration/compat/verify.mjs` — **SDK_COMPAT_PASS**; `git diff --check` — без ошибок.
- [SDK/Sharp CI, run 44630395115](https://github.com/spartakdubov059/fam-website/actions/runs/44630395115) завершился успешно.
- [Disposable local YDB CI, run 44630395135](https://github.com/spartakdubov059/fam-website/actions/runs/44630395135) завершился успешно: изолированная схема и интеграционные проверки на синтетических данных прошли; временная база удалена шагом очистки.

## Границы проверки

Это не облачный Yandex Cloud staging и не проверка production credentials. На 2026-11-20 доступность бесплатных Yandex Cloud ресурсов с жёстким пределом 0 ₽ не подтверждена; облачные ресурсы не создавались. Полный перенос исходных функций FAM, независимая полная security-проверка и staging QA остаются незавершёнными. Реальные данные не использовались. Pull request и развёртывание не создавались.


## Проверка подтверждения Yandex ID (20 ноября 2026)

- Код закреплён коммитом [047a5e1](https://github.com/spartakdubov059/fam-website/commit/047a5e1d844034705b212a4c0533fb6b8a999d59) в ветке migration/yandex-cloud. Обычная Yandex OAuth-сессия больше не выдаёт время создания приложения за время повторной аутентификации. Только OAuth flow с подписанным state reauth=1 добавляет отдельную отметку явного подтверждения; она проверяется для удаления аккаунта/публикации, отзыва роли и ограничения аккаунта.
- На официальном Node 22.23.5: npm ci, npm test — 300/300, npm audit — 0 уязвимостей; git diff --check — чисто.
- [SDK/Sharp CI, run 44641934637](https://github.com/spartakdubov059/fam-website/actions/runs/44641934637) — PASS: установка pinned зависимостей, backend suite, systemd и native Sharp/WebP.
- [Disposable YDB CI, run 44641934710](https://github.com/spartakdubov059/fam-website/actions/runs/44641934710) — PASS: схема и synthetic integration; временная база удалена.
- Это не российский облачный staging. Полный security scan остаётся незавершённым: Codex Security не завершил проверку ветки из-за ошибок/тайм-аута. Реальные данные учеников, main, production и платные ресурсы не затрагивались.

