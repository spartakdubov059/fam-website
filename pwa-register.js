/* Relative URL keeps FAM installable on GitHub Pages project paths and Netlify previews. */
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .catch(error => console.warn("Не удалось включить офлайн-ресурсы FAM:", error));
  });
}
