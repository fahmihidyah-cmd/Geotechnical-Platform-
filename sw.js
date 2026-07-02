/* GMS service worker v14 — multi-page offline shell + map assets + aerial tile runtime cache */
"use strict";
const CACHE = "gms-shell-v14";
const TILE_CACHE = "gms-aerial-tiles-v1";          // persistent: survives app updates
const TILE_HOST = "young-mouse-1ee2.fahmihidyah.workers.dev"; // aerial XYZ tiles (Cloudflare)
const SUPA_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
// Cross-origin assets that must work OFFLINE (versioned/immutable) — Leaflet map for risk-area drawing.
const CDN_ASSETS = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];
const PRECACHE = [
  "common.css", "common.js",
  "index.html", "pera.html", "inspeksi.html", "report.html", "eews.html", "validasi.html",
  "database.html", "monitoring.html", "inclinometer.html", "risk_report.html", "shift.html", "shiftreport.html",
  "manifest.json", SUPA_CDN, ...CDN_ASSETS
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
    await Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith(".supabase.co")) return;            // API: always network
  // Aerial XYZ tiles: cache-first into a persistent cache so visited areas work OFFLINE.
  if (url.hostname === TILE_HOST) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok) { const c = await caches.open(TILE_CACHE); c.put(req, net.clone()); }
        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
    return;
  }
  const sameOrigin = url.origin === self.location.origin;
  const isSupaCdn = req.url.startsWith(SUPA_CDN);
  const isCdnAsset = CDN_ASSETS.some(u => req.url.startsWith(u));
  if (!sameOrigin && !isSupaCdn && !isCdnAsset) return;

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
  // Static/CDN assets: cache-first, refresh in background (immutable → safe).
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const fetchPromise = fetch(req).then(net => {
      caches.open(CACHE).then(c => c.put(req, net.clone()));
      return net;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});
