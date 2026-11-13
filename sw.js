/* FAM static shell only. Never cache authenticated API responses, listings, chats, or user images. */
const STATIC_CACHE = "fam-public-static-v1";
const CACHE_PREFIX = "fam-public-static-";
const PUBLIC_ASSETS = ["./price-format.js", "./icons/fam-icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(PUBLIC_ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== STATIC_CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.mode === "navigate" || request.destination !== "script" && request.destination !== "image") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return;
  const allowedPaths = PUBLIC_ASSETS.map(path => new URL(path, self.registration.scope).pathname);
  if (!allowedPaths.includes(url.pathname)) return;
  event.respondWith(fetch(request).then(async response => {
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(STATIC_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  }).catch(async () => (await caches.match(request)) || Response.error()));
});
