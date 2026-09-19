/* Kanban Web service worker — shell caching for offline access to the
 * board list (`/boards`) and individual board views (`/board/:boardId`).
 *
 * Strategy:
 *   - precache: the SPA shell (root document, manifest, icons, theme CSS).
 *   - runtime:
 *       · navigation requests (HTML)   -> network-first, fall back to cached shell.
 *       · /assets/* (JS, CSS)          -> stale-while-revalidate.
 *       · images                      -> stale-while-revalidate.
 *       · everything else (API, WS)   -> pass through, never cache.
 *
 * Versions below should be bumped whenever shipped assets change in an
 * incompatible way; a mismatch forces the SW to drop its caches and
 * re-fetch the shell on the next page load.
 */
const SW_VERSION = 'v1';
const SHELL_CACHE = `kanban-shell-${SW_VERSION}`;
const RUNTIME_CACHE = `kanban-runtime-${SW_VERSION}`;
const STATIC_ASSET_CACHE = `kanban-static-${SW_VERSION}`;

const SHELL_URLS = [
  '/',
  '/boards',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fails the whole install if any URL errors. Pre-cache the
      // critical shell entries; navigation routes fall back to the
      // SPA index via the runtime handler so we don't need every route.
      await cache.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/offline.html']);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== SHELL_CACHE && n !== RUNTIME_CACHE && n !== STATIC_ASSET_CACHE)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws');
}

function isStaticAsset(url) {
  return url.pathname.startsWith('/assets/') ||
    /\.(?:js|mjs|css|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|gif|ico)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url)) return; // never cache API / WebSocket traffic

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(req, STATIC_ASSET_CACHE));
  }
});

async function handleNavigation(req) {
  // Network first so users get the latest deploy when online.
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put('/', fresh.clone());
    }
    return fresh;
  } catch (_err) {
    const cached = await caches.match(req) || await caches.match('/');
    if (cached) return cached;
    const shell = await caches.match('/offline.html');
    if (shell) return shell;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await networkPromise) || new Response('', { status: 504 });
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
