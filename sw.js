// ─────────────────────────────────────────────────────────────────────────────
// Community Bingo — Service Worker
// MD Works · mdworks.dev
//
// Strategy:
//   - Shell (play.html, caller.html, index.html, fonts, manifest) → Network First
//     (tries network, falls back to cache for offline; always gets latest on deploy)
//   - API calls (/bingo/*) → Network Only (always live data)
//
// Bump CACHE_VERSION to wipe old caches on next install.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'bingo-1786178105616';

const SHELL = [
  '/play.html',
  '/caller.html',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&family=Cormorant+Garamond:ital,wght@1,300&family=Raleway:wght@300;400;500&family=Syne+Mono&display=swap',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      Promise.allSettled(SHELL.map(url =>
        cache.add(url).catch(() => {})
      ))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: Network First for shell, Network Only for API ─────────────────────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — always hit the network
  if (url.pathname.startsWith('/bingo/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Worker API (external domain) — network only
  if (url.hostname.includes('workers.dev') || url.hostname.includes('cloudflare')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Shell — Network First: always try network, fall back to cache if offline
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() =>
      // Offline fallback: serve from cache
      caches.match(event.request)
    )
  );
});
