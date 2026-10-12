/* ============================================================================
   EGS STANDARD SERVICE WORKER  —  identical across every EGS app.
   You change ONE line per app: APP_NAME. egs-deploy.sh stamps CACHE_VERSION
   on every deploy. The caching DECISIONS live in sw_logic.js (unit-tested);
   this worker imports and runs that exact code, so what's tested is what ships.

   Why updates "just work": HTML is served NETWORK-FIRST. Online, the browser
   always fetches the freshly deployed index.html; the cache is only the
   offline fallback. No re-download, no manual cache clearing, ever.
   ========================================================================== */

importScripts('./sw_logic.js');   // provides self.EGS_SW

const APP_NAME      = 'notebuilt-pro';   // <-- the ONE line you change per app
const CACHE_VERSION = '2026.10.12-1411';           // <-- egs-deploy.sh stamps this each deploy
const CACHE = EGS_SW.cacheName(APP_NAME, CACHE_VERSION);

// Offline shell. For single-file apps this is basically index.html + icons.
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))   // tolerate a missing asset
      .then(() => self.skipWaiting())                  // take over without waiting for old tabs
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        EGS_SW.staleCaches(keys, APP_NAME, CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())                // control open pages immediately
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // never cache writes (backend-safe)

  const strategy = EGS_SW.strategyFor(req.mode, req.headers.get('accept'));

  if (strategy === 'network-first') {
    // SW_DEADLINE — fresh HTML when online; cached HTML when offline OR when
    // the network hangs without answering. The cache write is attached to the
    // NETWORK promise, not to the race, so a response that arrives after the
    // deadline still lands in the cache for the next launch.
    const net = fetch(req)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; });
    net.catch(() => {});                               // a late failure is not an unhandled rejection
    e.respondWith(
      EGS_SW.raceTimeout(net, EGS_SW.NET_TIMEOUT_MS, () =>
        caches.match(req)
          .then((r) => r || caches.match('./index.html'))
          .then((r) => r || net))                      // nothing cached at all: the network is all there is
    );
    return;
  }

  // stale-while-revalidate: instant from cache, refreshed in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
