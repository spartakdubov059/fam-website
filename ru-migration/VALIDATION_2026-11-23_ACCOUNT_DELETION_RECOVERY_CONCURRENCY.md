# Параллельное восстановление удаления аккаунта — 23 ноября 2026

В integration fixture удаление синтетического аккаунта сначала создаёт durable job, затем срок его claim lease истекает. Два вызова recovery worker выполняются параллельно. Проверяется, что ровно один вызов claim-ит и завершает job, объект закрытого S3 media удаляется ровно один раз, профиль и durable job после успеха отсутствуют.

Локальные unit-тесты `recover-account-deletions.test.mjs` прошли **2/2**; `compat/verify.mjs` завершился `SDK_COMPAT_PASS`, `integration-ydb.mjs` прошёл syntax check. Disposable YDB CI [#45231494699](https://github.com/spartakdubov059/fam-website/actions/runs/45231494699) прошёл; шаг удаления disposable DB также успешен. SDK/Sharp/package workflow [#45231494560](https://github.com/spartakdubov059/fam-website/actions/runs/45231494560) прошёл.

Это тестовый сценарий в одноразовой локальной YDB с синтетическим аккаунтом и in-memory media inventory. Он не проверяет Yandex Cloud IAM или реальный Object Storage. Ни production, ни пользовательские данные не затрагивались.
