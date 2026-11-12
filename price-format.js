(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FAMPrice = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function formatListingPrice(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "Бесплатно";

    const withoutCurrency = raw.replace(/\\s*(?:₽|руб(?:лей|ля|ль)?\\.?|р\\.)$/iu, "").trim();
    const compact = withoutCurrency.replace(/[\\s\\u00a0\\u202f]/g, "").replace(",", ".");
    if (!/^\\d+(?:\\.\\d{1,2})?$/.test(compact)) return raw;

    const amount = Number(compact);
    if (!Number.isFinite(amount)) return raw;

    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 })
      .format(amount)
      .replace(/[\\u00a0\\u202f]/g, " ") + " ₽";
  }

  return Object.freeze({ formatListingPrice });
});
