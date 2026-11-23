# Проверка параллельной первичной выдачи school-admin — 23 ноября 2026

Bootstrap запускается только явной operator-командой, требует скрытый временный access token, сверяет identity через Yandex ID, ограничивает школы allowlist и пишет профиль, одноразовый marker и audit event в YDB транзакции. Проверка по очереди уже была покрыта; этот сценарий добавляет конкурентные запросы двух разных синтетических identity на одну чистую школу.

В disposable YDB CI оба запроса выполнялись одновременно. Условие успеха: ровно одна identity создана, в школе ровно один активный `school_admin`, marker указывает на победившую запись, существует соответствующий audit event, повторная попытка возвращает `already_bootstrapped`. Шаг [Exercise one-time school admin bootstrap on synthetic data](https://github.com/spartakdubov059/fam-website/actions/runs/45230364940) прошёл; SDK/Sharp/package workflow [#45230364708](https://github.com/spartakdubov059/fam-website/actions/runs/45230364708) также прошёл. Локальный `profile-requests.test.mjs` — **5/5**.

Это проверяет транзакционное поведение в одноразовой локальной YDB, не Yandex Cloud IAM, работу оператора с реальным токеном или настоящие school accounts. Облачный bootstrap не выполнялся; реальные данные не использовались.
