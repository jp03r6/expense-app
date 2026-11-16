// Service Worker for ExpenseSnap PWA
//
// How updates reach installed phones and PCs:
// - Our own files (the page, js/, css/, manifest) are fetched from the
//   network first, so a new deploy is used as soon as you are online.
//   The saved copy is only used when you are offline.
// - Big third-party libraries in vendor/ rarely change, so they are served
//   from the saved copy first.
// - When a new version of this file installs, it takes over right away,
//   deletes the old saved copies, and reloads any open ExpenseSnap tabs once
//   so old code never runs against the new page.
const APP_VERSION = '9';
const CACHE_NAME = 'expensesnap-v9';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  `./css/app.css?v=${APP_VERSION}`,
  `./js/store.js?v=${APP_VERSION}`,
  `./js/receipt-manager.js?v=${APP_VERSION}`,
  `./js/pdf-compiler.js?v=${APP_VERSION}`,
  `./js/spreadsheet-helper.js?v=${APP_VERSION}`,
  `./js/firebase-config.js?v=${APP_VERSION}`,
  `./js/app.js?v=${APP_VERSION}`,
  './vendor/pdf-lib.min.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/xlsx.full.min.js',
  './vendor/qrcode.min.js',
  './vendor/jsqr.min.js',
  './vendor/mqttws31.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // cache: 'reload' skips the browser's own HTTP cache, so we never
      // save a stale copy of a file left over from the previous version.
      return cache.addAll(ASSETS_TO_CACHE.map((url) => new Request(url, { cache: 'reload' })));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const oldKeys = keys.filter((key) => key.startsWith('expensesnap-') && key !== CACHE_NAME);
    await Promise.all(oldKeys.map((key) => caches.delete(key)));
    await self.clients.claim();

    // Upgrading from an older version: reload open windows once so they
    // stop running old code. Skipped on a first install.
    if (oldKeys.length > 0) {
      const windows = await self.clients.matchAll({ type: 'window' });
      windows.forEach((client) => {
        if ('navigate' in client) {
          client.navigate(client.url).catch(() => {});
        }
      });
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isVendorOrIcon(url) {
  return url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // 'no-cache' asks the server whether the file changed (cheap with ETags)
    // instead of trusting a possibly stale copy in the HTTP cache.
    const fresh = await fetch(request, { cache: 'no-cache' });
    if (fresh && fresh.ok && fresh.type === 'basic') {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request) ||
      (request.mode === 'navigate' ? await cache.match('./index.html') || await cache.match('./') : null);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok && fresh.type === 'basic') {
    cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let the browser handle other sites

  if (isVendorOrIcon(url)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});
