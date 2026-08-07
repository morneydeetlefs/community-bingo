// ─────────────────────────────────────────────────────────────────────────────
// Community Bingo — Service Worker
// MD Works · mdworks.dev
//
// Strategy:
//   - Shell (play.html, fonts, manifest) → Cache First
//   - API calls (/bingo/*) → Network Only (always live data)
//
// Bump CACHE_VERSION to force a full refresh on next deploy.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'bingo-v1';

const SHELL = [
  '/bingo/play.html',
  '/bingo/manifest.json',
  '/bingo/icon-192.png',
  '/bingo/icon-512.png',
  // Google Fonts — cached on first load
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&family=Cormorant+Garamond:ital,wght@1,300&family=Raleway:wght@300;400;500&family=Syne+Mono&display=swap',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      // Don't fail install if font/icon fetch fails (network may be unavailable)
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

// ── Fetch: Cache First for shell, Network Only for API ────────────────────────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — always hit the network
  if (url.pathname.startsWith('/bingo/') && !url.pathname.endsWith('.html')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Worker API (external domain) — network only
  if (url.hostname.includes('workers.dev') || url.hostname.includes('cloudflare')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Shell — cache first, fall back to network, update cache in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // offline: return whatever we have cached

      return cached || networkFetch;
    })
  );
});
