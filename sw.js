/* Keep — service worker.

   The app shell is fetched network-first so a deploy lands on the next load
   instead of being pinned to whatever was cached first; the cache is the
   offline fallback, not the source of truth. Everything else is cache-first. */

const CACHE = "keep-v7";
const SHELL = ["/", "/index.html", "/app.css", "/app.js", "/manifest.json", "/icon.svg"];
const FRESH = new Set(["/", "/index.html", "/app.css", "/app.js"]);

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // Supabase talks to the network itself

  const isShell = req.mode === "navigate" || FRESH.has(url.pathname);

  if (isShell) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("/index.html"))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
    )
  );
});
