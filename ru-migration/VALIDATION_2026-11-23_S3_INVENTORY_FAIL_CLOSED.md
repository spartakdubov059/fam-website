# Безопасная обработка неполной S3-инвентаризации — 23 ноября 2026

`ListObjectsV2` теперь считается полной инвентаризацией только при явном булевом `IsTruncated=false`. При `true` continuation token должен быть задан и отличаться от предыдущего. Отсутствующее `Contents` допускается для пустого списка, но некорректная форма ответа или сломанная пагинация прерывает удаление аккаунта.

Покрыты четыре повреждённых ответа, обычная двухстраничная выборка, корректная пустая инвентаризация, чужой object key и сохранение durable deletion job без удаления/финализации при ошибке списка. Локальные тесты `s3-pending-store.test.mjs` + `recover-account-deletions.test.mjs` прошли **12/12**; `git diff --check` чист. Code commit [`68e4797`](https://github.com/spartakdubov059/fam-website/commit/68e4797b60dcf8a5c9915eb7915d95223d134f9a) прошёл [SDK/Sharp #45232613162](https://github.com/spartakdubov059/fam-website/actions/runs/45232613162) и [disposable YDB #45232613438](https://github.com/spartakdubov059/fam-website/actions/runs/45232613438); временная база удалена.

Это защита от неполного/некорректного ответа инвентаризации. Реальный Yandex Object Storage или IAM в этой проверке не использовались.
