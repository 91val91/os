/**
 * Service worker d'Orion OS : met en cache l'interface pour un
 * fonctionnement hors ligne (stratégie « stale-while-revalidate »).
 * Les modules des applications sont mis en cache dès leur préchargement.
 */
const CACHE = 'orion-os-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './src/main.js',
  './src/styles/base.css',
  './src/styles/system.css',
  './src/styles/kit.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: url.pathname.endsWith('/') });
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
