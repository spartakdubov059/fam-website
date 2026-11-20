// Send only fixed error codes to the isolated Russian backend; never send error text.
const FAM_RU_DIAGNOSTIC_CODES = new Set([
  "js_runtime", "unhandled_rejection", "supabase_sdk_unavailable",
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
          <label>Категория<select name="category" required><option value="Вещи">Вещи</option><option value="Услуги">Услуги</option><option value="Творчество">Творчество</option><option value="Учёба">Учёба</option><option value="Мероприятия">Мероприятия</option></select></label>
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
        <section class="hero-wrap ru-hero" aria-label="Баннеры FAM">
          <div id="ruHeroTrack" class="hero" role="region" aria-label="Баннерная карусель" tabindex="0">
            <div class="hero-slide hero-img"><img src="/assets/banner-1.webp" width="1200" height="675" alt="Друзья FAM проводят время вместе." fetchpriority="high"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-2.webp" width="1200" height="675" alt="Школьные идеи, проекты и творчество." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-3.webp" width="1200" height="675" alt="Встречи, учёба и события рядом." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-4.webp" width="1200" height="675" alt="Вещи и услуги для школьников." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-5.webp" width="1200" height="675" alt="Учёба и новые знания." loading="lazy"></div>
            <div class="hero-slide hero-img"><img src="/assets/banner-6.webp" width="1200" height="675" alt="Концерты, квизы и встречи." loading="lazy"></div>
          </div>
          <div id="ruHeroDots" class="hero-dots" aria-label="Выбор баннера"></div>
          <div class="hero-carousel-controls">
            <button id="ruHeroPrevious" type="button" aria-label="Предыдущий баннер">‹</button>
            <button id="ruHeroNext" type="button" aria-label="Следующий баннер">›</button>
          </div>
        </section>
        <section id="ruPulse" class="ru-pulse" aria-label="Новости и опросы школы"></section>
        <section id="publicListings" class="ru-listings" aria-live="polite" aria-label="Опубликованные объявления"></section>
        <nav id="ruTabbar" class="ru-tabbar" aria-label="Основная навигация">
          <button type="button" data-ru-view="board" aria-pressed="true">Доска</button>
          <button type="button" data-ru-view="afisha" aria-pressed="false">Афиша</button>
          <button type="button" data-ru-view="messages" aria-pressed="false">Сообщения</button>
          <button type="button" data-ru-view="profile" aria-pressed="false">Профиль</button>
        </nav>
      </main>`;
    const boardStyles = document.createElement('link');
    boardStyles.rel = 'stylesheet';
    boardStyles.href = '/public-board.css';
    document.head.append(boardStyles);
    const boardScript = document.createElement('script');
    boardScript.type = 'module';
    boardScript.src = '/public-board.js';
    document.body.append(boardScript);
    const messagesScript = document.createElement('script');
    messagesScript.type = 'module';
    messagesScript.src = '/messages.js';
    document.body.append(messagesScript);
    const submitScript = document.createElement('script');
    submitScript.type = 'module';
    submitScript.src = '/listing-submit.js';
    document.body.append(submitScript);
    const moderationScript = document.createElement('script');
    moderationScript.type = 'module';
    moderationScript.src = '/listing-moderation.js';
    document.body.append(moderationScript);
    const avatarScript = document.createElement('script');
    avatarScript.type = 'module';
    avatarScript.src = '/avatar-workflow.js';
    document.body.append(avatarScript);
    const profileSettingsScript = document.createElement('script');
    profileSettingsScript.type = 'module';
    profileSettingsScript.src = '/profile-settings.js';
    document.body.append(profileSettingsScript);
    const accountScript = document.createElement('script');
    accountScript.type = 'module';
    accountScript.src = '/account-workflow.js';
    document.body.append(accountScript);
    const ideaHistoryScript = document.createElement('script');
    ideaHistoryScript.type = 'module';
    ideaHistoryScript.src = '/idea-history.js';
    document.body.append(ideaHistoryScript);
    const ownListingsScript = document.createElement('script');
    ownListingsScript.type = 'module';
    ownListingsScript.src = '/own-listings.js';
    document.body.append(ownListingsScript);
    const heroScript = document.createElement('script');
    heroScript.type = 'module';
    heroScript.src = '/hero-carousel.js';
    document.body.append(heroScript);
    const navigationScript = document.createElement('script');
    navigationScript.type = 'module';
    navigationScript.src = '/navigation.js';
    document.body.append(navigationScript);
    const pulseScript = document.createElement('script');
    pulseScript.type = 'module';
    pulseScript.src = '/pulse.js';
    document.body.append(pulseScript);
    return;
})();
