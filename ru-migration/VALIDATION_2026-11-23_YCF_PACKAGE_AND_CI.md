# Проверка пакета Cloud Functions и CI FAM RU — 23 ноября 2026

## Текущая ревизия

- Код: [`ebac25367c99c92fe9dcc4050c1e0ae1ab6ed89d`](https://github.com/spartakdubov059/fam-website/commit/ebac25367c99c92fe9dcc4050c1e0ae1ab6ed89d), ветка `migration/yandex-cloud`.
- Изменение кода на этом коммите сверяет заявленный JPEG/PNG/WebP MIME с фактическим форматом, декодированным Sharp; несоответствие отклоняется до записи в объектное хранилище.

## Удалённые проверки на точном коммите

- [SDK/Sharp и пакет Cloud Functions, run #45235353513](https://github.com/spartakdubov059/fam-website/actions/runs/45235353513) завершился успешно. Прошли состав и сборка прямого ZIP, запуск HTTP и Timer entrypoints из ZIP, закреплённые зависимости, полный backend/UI `npm test`, проверка расписаний и native Sharp/SDK smoke.
- [Одноразовая YDB интеграция, run #45235353704](https://github.com/spartakdubov059/fam-website/actions/runs/45235353704) завершилась успешно. Применены схемы RU, прошли синтетические сценарии repository/API, школьный отчёт, конкурентный bootstrap первого администратора и private S3 adapter. Шаг удаления disposable DB тоже завершился `success`.
- Локально профильная проверка изображений и media API: **25/25**; весь backend-набор: **519/519**; `compat/verify.mjs`: `SDK_COMPAT_PASS`; diff whitespace check прошёл.

## Пакет для локальной передачи

- Локальный ZIP в Codex workspace: `outputs/FAM_RU_YCF_ebac253.zip`.
- Node.js runtime: `nodejs22`; размер `1,385,030` байт; `147` файлов; handlers `index.handler` и `timer.handler`.
- SHA-256: `b2e12e7d4be5047d1af036498f97aec2de874adf57ed20e46a06e872be8174d5`.
- Локальный smoke установленного ZIP завершился `PACKAGED_YCF_ENTRYPOINTS_PASS`: HTTP вернул `200` с CSP, Timer без облачной конфигурации отказал до выполнения задания.

## Строгий лимит расходов

Официальная [документация Yandex Cloud о free tier](https://yandex.cloud/ru/docs/billing/concepts/serverless-free-tier), обновлённая 9 ноября 2026 года, указывает бесплатные месячные объёмы, после которых начинается тарификация: API Gateway — 100,000 запросов; Cloud Functions — 1,000,000 вызовов и 10 ГБ×час; Managed YDB — 1,000,000 RU и 1 ГБ хранения; Object Storage — 1 ГБ хранения, 10,000 PUT/POST/PATCH/LIST и 100,000 GET/HEAD/OPTIONS; Postbox — 2,000 исходящих писем. Квоты учитываются совместно по связанному платежному аккаунту и его облакам.

Yandex [прямо указывает](https://yandex.cloud/ru/docs/billing/concepts/budget), что бюджет отправляет уведомление при достижении порога и не влияет на дальнейшее потребление. Следовательно, месячная квота и budget не дают жёсткого барьера `0 ₽` для публичного сервиса. Это вывод из правил тарификации; атака, нагрузка или использование других связанных облаков могут расходовать квоту быстрее ожидаемого.

## Ограничения проверки

- Ни одна функция, API Gateway, база YDB, бакет или Timer trigger не создавались в Yandex Cloud. Реальные ученические данные не использовались. Реальные OAuth, IAM, Postbox и Object Storage endpoint не проверялись.
- Коммиты `main` и production не изменялись. Локальный архив предназначен только для ручной передачи; CI не публиковал его в облако.
- Эти проверки подтверждают пакет и синтетическую интеграцию, но не независимый security sign-off и не готовность к публичному запуску.
