/**
 * Intégrité du système : les fichiers d'Orion gardés sur l'appareil (copie
 * hors ligne du service worker) sont comparés à l'empreinte SHA-256 publiée
 * pour la version installée (version.json). Sur Orion installé, orion-server
 * vérifie aussi les fichiers qu'il sert.
 *
 * Un fichier modifié (extension du navigateur, stockage corrompu, logiciel
 * malveillant) est signalé ; « Réparer » le fait retélécharger et revérifier
 * par le service worker.
 */
const PREFIX = 'orion-os-';

async function sha256(buffer, subtle) {
  const digest = await subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @returns {Promise<{ status: 'ok' | 'altered' | 'unavailable', version?: string, checked?: number, altered?: string[], missing?: string[], source?: string, reason?: string }>}
 */
export async function checkIntegrity({ env = globalThis, bridge = null, onProgress = () => {} } = {}) {
  const { caches, crypto } = env;
  let result = null;
  if (caches && crypto?.subtle) {
    const saved = (await caches.has(`${PREFIX}meta`)) ? await (await caches.open(`${PREFIX}meta`)).match('state') : null;
    const current = saved ? (await saved.json()).current : null;
    if (current?.files) {
      // Nom du cache donné par le service worker au téléchargement (ancien nommage : le numéro seul).
      const name = current.cache ?? `${PREFIX}release-${current.version}`;
      const cache = (await caches.has(name)) ? await caches.open(name) : null;
      const base = new URL('./', env.location.href);
      const entries = Object.entries(current.files);
      const altered = [];
      const missing = [];
      let done = 0;
      for (const [path, file] of entries) {
        const response = await cache?.match(new URL(path, base).href);
        if (!response) missing.push(path);
        else if ((await sha256(await response.arrayBuffer(), crypto.subtle)) !== file.hash) altered.push(path);
        onProgress(++done / entries.length);
      }
      result = { status: altered.length || missing.length ? 'altered' : 'ok', version: current.version, checked: entries.length, altered, missing, source: 'appareil' };
    }
  }
  // Orion installé : orion-server compare aussi les fichiers qu'il sert.
  if (bridge?.has('integrity')) {
    try {
      const server = await bridge.get('integrity', { timeout: 30_000 });
      if (!result || server.status !== 'ok') result = { ...server, source: 'orion-server', device: result };
      else result.server = server;
    } catch (error) {
      result ??= { status: 'unavailable', reason: error.message };
    }
  }
  return result ?? { status: 'unavailable', reason: 'Pas de copie hors ligne à vérifier (service worker absent ou version pas encore installée).' };
}

/** Fait retélécharger et revérifier les fichiers modifiés par le service worker. */
export function repairIntegrity({ env = globalThis, timeout = 120_000 } = {}) {
  const worker = env.navigator?.serviceWorker?.controller;
  if (!worker) return Promise.resolve({ ok: false, error: 'Service worker indisponible : rechargez Orion.' });
  return new Promise((resolve) => {
    const channel = new env.MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false, error: 'La réparation n\'a pas répondu.' }), timeout);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage({ type: 'repair' }, [channel.port2]);
  });
}
