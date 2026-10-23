/**
 * Mises à jour d'Orion OS (Réglages → Général → Mise à jour logicielle).
 *
 * La version publiée est décrite par version.json. Une version plus récente
 * est téléchargée par le service worker à côté de la version installée
 * (seuls les fichiers modifiés transitent, chacun est vérifié), puis
 * installée au redémarrage. Les vérifications et, si l'utilisateur le
 * souhaite, le téléchargement et l'installation sont automatiques.
 *
 * Sans service worker (page http sur le réseau local, ?nosw), installer
 * revient à recharger la page depuis le serveur.
 */
import { RELEASE, versionLabel } from '../kernel/version.js';

const CHECK_EVERY = 6 * 3_600_000;
/** Sans nouvelles du téléchargement pendant ce délai, on demande au service worker où il en est. */
const STALL = 60_000;

/** Compare deux numéros de version « 1.2.3 » : négatif, nul ou positif. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

const ordered = (release) => Number.isInteger(release?.sequence);

/**
 * Laquelle de deux versions est la plus récente : négatif, nul ou positif.
 * Le numéro d'ordre (sequence) décide, le numéro affiché pouvant repartir de
 * zéro (1.2.0 → 0.1 alpha). Les versions d'avant la 0.1 n'en ont pas : elles
 * sont plus anciennes que toutes celles qui en ont un.
 */
export function compareReleases(a, b) {
  if (ordered(a) && ordered(b)) return Math.sign(a.sequence - b.sequence);
  if (ordered(a) !== ordered(b)) return ordered(a) ? 1 : -1;
  return compareVersions(a?.version, b?.version);
}

const newer = (release) => compareReleases(release, RELEASE) > 0;

const summary = (manifest, download = manifest.size) => ({
  version: manifest.version,
  channel: manifest.channel ?? null,
  sequence: manifest.sequence ?? null,
  label: versionLabel(manifest),
  build: manifest.build,
  date: manifest.date,
  notes: manifest.notes ?? [],
  size: manifest.size ?? 0,
  download: download ?? 0,
});

export class UpdateManager {
  #watchdog = null;
  #settle = null;
  #timers = [];

  constructor(ui, { env = globalThis } = {}) {
    this.ui = ui;
    this.k = ui.kernel;
    this.env = env;
    /** idle | checking | uptodate | available | downloading | ready | installing | error */
    this.status = 'idle';
    this.available = null;
    this.progress = null;
    this.error = null;
  }

  get installed() {
    return RELEASE;
  }

  get lastCheck() {
    return this.k.settings.get('updates.lastCheck') || 0;
  }

