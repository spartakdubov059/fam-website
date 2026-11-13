(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FAMGallery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PUBLIC_LISTING_PREFIX = "https://tfacqpljrvfpcrhdovbu.supabase.co/storage/v1/object/public/listings-images/";
  const MAX_PHOTOS = 5;
  function photos(listing) {
    if (!listing || listing.photo_status && listing.photo_status !== "approved") return [];
    const primary = typeof listing.image_url === "string" ? listing.image_url.trim() : "";
    const candidates = [primary, ...(Array.isArray(listing.image_urls) ? listing.image_urls : [])];
    const unique = [];
    for (const value of candidates) {
      if (typeof value !== "string") continue;
      const url = value.trim();
      if (!url.startsWith(PUBLIC_LISTING_PREFIX) || !url.slice(PUBLIC_LISTING_PREFIX.length) || /[?#]/.test(url)) continue;
      if (!unique.includes(url)) unique.push(url);
      if (unique.length === MAX_PHOTOS) break;
    }
    return unique;
  }
  return Object.freeze({ photos, MAX_PHOTOS });
});
