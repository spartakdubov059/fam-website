# Проверка объединённой RU-Афиши — 21 ноября 2026

- Код: [`ca0c213`](https://github.com/spartakdubov059/fam-website/commit/ca0c213c21f7eea0e1429292b683f99a1b6a2c88), ветка `migration/yandex-cloud`.
- Новости школы, опросы и карточки мероприятий помещены в общий адаптивный grid; мобильная кнопка «Афиша» открывает его и выбирает только события. Все обращения остаются в RU API.
- Локально: **400/400** backend/UI тестов; compat verifier и `git diff --check` прошли. Точечные проверки Afisha/navigation/shell: **25/25**.
- [SDK/Sharp workflow #437](https://github.com/spartakdubov059/fam-website/actions/runs/44823541506) и [disposable YDB workflow #401](https://github.com/spartakdubov059/fam-website/actions/runs/44823541688) — `success`. YDB сценарий использовал synthetic data и удалил disposable container.
- Российский облачный staging и гарантированная стоимость `0 ₽` по-прежнему не подтверждены. Полный UI/API паритет, полный SQL/RLS audit и независимый security review не закрыты. `main`, production, пользовательские данные и платные ресурсы не затрагивались.
