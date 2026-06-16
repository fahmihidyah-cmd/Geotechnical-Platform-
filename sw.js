// PERA Service Worker v2 — ONLY handles pera.html + its shell.
// Never intercepts index.html or any other page/resource.
const CACHE = "pera-shell-v2";
const SHELL = [
  "./pera.html",
  "./manifest.json",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  const isPera     = url.origin === location.origin && url.pathname.endsWith("/pera.html");
  const isManifest = url.origin === location.origin && url.pathname.endsWith("/manifest.json");
  const isLib      = url.href.indexOf("cdn.jsdelivr.net/npm/@supabase/supabase-js") !== -1;

  // Anything that is NOT a PERA asset -> leave it completely alone (browser handles it).
  if (!(isPera || isManifest || isLib)) return;

  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => (isPera ? caches.match("./pera.html") : Response.error()))
    )
  );
});
