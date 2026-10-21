/**
 * Service worker d'Orion OS : met en cache l'interface pour un
 * fonctionnement hors ligne (stratégie « stale-while-revalidate »).
 *
 * Au premier lancement, la page lui transmet la liste des fichiers déjà
 * chargés (noyau, interface système) pour qu'ils soient mis en cache ; les
 * modules des applications le sont lors de leur préchargement.
 */
const PREFIX = 'orion-os-';
const CACHE = `${PREFIX}v2`;
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './src/main.js',
  './src/styles/base.css',
  './src/styles/system.css',
  './src/styles/kit.css',
];

const inScope = (url) => url.origin === self.location.origin && url.href.startsWith(self.registration.scope);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Seuls les anciens caches d'Orion sont supprimés : l'origine github.io est partagée avec d'autres sites.
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const raw of event.data.urls) {
        try {
          const url = new URL(raw, self.registration.scope);
          url.hash = '';
          if (!inScope(url) || (await cache.match(url.href))) continue;
          const response = await fetch(url.href);
          if (response.ok) await cache.put(url.href, response);
        } catch {
          /* fichier ignoré : il sera mis en cache à sa prochaine utilisation */
        }
      }
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !inScope(url)) return;
  const navigation = request.mode === 'navigate';
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: navigation });
      // Revalidation en arrière-plan, sans repasser par le cache HTTP du navigateur.
      const network = (navigation ? fetch(request) : fetch(request, { cache: 'no-cache' }))
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(async () => cached ?? (navigation ? cache.match('./index.html') : undefined) ?? Response.error());
      return cached ?? network;
    }),
  );
});
