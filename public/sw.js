// App-shell cache so the app opens fast and installs on the phone. API calls always go to the network.
const CACHE = "pd-v13";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json", "/icon-192.png", "/icon-512.png", "/locate.html", "/track.html"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Never touch the pharmacy ERP — it lives at /erp and manages its own requests/caching.
  if (url.pathname === "/erp" || url.pathname.startsWith("/erp/")) return;
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // network first, fall back to cache when offline
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("/index.html"))));
});
