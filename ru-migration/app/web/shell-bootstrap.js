// Send only fixed error codes to the isolated Russian backend; never send error text.
const FAM_RU_DIAGNOSTIC_CODES = new Set([
  "js_runtime", "unhandled_rejection",
  "listings_load_failed", "notifications_load_failed",
  "database_request_failed", "auth_backend_failed"
]);
const FAM_RU_DIAGNOSTIC_AREAS = new Set(["auth", "listings", "notifications", "database", "other"]);
function reportFamSiteError(eventCode, pageArea) {
  if (!FAM_RU_DIAGNOSTIC_CODES.has(eventCode) || !FAM_RU_DIAGNOSTIC_AREAS.has(pageArea)) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  fetch("/api/v1/site-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_code: eventCode, page_area: pageArea }),
    keepalive: true
  }).catch(() => {});
}

window.onerror = function() {
  console.error("Ошибка JavaScript FAM RU");
  reportFamSiteError("js_runtime", "other");
  return false;
};
window.onunhandledrejection = function() {
  console.error("Необработанный промис FAM RU");
  reportFamSiteError("unhandled_rejection", "other");
};

(function(){
    document.body.innerHTML = `
      <main class="ru-shell">
        <h1>FAM RU</h1>
        <p class="ru-note">Российская копия работает отдельно от основного FAM. Объявления и фотографии хранятся через российский backend.</p>
        <a class="ru-auth-link" href="/auth/yandex/start">Войти через Яндекс ID</a>
        <button id="ruOpenMessages" class="ru-button" type="button" aria-expanded="false" aria-controls="ruMessages">Мои сообщения</button>
        <button id="ruLogout" class="ru-button" type="button" hidden>Выйти</button>
        <p id="ruSubmitStatus" class="ru-note" role="status" aria-live="polite">Войдите через Яндекс ID, чтобы подать объявление.</p>
        <section id="ruAccountWorkflow" class="ru-account-workflow" hidden aria-label="Управление аккаунтом"></section>
        <section id="ruAvatarWorkflow" class="ru-avatar-workflow" hidden aria-label="Фото профиля"></section>
        <section id="ruIdeaHistory" class="ru-idea-history" hidden aria-label="Мои идеи"></section>
        <section id="ruOwnListings" class="ru-account-workflow" hidden aria-label="Мои объявления"></section>
        <form id="ruListingForm" class="ru-listing-form" hidden>
          <label>Название<input name="title" maxlength="80" required></label>
          <label>Описание<textarea name="description" maxlength="1000" required></textarea></label>
          <button id="ruDescriptionHelperToggle" class="ru-button ru-description-helper-toggle" type="button">✦ Составить описание</button>
          <section id="ruDescriptionHelper" class="ru-description-helper" hidden aria-label="Локальная помощь с описанием">
            <p id="ruDescriptionHelperNote" class="ru-note" role="status" aria-live="polite"></p>
            <label>Черновик<textarea id="ruDescriptionDraft" maxlength="1000" rows="7"></textarea></label>
            <p id="ruDescriptionSuggestions" class="ru-note"></p>
            <div class="ru-description-helper-actions"><button id="ruDescriptionApply" class="ru-button" type="button">Применить текст</button><button id="ruDescriptionClose" class="ru-button ru-button-secondary" type="button">Закрыть</button></div>
          </section>
          <label>Категория<select name="category" required><option value="Вещи">Вещи</option><option value="Услуги">Услуги</option><option value="Творчество">Творчество</option><option value="Учёба">Учёба</option><option value="Мероприятия">Мероприятия</option></select></label>
          <p id="ruCategoryHint" class="ru-category-hint" role="status" aria-live="polite">Начните вводить название и описание — FAM подскажет подходящую категорию.</p>
          <label>Цена в рублях<input name="price_text" maxlength="50" placeholder="Бесплатно"></label>
          <label>Фото (необязательно)<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
          <p class="ru-note">Не загружайте лица, документы, пропуска и контактные данные. Фото останется закрытым до проверки модератором школы.</p>
          <button class="ru-button" type="submit">Отправить на проверку</button>
        </form>
        <section id="ruMessages" class="ru-messages" hidden aria-label="Сообщения">
          <div class="ru-messages-heading"><h2>Сообщения</h2><button id="ruMessagesBack" class="ru-button" type="button" hidden>К диалогам</button></div>
          <p id="ruMessagesStatus" class="ru-note" role="status" aria-live="polite"></p>
          <div id="ruMessageList" class="ru-message-list" aria-live="polite"></div>
          <form id="ruMessageForm" class="ru-message-form" hidden>
            <input name="body" maxlength="1000" required aria-label="Текст сообщения" placeholder="Сообщение">
            <button class="ru-message-send" type="submit">Отправить</button>
          </form>
        </section>
        <section id="ruModeration" class="ru-moderation" hidden aria-label="Очередь школьной модерации"><h2>Проверка объявлений и фото</h2><p id="ruModerationStatus" class="ru-note" role="status" aria-live="polite"></p><div id="ruAvatarReviewQueue"></div><div id="ruModerationQueue"></div>
          <section id="ruDeletionRequestSubmit" hidden aria-label="Обращение об удалении аккаунта">
            <h3>Обращение по аккаунту школы</h3>
            <p class="ru-note">Обращение увидит только администратор вашей школы. Оно не удаляет аккаунт автоматически; указывайте факты без контактов и личных сведений.</p>
            <form id="ruDeletionRequestForm">
              <label>Аккаунт<select id="ruDeletionTarget" required></select></label>
              <label>Причина<select id="ruDeletionReasonCode" required><option value="rules_violation">Нарушение правил</option><option value="harassment">Травля или преследование</option><option value="fake_account">Поддельный аккаунт</option><option value="spam">Спам</option><option value="other">Другая причина</option></select></label>
              <label>Что произошло? (15–500 символов)<textarea id="ruDeletionReason" required minlength="15" maxlength="500"></textarea></label>
              <button class="ru-button" type="submit">Отправить администратору</button>
            </form>
            <p id="ruDeletionRequestStatus" class="ru-note" role="status" aria-live="polite"></p>
            <h3>Мои обращения</h3><div id="ruDeletionOwnRequests"></div>
          </section>
          <section id="ruDeletionRequestReview" hidden aria-label="Обращения школы об удалении аккаунта">
            <h3>Обращения по аккаунтам</h3>
            <p class="ru-note">Администратор этой школы может отклонить обращение или одобрить окончательное удаление аккаунта и связанных данных. Для удаления нужны явное подтверждение через Яндекс ID и точная фраза подтверждения.</p>
            <p id="ruDeletionReviewStatus" class="ru-note" role="status" aria-live="polite"></p>
            <div id="ruDeletionReviewQueue"></div>
          </section>
        </section>
        <section class="hero-wrap ru-hero" role="region" aria-roledescription="карусель" aria-label="Баннеры FAM">
          <button id="ruHeroRotation" class="ru-button hero-rotation-control" type="button" aria-label="Остановить автопрокрутку" aria-pressed="true">Пауза</button>
          <div id="ruHeroTrack" class="hero" role="group" aria-roledescription="слайды" tabindex="0">
            <div class="hero-slide hero-img"><img src="/assets/banner-1.webp" width="1200" height="675" alt="Друзья FAM проводят время вместе." fetchpriority="high"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-2.webp" width="1200" height="675" alt="Школьные идеи, проекты и творчество." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-3.webp" width="1200" height="675" alt="Встречи, учёба и события рядом." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-4.webp" width="1200" height="675" alt="Вещи и услуги для школьников." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-5.webp" width="1200" height="675" alt="Учёба и новые знания." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-6.webp" width="1200" height="675" alt="Концерты, квизы и встречи." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-7.webp" width="1200" height="675" alt="Найди своих на закате." loading="lazy" decoding="async"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-8.webp" width="1200" height="675" alt="Школьная площадка FAM: анонсы и события." loading="lazy" decoding="async"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-9.webp" width="1200" height="675" alt="Вещи и услуги: техника для учёбы." loading="lazy" decoding="async"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-10.webp" width="1200" height="675" alt="Учёба и развитие за чашкой кофе." loading="lazy" decoding="async"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-11.webp" width="1200" height="675" alt="Творчество и идеи: камера и вдохновение." loading="lazy" decoding="async"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-12.webp" width="1200" height="675" alt="Ученический совет: команда волонтёров." loading="lazy" decoding="async"></div>
          </div>
          <div id="ruHeroDots" class="hero-dots" aria-label="Выбор баннера"></div>
          <div class="hero-carousel-controls">
            <button id="ruHeroPrevious" type="button" aria-label="Предыдущий баннер">‹</button>
            <button id="ruHeroNext" type="button" aria-label="Следующий баннер">›</button>
          </div>
        </section>
        <section id="ruAfishaFeed" class="ru-afisha-feed" aria-label="Афиша и школьная лента">
          <section id="ruPulse" class="ru-pulse" aria-label="Афиша: новости, опросы и мероприятия"></section>
          <section id="publicListings" class="ru-listings" aria-live="polite" aria-label="Опубликованные объявления"></section>
        </section>
        <nav id="ruTabbar" class="ru-tabbar" aria-label="Основная навигация">
          <button type="button" data-ru-view="board" aria-pressed="true">Доска</button>
          <button type="button" data-ru-view="afisha" aria-pressed="false">Афиша</button>
          <button type="button" data-ru-view="favorites" aria-pressed="false">Избранное</button>
          <button type="button" data-ru-view="messages" aria-pressed="false">Сообщения</button>
          <button type="button" data-ru-view="profile" aria-pressed="false">Профиль</button>
        </nav>
      </main>`;
    return;
})();
