/**
 * Protection de l'appareil, côté interface :
 *  - vérification d'identité (code de verrouillage) avant un paiement ou un
 *    réglage sensible, avec le délai de sécurité si le propriétaire l'a activé ;
 *  - effacement après trop d'échecs du code ;
 *  - verrouillage en cas de vol (mouvement brusque) et hors ligne ;
 *  - code de l'ancien propriétaire après une réinitialisation (protection
 *    contre la réinitialisation) ;
 *  - bilan de sécurité : code, mises à jour, intégrité du système, apps du
 *    Store, mode développeur.
 *
 * Les décisions et ce qui doit survivre à un effacement sont dans le noyau
 * (kernel/protection.js).
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { verifyPasscode } from '../kernel/settings.js';
import { scanApp } from '../kernel/app-scan.js';
import { checkIntegrity } from './integrity.js';

/** « 5 min », « 1 h », « 30 s » */
export function formatWait(seconds) {
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} min`;
  return `${seconds} s`;
}

const SNATCH = 25; // m/s² hors gravité : un téléphone arraché de la main
const OFFLINE_LOCK_AFTER = 10_000;

const SENSITIVE_LABELS = {
  passcode: 'Modifier ou désactiver le code',
  erase: 'Effacer contenu et réglages',
  frp: 'Désactiver la protection contre la réinitialisation',
  protection: 'Désactiver une protection',
};

export class DeviceProtection {
  #lastSnatch = 0;
  #offlineTimer = null;
  #motionOn = false;

  constructor(ui) {
    this.ui = ui;
  }

  get #k() {
    return this.ui.kernel;
  }

  get service() {
    return this.ui.kernel.protection;
  }

  get motionSupported() {
    return typeof globalThis.DeviceMotionEvent === 'function';
  }

  start() {
    const k = this.#k;
    k.events.on('protection:change', () => this.#syncSensors());
    k.events.on('network:change', (state) => this.#onNetwork(state));
    this.#syncSensors();
  }

  // ───────────── Vérification d'identité ─────────────

  /**
   * Demande et vérifie le code de verrouillage. Renvoie le code saisi, '' sans
   * code défini, ou null (annulé, faux, ou essais bloqués). Les échecs comptent
   * comme sur l'écran verrouillé.
   */
  async askCode({ title = 'Vérification', reason = 'Saisissez votre code de verrouillage.' } = {}) {
    const record = this.#k.settings.get('passcode');
    if (!record) return '';
    const dialogs = this.ui.dialogs;
    const lock = this.service.lockout();
    if (lock.wait) {
      await dialogs.alert({ title: 'Trop de tentatives', message: `Réessayez dans ${formatWait(lock.wait)}.` });
      return null;
    }
    const code = await dialogs.prompt({ title, message: reason, type: 'password', placeholder: '•'.repeat(record.length ?? 4), confirmLabel: 'Valider' });
    if (code == null) return null;
    if (await verifyPasscode(record, code)) {
      this.service.recordSuccess();
      return code;
    }
    const result = this.service.recordFailure();
    if (result.wipe) {
      await this.wipeAfterFailures();
      return null;
    }
    const parts = ['Code incorrect.'];
    if (result.wait) parts.push(`Réessayez dans ${formatWait(result.wait)}.`);
    if (result.left != null && result.left <= 3) parts.push(`Encore ${result.left} essai${result.left > 1 ? 's' : ''} avant l'effacement de l'appareil.`);
    await dialogs.alert({ title: 'Vérification impossible', message: parts.join(' ') });
    return null;
  }

  /**
   * Vérification d'identité avant une action. `sensitive` : clé d'un réglage
   * sensible, soumis au délai de sécurité quand il est activé.
   */
  async verify({ title, reason, sensitive = null } = {}) {
    if ((await this.askCode({ title, reason })) == null) return false;
    return sensitive ? this.allowSensitive(sensitive) : true;
  }

  /** Délai de sécurité d'un réglage sensible (après le code) : vrai si l'action peut se faire maintenant. */
  async allowSensitive(action) {
    const result = this.service.requestSensitive(action);
    if (result.allowed) return true;
    const at = new Date(result.readyAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const minutes = Math.max(1, Math.ceil((result.readyAt - Date.now()) / 60_000));
    if (result.started) {
      this.#k.notifications.post({
        appId: 'settings',
        tag: `security-delay-${action}`,
        title: 'Délai de sécurité démarré',
        body: `« ${SENSITIVE_LABELS[action] ?? action} » sera possible à ${at}, pendant une heure.`,
        intent: { app: 'settings', action: 'view', data: { page: 'protection' } },
      });
    }
    await this.ui.dialogs.alert({
      title: 'Délai de sécurité',
      message: result.started
        ? `Protection des données sensibles : cette action sera possible dans 1 heure (à ${at}). Si quelqu'un a appris votre code, il ne peut pas changer vos réglages de sécurité tout de suite.`
        : `Cette action sera possible à ${at} (dans ${minutes} min).`,
    });
    return false;
  }

  // ───────────── Effacement après trop d'échecs ─────────────

  async wipeAfterFailures() {
    const k = this.#k;
    const owner = !k.accounts || Boolean(k.account?.owner);
    k.log.warn('protection', `trop d'échecs du code : effacement ${owner ? 'de l\'appareil' : 'du compte'}`);
    this.service.resetAfterWipe(owner ? null : k.account?.id);
    this.ui.dialogs.toast(owner ? 'Trop de tentatives : effacement de l\'appareil…' : 'Trop de tentatives : effacement des données de ce compte…', { duration: 4000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // La protection contre la réinitialisation, elle, est gardée.
    await this.ui.eraseDevice();
  }

  // ───────────── Verrouillage en cas de vol et hors ligne ─────────────

  get #unlocked() {
    return ['home', 'app', 'recents'].includes(this.ui.state);
  }

  #syncSensors() {
    const want = this.service.options.theftLock && this.motionSupported;
    if (want === this.#motionOn) return;
    this.#motionOn = want;
    if (want) globalThis.addEventListener('devicemotion', this.#onMotion);
    else globalThis.removeEventListener('devicemotion', this.#onMotion);
  }

  /** iOS demande l'accord pour les capteurs de mouvement (après un geste de l'utilisateur). */
  async requestMotionPermission() {
    const request = globalThis.DeviceMotionEvent?.requestPermission;
    if (typeof request !== 'function') return this.motionSupported;
    try {
      return (await request.call(globalThis.DeviceMotionEvent)) === 'granted';
    } catch {
      return false;
    }
  }

  #onMotion = (event) => {
    if (!this.#unlocked) return;
    const a = event.acceleration;
    let force;
    if (a && a.x != null) force = Math.hypot(a.x, a.y, a.z);
    else {
      const g = event.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      force = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
    }
    if (force < SNATCH || Date.now() - this.#lastSnatch < 5000) return;
    this.#lastSnatch = Date.now();
    this.#lockFor('Mouvement brusque détecté : l\'appareil a été verrouillé (verrouillage en cas de vol).');
  };

  #onNetwork(state) {
    clearTimeout(this.#offlineTimer);
    if (!this.service.options.offlineLock || state?.online !== false) return;
    // Hors ligne depuis 10 s alors que l'appareil est déverrouillé : on verrouille.
    this.#offlineTimer = setTimeout(() => {
      if (this.#k.network.state.online === false && this.#unlocked && !this.#k.telephony.call) this.#lockFor('Connexion perdue : l\'appareil a été verrouillé (verrouillage hors ligne).');
    }, OFFLINE_LOCK_AFTER);
  }

  #lockFor(message) {
    if (!this.#k.settings.get('passcode')) return;
    this.ui.lockNow();
    this.#k.notifications.post({ appId: 'settings', tag: 'theft-lock', title: 'Protection de l\'appareil', body: message, intent: { app: 'settings', action: 'view', data: { page: 'protection' } } });
  }

  // ───────────── Après une réinitialisation ─────────────

  /** Écran « Appareil protégé » : le code de l'ancien propriétaire lève la protection. */
  challenge() {
    const layer = this.ui.layers.setup;
    const frp = this.service.frp;
    const k = this.#k;
    return new Promise((resolve) => {
      const input = h('input.setup-input.frp-input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, placeholder: 'Code de verrouillage', 'aria-label': 'Code de l\'ancien propriétaire' });
      const error = h('p.frp-error');
      const submit = h('button.btn.btn-filled.block', { type: 'button', onclick: () => check() }, 'Déverrouiller');
      const masked = (email) => (email ? email.replace(/^(.)[^@]*(@.*)$/, (_, a, b) => `${a}•••${b}`) : '');
      const owner = [frp.owner?.name, masked(frp.owner?.email)].filter(Boolean).join(' · ');
      let timer = null;
      const showWait = (wait) => {
        clearInterval(timer);
        if (!wait) {
          submit.disabled = false;
          return;
        }
        let left = wait;
        submit.disabled = true;
        error.textContent = `Trop d'essais : réessayez dans ${formatWait(left)}.`;
        timer = setInterval(() => {
          left--;
          if (left <= 0) {
            clearInterval(timer);
            submit.disabled = false;
            error.textContent = '';
          } else error.textContent = `Trop d'essais : réessayez dans ${formatWait(left)}.`;
        }, 1000);
      };
      async function check() {
        const code = input.value.trim();
        if (!/^\d{4,8}$/.test(code)) {
          error.textContent = 'Le code compte 4 à 8 chiffres.';
          return;
        }
        submit.disabled = true;
        const result = await k.protection.disableFrp(code).catch((e) => ({ ok: false, wait: 0, error: e.message }));
        input.value = '';
        if (result.ok) {
          clearInterval(timer);
          k.log.info('protection', 'protection contre la réinitialisation levée par le code de l\'ancien propriétaire');
          page.remove();
          resolve();
          return;
        }
        k.device.vibrate([60, 40, 60]);
        error.textContent = result.wait ? '' : 'Code incorrect.';
        submit.disabled = false;
        showWait(result.wait);
      }
      input.addEventListener('keydown', (e) => e.key === 'Enter' && check());
      const page = h(
        'div.setup-page.frp-page',
        h(
          'div.setup-body',
          h('div.setup-logo.frp-logo', icon('lock-fill', { size: 38 })),
          h('h1', 'Appareil protégé'),
          h('p.setup-lead', 'Cet appareil a été réinitialisé alors que la protection contre la réinitialisation était activée. Pour continuer, saisissez le code de verrouillage de son propriétaire.'),
          owner ? h('p.frp-owner', icon('user', { size: 16 }), owner) : null,
          input,
          error,
        ),
        h(
          'div.setup-footer',
          submit,
          h('button.btn.btn-plain.block', { type: 'button', onclick: () => this.ui.emergencyCall() }, 'Appel d\'urgence'),
          h('button.btn.btn-plain.block', {
            type: 'button',
            onclick: () => this.ui.dialogs.alert({ title: 'Code oublié', message: 'Seul le propriétaire de l\'appareil peut lever cette protection, avec le code de verrouillage qu\'il utilisait. Si vous avez acheté cet appareil, demandez au vendeur de la désactiver (Réglages › Protection de l\'appareil) avant de vous le remettre.' }),
          }, 'Code oublié ?'),
        ),
      );
      layer.replaceChildren(page);
      layer.classList.add('visible');
      showWait(k.protection.frpWait);
      setTimeout(() => input.focus({ preventScroll: true }), 300);
    });
  }

  // ───────────── Analyses ─────────────

  /** Analyse d'une app du Store avant son installation. */
  scanBeforeInstall(pkg) {
    return pkg?.store ? scanApp(pkg.code) : { level: 'safe', findings: [] };
  }

  /** Apps du Store installées : celles qui posent problème. */
  scanApps() {
    const apps = this.#k.packages.list().filter((p) => p.store);
    const threats = apps
      .map((pkg) => ({ id: pkg.id, name: pkg.name, ...scanApp(pkg.code) }))
      .filter((r) => r.level !== 'safe');
    return { scanned: apps.length, threats };
  }

  /** Analyse complète : intégrité du système et apps. Gardée pour le bilan. */
  async scan({ onProgress } = {}) {
    const integrity = await checkIntegrity({ bridge: this.#k.bridge, onProgress }).catch((error) => ({ status: 'unavailable', reason: error.message }));
    const apps = this.scanApps();
    this.service.saveScan({ integrity, apps });
    return this.service.lastScan;
  }

  /**
   * Bilan de sécurité : liste de { id, level: 'ok' | 'warning' | 'danger', title, detail }.
   */
  checkup() {
    const k = this.#k;
    const s = k.settings;
    const last = this.service.lastScan;
    const updates = this.ui.updates;
    const dayMs = 86_400_000;
    const items = [];
    items.push(
      s.get('passcode')
        ? { id: 'passcode', level: 'ok', title: 'Code de verrouillage', detail: 'Activé' }
        : { id: 'passcode', level: 'danger', title: 'Aucun code de verrouillage', detail: 'N\'importe qui peut ouvrir l\'appareil et voir vos données.' },
    );
    const autoLock = s.get('autoLock');
    items.push(autoLock && autoLock <= 300 ? { id: 'autolock', level: 'ok', title: 'Verrouillage automatique', detail: `Après ${formatWait(autoLock)}` } : { id: 'autolock', level: 'warning', title: 'Verrouillage automatique', detail: autoLock ? `Après ${formatWait(autoLock)} : un délai plus court est conseillé` : 'Jamais : l\'appareil reste ouvert' });
    if (['available', 'ready', 'downloading'].includes(updates?.status)) items.push({ id: 'updates', level: 'warning', title: 'Mise à jour disponible', detail: `Orion OS ${updates.available?.label ?? updates.available?.version ?? ''} corrige peut-être des failles` });
    else if (!updates?.lastCheck || Date.now() - updates.lastCheck > 7 * dayMs) items.push({ id: 'updates', level: 'warning', title: 'Mises à jour', detail: 'Pas vérifiées depuis plus de 7 jours' });
    else items.push({ id: 'updates', level: 'ok', title: 'Mises à jour', detail: `Orion OS ${k.os.label} est à jour` });
    const integrity = last?.integrity;
    if (!integrity) items.push({ id: 'integrity', level: 'warning', title: 'Intégrité du système', detail: 'Pas encore vérifiée' });
    else if (integrity.status === 'ok') items.push({ id: 'integrity', level: 'ok', title: 'Intégrité du système', detail: `${integrity.checked} fichiers conformes à la version publiée` });
    else if (integrity.status === 'altered') items.push({ id: 'integrity', level: 'danger', title: 'Fichiers système modifiés', detail: `${(integrity.altered?.length ?? 0) + (integrity.missing?.length ?? 0)} fichier(s) ne correspondent pas à la version publiée` });
    else items.push({ id: 'integrity', level: 'warning', title: 'Intégrité du système', detail: integrity.reason ?? 'Vérification impossible ici' });
    const apps = last?.apps ?? this.scanApps();
    items.push(
      apps.threats.length
        ? { id: 'apps', level: apps.threats.some((t) => t.level === 'danger') ? 'danger' : 'warning', title: `${apps.threats.length} app${apps.threats.length > 1 ? 's' : ''} à surveiller`, detail: apps.threats.map((t) => t.name).join(', ') }
        : { id: 'apps', level: 'ok', title: 'Apps', detail: apps.scanned ? `${apps.scanned} app${apps.scanned > 1 ? 's' : ''} du Store analysée${apps.scanned > 1 ? 's' : ''}, aucun problème` : 'Aucune app tierce installée' },
    );
    if (this.ui.developer?.unlocked) items.push({ id: 'developer', level: 'warning', title: 'Mode développeur ouvert', detail: 'Le Terminal et les options avancées sont accessibles jusqu\'au verrouillage' });
    const frp = this.service.frp;
    items.push(frp.enabled ? { id: 'frp', level: 'ok', title: 'Protection contre la réinitialisation', detail: frp.remote ? 'Activée (gardée aussi par orion-server)' : 'Activée' } : { id: 'frp', level: 'warning', title: 'Protection contre la réinitialisation', detail: 'Désactivée : un voleur pourrait effacer et réutiliser l\'appareil' });
    return items;
  }
}
