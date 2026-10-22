/**
 * Service worker d'Orion OS : installe et sert une version précise du système.
 *
 * Chaque version publiée est décrite par version.json (scripts/release.mjs) :
 * numéro, notes et empreinte SHA-256 de chaque fichier. Le téléphone garde la
 * version installée, entièrement en cache (elle démarre hors ligne), jusqu'à
 * l'installation d'une mise à jour depuis les Réglages :
 *   1. « download » : la nouvelle version est téléchargée à côté de l'actuelle.
 *      Un fichier déjà présent sur le téléphone avec la même empreinte n'est
 *      pas retéléchargé ; chaque fichier reçu est vérifié.
 *   2. « install » : elle devient la version servie, l'ancienne est effacée,
 *      et Orion redémarre dessus.
 * Une session ne mélange donc jamais deux versions du système.
 */
const PREFIX = 'orion-os-';
const META = `${PREFIX}meta`;
const releaseCache = (version) => `${PREFIX}release-${version}`;

const at = (path) => new URL(path, self.registration.scope).href;
const inScope = (url) => url.origin === self.location.origin && url.href.startsWith(self.registration.scope);

// { current, staged } : manifestes de la version installée et de celle prête à l'être.
let state = null;
let downloading = null;

async function readState() {
  if (!state) {
    const saved = await (await caches.open(META)).match('state');
    state = saved ? await saved.json() : { current: null, staged: null };
  }
  return state;
}

async function writeState(next) {
  state = next;
  await (await caches.open(META)).put('state', new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } }));
}

/** Ce que la page affiche d'une version (sans la liste des fichiers). */
const summary = (manifest) => manifest && { version: manifest.version, build: manifest.build, date: manifest.date, notes: manifest.notes, size: manifest.size };

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchManifest() {
  const response = await fetch(at('./version.json'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Version publiée introuvable (${response.status})`);
  return response.json();
}

async function broadcast(message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage(message);
}

/**
 * Télécharge une version dans son propre cache. Chaque fichier est d'abord
 * cherché parmi ceux déjà sur le téléphone (version installée, téléchargement
 * interrompu, anciens caches) : s'il a la bonne empreinte, il est repris tel quel.
 */
async function download(manifest, onProgress = () => {}) {
  const target = await caches.open(releaseCache(manifest.version));
  const entries = Object.entries(manifest.files);
  let done = 0;
  let downloaded = 0;
  for (const [path, file] of entries) {
    const url = at(path);
    let response = null;
    const local = await caches.match(url);
    if (local && (await sha256(await local.clone().arrayBuffer())) === file.hash) response = local;
    if (!response) {
      const fresh = await fetch(url, { cache: 'reload' });
      if (!fresh.ok) throw new Error(`${path} : erreur ${fresh.status}`);
      if ((await sha256(await fresh.clone().arrayBuffer())) !== file.hash) throw new Error('Un fichier reçu ne correspond pas à la version publiée (publication en cours ?). Réessayez dans quelques minutes.');
      response = fresh;
      downloaded += file.size;
    }
    await target.put(url, response);
    onProgress({ version: manifest.version, done: ++done, total: entries.length, downloaded });
  }
  // La racine de l'application affiche index.html.
  await target.put(at('./'), await target.match(at('./index.html')));
}

/** Télécharge la dernière version publiée et la prépare (un seul téléchargement à la fois). */
function prepareLatest() {
  downloading ??= (async () => {
    const manifest = await fetchManifest();
    const current = await readState();
    if (current.current?.version === manifest.version) return { upToDate: true };
    await download(manifest, (progress) => broadcast({ type: 'update-progress', ...progress }));
    await writeState({ ...(await readState()), staged: manifest });
    return { staged: summary(manifest) };
  })().finally(() => (downloading = null));
  return downloading;
}

self.addEventListener('install', (event) => {
  // Premier service worker de cet appareil : la version publiée est installée en entier.
  // Pour une nouvelle version du service worker lui-même, la version installée est conservée.
  event.waitUntil(
    readState().then(async (current) => {
      if (current.current) return;
      const manifest = await fetchManifest();
      await download(manifest);
      await writeState({ current: manifest, staged: null });
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const { current, staged } = await readState();
      const keep = new Set([META, current && releaseCache(current.version), staged && releaseCache(staged.version)]);
      // Seuls les anciens caches d'Orion sont supprimés : l'origine github.io est partagée avec d'autres sites.
      for (const key of await caches.keys()) if (key.startsWith(PREFIX) && !keep.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const { type } = event.data ?? {};
  const reply = (message) => event.ports[0]?.postMessage(message);
  if (type === 'activate') return void self.skipWaiting();
  if (type === 'status') {
    event.waitUntil(readState().then((s) => reply({ current: summary(s.current), staged: summary(s.staged) })));
  } else if (type === 'estimate') {
    // Taille réellement à télécharger : les fichiers dont l'empreinte diffère de la version installée.
    event.waitUntil(
      readState().then(({ current }) => {
        const files = Object.entries(event.data.files ?? {});
        reply({ size: files.reduce((sum, [path, file]) => sum + (current?.files?.[path]?.hash === file.hash ? 0 : file.size), 0) });
      }),
    );
  } else if (type === 'download') {
    event.waitUntil(
      prepareLatest()
        .then((result) => {
          reply({ ok: true, ...result });
          if (result.staged) broadcast({ type: 'update-ready', version: result.staged.version });
        })
        .catch((error) => reply({ ok: false, error: error.message })),
    );
  } else if (type === 'install') {
    event.waitUntil(
      (async () => {
        const { current, staged } = await readState();
        if (!staged) return reply({ ok: false, error: 'Aucune mise à jour téléchargée' });
        await writeState({ current: staged, staged: null });
        if (current && current.version !== staged.version) await caches.delete(releaseCache(current.version));
        reply({ ok: true, version: staged.version });
        // Les autres fenêtres d'Orion redémarrent aussi sur la nouvelle version.
        broadcast({ type: 'update-installed', version: staged.version });
      })(),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // version.json va toujours au réseau : c'est par lui qu'on apprend qu'une mise à jour existe.
  if (request.method !== 'GET' || !inScope(url) || url.pathname.endsWith('/version.json')) return;
  event.respondWith(respond(request, url));
});

async function respond(request, url) {
  const { current } = await readState();
  const cache = current ? await caches.open(releaseCache(current.version)) : null;
  const page = request.mode === 'navigate' && (url.origin + url.pathname === at('./') || url.pathname.endsWith('/index.html'));
  // La version installée est servie telle quelle (les paramètres comme ?fullscreen sont ignorés).
  const cached = await cache?.match(page ? at('./') : url.origin + url.pathname);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return (request.mode === 'navigate' && (await cache?.match(at('./')))) || Response.error();
  }
}
