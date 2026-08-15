// =====================================
// QUESTIFY - Service Worker
// =====================================
//
// Purpose: cache the app shell (HTML/CSS/JS/icons) so Questify can load
// and function offline. This file has NO awareness of and NEVER touches
// localStorage - that's a separate browser storage mechanism entirely,
// owned exclusively by script.js. The service worker only intercepts
// network requests for static files.
//
// Strategy: network-first, cache fallback.
// - Online: always fetch the latest file from the network (so users get
//   real updates, not stuck-forever stale code), and refresh the cache
//   copy in the background for next time.
// - Offline: serve the last successfully cached copy instead of failing.
// - Navigating to the app while offline: fall back to the cached
//   index.html shell so the app still opens.

const CACHE_NAME = "questify-cache-v3";

const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon.png",
  "./favicon-32%20(1).png",
  "./logo.png",
];

// -------------------------------------
// Install: pre-cache the app shell
// -------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .catch((err) => {
        // Don't let one missing asset block installation entirely
        console.warn("Service worker: pre-cache had an issue:", err);
      })
  );
  self.skipWaiting();
});

// -------------------------------------
// Activate: clean up old cache versions
// -------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// -------------------------------------
// Fetch: network-first, cache fallback
// -------------------------------------
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle same-origin GET requests. Never intercept POST/PUT,
  // browser extension requests, or cross-origin calls.
  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return;
  }

  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) {
    return;
  }

  // Full page navigations (opening/reloading the app)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Static assets (CSS, JS, images, manifest)
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only cache successful, basic (same-origin) responses
        if (response && response.status === 200 && response.type === "basic") {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
