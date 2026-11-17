// Keep FAM's Supabase SDK load resilient when a mobile network cannot reach jsDelivr.
// This file is local to both static hosts. The first SDK script remains parser-blocking;
// document.write inserts the pinned backup before the app's inline code is evaluated.
(function () {
  "use strict";

  var primaryId = "famSupabaseSdk";
  var backupId = "famSupabaseSdkFallback";

  function showLoadError() {
    var panel = document.createElement("div");
    panel.setAttribute("role", "alert");
    panel.style.cssText = "position:fixed;z-index:99999;inset:12px 12px auto;padding:16px;border-radius:12px;background:#351b1b;color:#fff;font:16px/1.5 sans-serif;box-shadow:0 4px 24px #0008";
    panel.textContent = "Не удалось загрузить модуль FAM. Проверьте интернет и откройте сайт ещё раз. Если вы пришли со старой ссылки, попробуйте основной адрес famru.netlify.app.";
    if (document.body) document.body.prepend(panel);
  }

  document.addEventListener("error", function (event) {
    var failedScript = event.target;
    if (!failedScript || failedScript.tagName !== "SCRIPT") return;

    if (failedScript.id === primaryId) {
      // A parser-blocking script is still being parsed here; document.write keeps
      // the fallback blocking too, so the app cannot run before Supabase exists.
      document.write('<script id="famSupabaseSdkFallback" src="https://unpkg.com/@supabase/supabase-js@2.119.0"><\/script>');
      return;
    }

    if (failedScript.id === backupId) {
      document.addEventListener("DOMContentLoaded", showLoadError, { once: true });
    }
  }, true);
})();
