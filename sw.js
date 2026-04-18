// ══════════════════════════════════════════════════════════════════════
// sw.js — service worker
//
// Cache-first for the app shell. Network calls to the Anthropic API
// are never cached (they carry auth headers and are not idempotent).
// ══════════════════════════════════════════════════════════════════════

const VERSION = 'eo-local-v2-2026-04-18-pdf-idle';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/app.js',
  './js/ops.js',
  './js/anchor.js',
  './js/store.js',
  './js/store-worker.js',
  './js/seeds.js',
  './js/heuristic.js',
  './js/model.js',
  './js/intake.js',
  './js/horizon.js',
  './js/rules.js',
  './js/fold.js',
  './js/ui.js',
  './js/chat.js',
  './js/chat-compile.js',
  './js/chat-execute.js',
  './js/chat-render.js',
  './js/upload.js',
  './js/embeddings.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* missing files are non-fatal at install time */ })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls — let them go straight to the network
  if (url.hostname === 'api.anthropic.com' || url.hostname.endsWith('.anthropic.com')) {
    return;
  }

  // Cache-first for same-origin requests
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          // Opportunistically cache successful GETs of our own assets
          if (resp.ok && event.request.method === 'GET') {
            const copy = resp.clone();
            caches.open(VERSION).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return resp;
        }).catch(() => cached || new Response('Offline and not cached.', { status: 503 }));
      })
    );
    return;
  }

  // Third-party (fonts, etc.) — stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
