# Инвентаризация переноса FAM RU

## Актуальная сверка исходника (20 ноября 2026)

> Важно: RU-ветка основана на `migration/yandex-cloud` `2795f05`, а не на актуальном `main` `5e749c5`. Полный список 9 SQL migrations и 6 изменённых Edge Functions между этими ref сопоставлен с YDB/API в [SOURCE_CROSSWALK_2026-11-20.md](SOURCE_CROSSWALK_2026-11-20.md). Это функциональные аналоги с отличиями, не полный перенос и не доказательство parity всех upstream функций.

- Прямая проверка GitHub ref разрешает `main` в [`5e749c56`](https://github.com/spartakdubov059/fam-website/commit/5e749c56b9270efbfdf1f48cefe6e8d95a01c579), parent [`7532820`](https://github.com/spartakdubov059/fam-website/commit/75328206895898ab99c1ac3098de6deceda09459): 78 SQL migrations и 7 Edge Functions. Локальная tracking-ссылка `origin/main` отставала на `7fd4182`; проверка выполнена прямым fetch.
- Все 78 миграций ещё не сопоставлены построчно с YDB схемой и backend API. RLS, RPC и триггеры требуют проверки эквивалентности операций и границ доступа.
- Семь активных расписаний и отменённое старое задание описаны в [CRON_PORTING.md](CRON_PORTING.md). RU unit/timer-файлы не устанавливаются и не включаются автоматически.
- Полное соответствие upstream, аудит всех маршрутов/хранилищ и российский облачный staging не подтверждены. Нет настроенных Yandex OAuth, YDB/S3 credentials; реальные пользовательские данные не используются.
- RU-копия поддерживает школьные опросы с 2–8 ответами. В ревизии [`0d3be3a`](https://github.com/spartakdubov059/fam-website/commit/0d3be3a5a5b5ea0466340b1e794cff75babed647) добавлена YDB очередь для четырёх фиксированных агрегатных задач; она не получает содержимое произвольных задач и не вызывает внешн