  get #worker() {
    return this.env.navigator?.serviceWorker?.controller ?? null;
  }

  start() {
    this.env.navigator?.serviceWorker?.addEventListener('message', (event) => this.#onMessage(event.data ?? {}));
    // Notification d'une version précédente (déjà installée) : elle sera reposée si besoin.
    this.k.notifications.clear({ appId: 'settings', tag: 'update' });
    // Une mise à jour déjà téléchargée (avant un redémarrage) attend d'être installée ;
    // elle est revérifiée auprès de version.json (l'éditeur a pu la retirer).
    this.#ask({ type: 'status' }).then((status) => {
      if (status?.staged && newer(status.staged) && this.status === 'idle') {
        this.#set('ready', { available: summary(status.staged) });
        this.check();
      }
    });
    // Vérification automatique peu après le démarrage, puis régulièrement.
    this.#timers.push(setTimeout(() => this.#autoCheck(), 20_000), setInterval(() => this.#autoCheck(), 30 * 60_000));
    // Installation automatique : quand l'appareil se verrouille.
    this.k.events.on('device:lock', () => this.#autoInstall());
  }

  /** Arrête les vérifications automatiques (fin de session). */
  stop() {
    this.#timers.splice(0).forEach((id) => {
      clearTimeout(id);
      clearInterval(id);
    });
    clearTimeout(this.#watchdog);
  }

  #set(status, patch = {}) {
    Object.assign(this, { checkError: null, ...patch });
    this.status = status;
    if (status !== 'error') this.error = patch.error ?? null;
    if (status !== 'downloading') clearTimeout(this.#watchdog);
    this.k.events.emit('update:change', { status });
  }

  /** Téléchargement terminé ou interrompu sans réponse (autre fenêtre, service worker arrêté) : on demande l'état réel. */
  async #resolveDownload(error = 'Le téléchargement a été interrompu.') {
    if (this.status !== 'downloading') return;
    const staged = (await this.#ask({ type: 'status' }))?.staged;
    if (this.status !== 'downloading') return;
    if (staged && newer(staged)) {
      this.#set('ready', { available: summary(staged), progress: null });
      this.#notify();
    } else {
      this.#set('error', { error, progress: null });
    }
    this.#settle?.();
  }

  #watch() {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => this.#resolveDownload(), STALL);
  }

  /** Message au service worker, avec sa réponse (null sans service worker). */
  #ask(message, timeout = 8000) {
    const worker = this.#worker;
    if (!worker) return Promise.resolve(null);
    return new Promise((resolve) => {
      const channel = new this.env.MessageChannel();
      const timer = timeout ? setTimeout(() => resolve(null), timeout) : null;
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.postMessage(message, [channel.port2]);
    });
  }

  async check({ auto = false } = {}) {
    if (['checking', 'downloading', 'installing'].includes(this.status)) return;
    if (auto && this.ui.poweredOff) return;
    const before = { status: this.status, available: this.available };
    this.#set('checking');
    let manifest;
    try {
      const response = await this.env.fetch('version.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      manifest = await response.json();
    } catch {
      const error = this.env.navigator?.onLine === false ? 'Pas de connexion à Internet.' : 'Impossible de vérifier les mises à jour pour le moment.';
      // Une mise à jour déjà téléchargée reste installable hors ligne.
      if (before.status === 'ready') this.#set('ready', { available: before.available, checkError: error });
      else this.#set('error', { error });
      return;
    }
    this.k.settings.set('updates.lastCheck', Date.now());
    if (!newer(manifest)) {
      // Version retirée par l'éditeur : celle qui était prête ne doit pas être installée.
      await this.#ask({ type: 'discard' });
      this.#set('uptodate', { available: null });
      this.k.notifications.clear({ appId: 'settings', tag: 'update' });
      return;
    }
    const known = this.available?.version === manifest.version;
    let staged = (await this.#ask({ type: 'status' }))?.staged;
    if (staged && staged.version !== manifest.version) {
      await this.#ask({ type: 'discard', keep: manifest.version });
      staged = null;
    }
    const estimate = await this.#ask({ type: 'estimate', files: manifest.files });
    this.#set(staged?.version === manifest.version ? 'ready' : 'available', { available: summary(manifest, estimate?.size) });
    if (!known) this.#notify();
    if (auto && this.status === 'available' && this.k.settings.get('updates.autoDownload')) await this.download();
  }

  async download() {
    if (!this.available || ['downloading', 'installing'].includes(this.status)) return;
    if (!this.#worker) {
      this.#set('ready');
      return;
    }
    this.#set('downloading', { progress: { done: 0, total: 0, downloaded: 0 } });
    this.#watch();
    // La réponse peut ne jamais venir (service worker arrêté) : le chien de garde règle alors l'état.
    const result = await Promise.race([this.#ask({ type: 'download' }, 0), new Promise((resolve) => (this.#settle = () => resolve(null)))]);
    this.#settle = null;
    if (this.status !== 'downloading') return;
    if (!result?.ok) {
      this.#set('error', { error: result?.error ?? 'Le téléchargement a été interrompu.' });
      return;
    }
    if (result.upToDate) {
      this.#set('uptodate', { available: null });
      return;
    }
    this.#set('ready', { available: summary(result.staged), progress: null });
    this.#notify();
  }

  async install() {
    if (this.status !== 'ready') return;
    const version = this.available.label ?? this.available.version;
    this.#set('installing');
    if (this.#worker) {
      const result = await this.#ask({ type: 'install' });
      if (!result?.ok) {
        this.#set('error', { error: result?.error ?? 'L\'installation a échoué.' });
        return;
      }
    }
    this.installing = true;
    await this.ui.power.restart(`Installation d'Orion OS ${version}…`);
  }

  #onMessage(message) {
    if (message.type === 'update-progress' && newer(message)) {
      if (['installing', 'checking'].includes(this.status)) return;
      if (this.status !== 'downloading') this.available = this.available?.version === message.version ? this.available : summary({ version: message.version, channel: message.channel, sequence: message.sequence, size: 0 });
      this.#set('downloading', { progress: message });
      this.#watch();
    } else if (message.type === 'update-ready' && this.status === 'downloading') {
      // Téléchargement lancé par une autre fenêtre (ou avant un redémarrage) : il est prêt.
      this.#resolveDownload();
    } else if (message.type === 'update-failed' && this.status === 'downloading') {
      this.#resolveDownload(message.error);
    } else if (message.type === 'update-installed' && !this.installing && !this.ui.poweredOff) {
      // Installée depuis une autre fenêtre d'Orion : celle-ci redémarre aussi.
      this.installing = true;
      this.ui.power.restart(`Orion OS ${versionLabel(message)} a été installé…`);
    }
  }

  #notify() {
    const ready = this.status === 'ready';
    this.k.notifications.post({
      appId: 'settings',
      tag: 'update',
      title: ready ? 'Mise à jour prête à installer' : 'Mise à jour disponible',
      body: `Orion OS ${this.available.label ?? this.available.version} — ${ready ? 'touchez pour l\'installer.' : 'touchez pour en savoir plus.'}`,
      intent: { app: 'settings', action: 'view', data: { page: 'updates' } },
    });
  }

  #autoCheck() {
    if (this.ui.poweredOff) return;
    if (Date.now() - this.lastCheck >= CHECK_EVERY) this.check({ auto: true });
  }

  /** Appareil verrouillé (ou écran éteint) et rien en cours : un redémarrage ne dérange personne. */
  get #idle() {
    return ['locked', 'off'].includes(this.ui.state) && !this.ui.poweredOff && !this.k.telephony.call && !this.ui.alarmScreen?.isVisible && !this.k.media.get()?.playing;
  }

  #autoInstall() {
    if (this.status !== 'ready' || !this.k.settings.get('updates.autoInstall')) return;
    // Vérifié au moment d'installer (l'événement précède le verrouillage) : déverrouillage rapide, appel, réveil ou musique.
    setTimeout(() => this.status === 'ready' && this.#idle && this.install(), 1500);
  }
}
