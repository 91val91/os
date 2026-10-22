/**
 * Service worker d'Orion OS : met en cache l'interface pour un
 * fonctionnement hors ligne (stratégie « stale-while-revalidate »).
 *
 * Au premier lancement, la page lui transmet la liste des fichiers déjà
 * chargés (noyau, interface système) pour qu'ils soient mis en cache ; les
 * modules des applications le sont lors de leur préchargement.
 *
 * Une nouvelle version du service worker reprend, à jour, tout ce que
 * l'ancienne avait en cache, puis attend que plus aucune fenêtre d'Orion ne
 * soit ouverte (ou un redémarrage depuis Orion) pour prendre la main : une
 * session en cours ne mélange jamais deux versions du système.
 */
const PREFIX = 'orion-os-';
const CACHE = `${PREFIX}v4`;
// Tout ce qu'il faut pour démarrer sans réseau : un module importé au démarrage qui
// manquerait ici laisserait un écran noir hors ligne (vérifié par tests/sw.test.js).
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
  './src/apps/registry.js',
  './src/kernel/accounts.js',
  './src/kernel/alarms.js',
  './src/kernel/chatbot.js',
  './src/kernel/contacts.js',
  './src/kernel/device.js',
  './src/kernel/events.js',
  './src/kernel/intents.js',
  './src/kernel/kernel.js',
  './src/kernel/log.js',
  './src/kernel/media.js',
  './src/kernel/notifications.js',
  './src/kernel/packages.js',
  './src/kernel/permissions.js',
  './src/kernel/processes.js',
  './src/kernel/seed.js',
  './src/kernel/settings.js',
  './src/kernel/shell.js',
  './src/kernel/storage.js',
  './src/kernel/telephony.js',
  './src/kernel/vfs.js',
  './src/lib/artwork.js',
  './src/lib/dom.js',
  './src/lib/expr.js',
  './src/lib/format.js',
  './src/lib/gesture.js',
  './src/lib/icons.js',
  './src/lib/sha256.js',
  './src/lib/ui.js',
  './src/lib/weather-codes.js',
  './src/system/alarm-screen.js',
  './src/system/app-context.js',
  './src/system/app-icon.js',
  './src/system/banners.js',
  './src/system/call-screen.js',
  './src/system/control-center.js',
  './src/system/dialogs.js',
  './src/system/drawer.js',
  './src/system/home.js',
  './src/system/lockscreen.js',
  './src/system/navigation.js',
  './src/system/platform.js',
  './src/system/power.js',
  './src/system/pull-panel.js',
  './src/system/quick-settings.js',
  './src/system/setup.js',
  './src/system/shade.js',
  './src/system/sound.js',
  './src/system/statusbar.js',
  './src/system/system-ui.js',
  './src/system/theme.js',
  './src/system/wallpapers.js',
  './src/system/window-manager.js',
];

const inScope = (url) => url.origin === self.location.origin && url.href.startsWith(self.registration.scope);
// Une seule copie de chaque page, quels que soient ses paramètres (?fullscreen…).
const pageKey = (url) => url.origin + url.pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE.map((path) => new Request(path, { cache: 'reload' })));
      // Reprend tout ce que les versions précédentes avaient en cache, en version à jour si possible.
      for (const key of await caches.keys()) {
        if (!key.startsWith(PREFIX) || key === CACHE) continue;
        const old = await caches.open(key);
        for (const request of await old.keys()) {
          const url = new URL(request.url);
          if (url.search || (await cache.match(request))) continue;
          try {
            const response = await fetch(new Request(url.href, { cache: 'reload' }));
            if (response.ok) {
              await cache.put(url.href, response);
              continue;
            }
          } catch {
            /* hors ligne : on garde l'ancienne copie */
          }
          const previous = await old.match(request);
          if (previous) await cache.put(url.href, previous);
        }
      }
    })(),
  );
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
  if (event.data?.type === 'activate') return void self.skipWaiting();
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
  const key = navigation ? pageKey(url) : request;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      // Revalidation en arrière-plan, sans repasser par le cache HTTP du navigateur.
      const network = (navigation ? fetch(request) : fetch(request, { cache: 'no-cache' }))
        .then((response) => {
          if (response.ok) cache.put(key, response.clone());
          return response;
        })
        .catch(async () => cached ?? (navigation ? cache.match('./index.html') : undefined) ?? Response.error());
      return cached ?? network;
    }),
  );
});
