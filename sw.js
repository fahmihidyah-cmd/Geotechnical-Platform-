/* GMS service worker v3 — multi-page offline shell */
"use strict";
const CACHE = "gms-shell-v4";
const SUPA_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const PRECACHE = [
  "common.css", "common.js",
  "index.html", "pera.html", "inspeksi.html", "dashboard.html", "report.html",
  "manifest.json", SUPA_CDN
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(PRECACHE.map(u => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith(".supabase.co")) return;            // API: always network
  const sameOrigin = url.origin === self.location.origin;
  const isSupaCdn = req.url.startsWith(SUPA_CDN);
  if (!sameOrigin && !isSupaCdn) return;

  const isHTML = req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname === "/";
  if (sameOrigin && isHTML) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE); c.put(req, net.clone());
        return net;
      } catch (_) {
        const cached = await caches.match(req);
        return cached || caches.match("index.html");
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const fetchPromise = fetch(req).then(net => {
      caches.open(CACHE).then(c => c.put(req, net.clone()));
      return net;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});
