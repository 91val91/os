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
 *
 * Les versions sont ordonnées par leur numéro d'ordre (sequence), le numéro
 * affiché ayant pu repartir de zéro (1.2.0 → 0.1 alpha). Une installation
 * d'avant la 0.1 ne voit pas la 0.1 comme plus récente : ce service worker
 * la prépare à son installation et l'applique à son activation (redémarrage).
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

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function writeState(next) {
  state = next;
  await (await caches.open(META)).put('state', json(next));
}

/** Ce que la page affiche d'une version (sans la liste des fichiers). */
const summary = (manifest) => manifest && { version: manifest.version, channel: manifest.channel, sequence: manifest.sequence, build: manifest.build, date: manifest.date, notes: manifest.notes, size: manifest.size };

/** Version d'avant la 0.1 (1.0.0 à 1.2.0) : sans numéro d'ordre. */
const legacy = (manifest) => Boolean(manifest) && !Number.isInteger(manifest.sequence);

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
    onProgress({ version: manifest.version, channel: manifest.channel, sequence: manifest.sequence, done: ++done, total: entries.length, downloaded });
  }
  // La racine de l'application affiche index.html.
  await target.put(at('./'), await target.match(at('./index.html')));
}

/** Télécharge la dernière version publiée et la prépare (un seul téléchargement à la fois). */
function prepareLatest() {
  downloading ??= (async () => {
    const manifest = await fetchManifest();
    const before = await readState();
    if (before.current?.version === manifest.version) return { upToDate: true };
    await download(manifest, (progress) => broadcast({ type: 'update-progress', ...progress }));
    const now = await readState();
    await writeState({ ...now, staged: manifest });
    // Une version prête plus ancienne (remplacée par celle-ci) n'a plus lieu d'être gardée.
    const old = now.staged?.version;
    if (old && old !== manifest.version && old !== now.current?.version) await caches.delete(releaseCache(old));
    return { staged: summary(manifest) };
  })().finally(() => (downloading = null));
  return downloading;
}

/**
 * Installation d'avant la 0.1 : son interface ne proposerait jamais la 0.1
 * (numéro plus petit). La dernière version est téléchargée à l'installation de
 * ce service worker (à côté de l'installée, qui reste servie) et appliquée à
 * son activation, c'est-à-dire au prochain redémarrage d'Orion. Si le
 * téléchargement échoue, l'installation de ce service worker échoue : le
 * navigateur réessaiera plus tard.
 */
async function prepareMigration(current) {
  const manifest = await fetchManifest();
  if (legacy(manifest) || manifest.version === current.version) return null;
  await download(manifest);
  await (await caches.open(META)).put('migration', json(manifest));
  return manifest;
}

/** À l'activation : la version préparée devient l'installée (nouvel essai si son cache a disparu entre-temps). */
async function applyMigration() {
  const meta = await caches.open(META);
  const saved = await meta.match('migration');
  let manifest = saved ? await saved.json() : null;
  const { current } = await readState();
  if (legacy(current) && (await complete(current))) {
    if (!(await complete(manifest))) manifest = await prepareMigration(current).catch(() => null);
    if (await complete(manifest)) await writeState({ current: manifest, staged: null });
  }
  await meta.delete('migration');
}

/** Remet en état le cache d'une version : renvoie le nombre de fichiers retéléchargés. */
async function repair(manifest) {
  const cache = await caches.open(releaseCache(manifest.version));
  let repaired = 0;
  for (const [path, file] of Object.entries(manifest.files)) {
    const url = at(path);
    const local = await cache.match(url);
    if (local && (await sha256(await local.arrayBuffer())) === file.hash) continue;
    const fresh = await fetch(url, { cache: 'reload' });
    if (!fresh.ok) throw new Error(`${path} : erreur ${fresh.status}`);
    if ((await sha256(await fresh.clone().arrayBuffer())) !== file.hash) throw new Error('Le fichier publié ne correspond plus à la version installée : installez la dernière mise à jour.');
    await cache.put(url, fresh);
    repaired++;
  }
  await cache.put(at('./'), await cache.match(at('./index.html')));
  return repaired;
}

/** Une version installée ou prête n'est utilisable que si son cache est complet. */
async function complete(manifest) {
  if (!manifest || !(await caches.has(releaseCache(manifest.version)))) return false;
  const cache = await caches.open(releaseCache(manifest.version));
  const keys = new Set((await cache.keys()).map((request) => request.url));
  return Object.keys(manifest.files).every((path) => keys.has(at(path)));
}

self.addEventListener('install', (event) => {
  // Premier service worker de cet appareil : la version publiée est installée en entier.
  // Pour une nouvelle version du service worker lui-même, la version installée est conservée
  // (et réparée si son cache a disparu).
  event.waitUntil(
    (async () => {
      const { current } = await readState();
      if (await complete(current)) {
        if (legacy(current)) await prepareMigration(current);
        return;
      }
      const manifest = await fetchManifest();
      await download(manifest);
      await writeState({ ...(await readState()), current: manifest, staged: null });
    })().finally(() => {
      // Ce service worker peut attendre longtemps : l'actif peut installer une version entre-temps.
      state = null;
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Relu ici : le service worker précédent a pu télécharger ou installer une version depuis.
      state = null;
      await applyMigration().catch(() => {});
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
          // Les autres pages (fenêtre redémarrée, deuxième fenêtre) suivent aussi la fin du téléchargement.
          if (result.staged) broadcast({ type: 'update-ready', version: result.staged.version, staged: result.staged });
        })
        .catch((error) => {
          reply({ ok: false, error: error.message });
          broadcast({ type: 'update-failed', error: error.message });
        }),
    );
  } else if (type === 'discard') {
    // Version prête retirée par l'éditeur (ou remplacée) : elle ne sera pas installée.
    event.waitUntil(
      (async () => {
        await downloading?.catch(() => {});
        const s = await readState();
        if (s.staged && s.staged.version !== event.data.keep) {
          await writeState({ ...s, staged: null });
          if (s.staged.version !== s.current?.version) await caches.delete(releaseCache(s.staged.version));
        }
        reply({ ok: true });
      })(),
    );
  } else if (type === 'repair') {
    // Protection de l'appareil : les fichiers de la version installée qui ne correspondent
    // plus à leur empreinte sont retéléchargés et vérifiés.
    event.waitUntil(
      (async () => {
        const { current } = await readState();
        if (!current) return reply({ ok: false, error: 'Aucune version installée' });
        try {
          reply({ ok: true, repaired: await repair(current) });
        } catch (error) {
          reply({ ok: false, error: error.message });
        }
      })(),
    );
  } else if (type === 'install') {
    event.waitUntil(
      (async () => {
        const { current, staged } = await readState();
        if (!staged) return reply({ ok: false, error: 'Aucune mise à jour téléchargée' });
        if (!(await complete(staged))) {
          await writeState({ current, staged: null });
          return reply({ ok: false, error: 'La mise à jour téléchargée est incomplète : téléchargez-la à nouveau.' });
        }
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
  // api/ : le pont matériel d'Orion installé (orion-server), jamais mis en cache.
  if (request.method !== 'GET' || !inScope(url) || url.pathname.endsWith('/version.json') || url.href.startsWith(at('./api/'))) return;
  event.respondWith(respond(request, url));
});

async function respond(request, url) {
  const { current } = await readState();
  // caches.has : ne pas recréer (vide) le cache d'une version disparue.
  const name = current && releaseCache(current.version);
  const cache = name && (await caches.has(name)) ? await caches.open(name) : null;
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
