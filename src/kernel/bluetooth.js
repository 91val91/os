/**
 * Bluetooth.
 *
 * - Orion installé (orion-server) : BlueZ. Activation de l'adaptateur,
 *   recherche, appairage, connexion, oubli, niveau de batterie : tous les
 *   appareils (écouteurs, enceintes, claviers, manettes…).
 * - Navigateur compatible Web Bluetooth (Chrome sur Android, ordinateur) :
 *   appareils Bluetooth Low Energy choisis par l'utilisateur dans la fenêtre du
 *   navigateur (montres, capteurs, balises…). Orion s'y connecte réellement
 *   (GATT) et lit leur batterie quand ils l'exposent. Les écouteurs et
 *   enceintes « classiques » s'appairent dans les réglages du téléphone.
 * - Safari (iPhone, iPad) et Firefox n'offrent pas le Bluetooth aux pages web.
 */
import { Poller } from './bridge.js';

const BATTERY_SERVICE = 'battery_service';
const BATTERY_LEVEL = 'battery_level';
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;

export class BluetoothService {
  #bridgeState = null; // { powered, discovering, devices }
  #poller = null;
  #web = new Map(); // id → { device, battery, connected, error }
  #scanTimer = null;

  constructor({ events = null, settings = null, env = globalThis, bridge = null, log = null, timers = globalThis } = {}) {
    this.events = events;
    this.settings = settings;
    this.env = env;
    this.bridge = bridge;
    this.log = log;
    this.timers = timers;
    this.scanning = false;
  }

  /** 'bridge' | 'web' | null */
  get mode() {
    if (this.bridge?.has('bluetooth')) return 'bridge';
    if (this.env.navigator?.bluetooth?.requestDevice) return 'web';
    return null;
  }

  get available() {
    return this.mode !== null;
  }

  init() {
    if (this.mode === 'bridge') {
      this.#poller = new Poller({
        timers: this.timers,
        interval: 15_000,
        fetch: () => this.bridge.get('bluetooth'),
        onState: (state) => {
          this.#bridgeState = state;
          this.#emit();
        },
        onError: (error) => this.log?.warn('bt', error.message),
      }).start();
    } else {
      // Bluetooth d'Orion coupé (ou mode avion) : les appareils Web Bluetooth sont déconnectés.
      const off = () => !this.enabled && this.#disconnectWeb();
      this.settings?.watch('bluetooth', off);
      this.settings?.watch('airplane', off);
      this.#restoreWeb();
    }
    return this;
  }

  shutdown() {
    this.#poller?.stop();
    this.timers.clearTimeout(this.#scanTimer);
    this.#disconnectWeb();
  }

  #emit() {
    this.events?.emit('bluetooth:change', this.state);
  }

  /** Bluetooth activé : adaptateur réel (pont) ou réglage d'Orion (navigateur). */
  get enabled() {
    if (this.settings?.get('airplane') && this.mode !== 'bridge') return false;
    if (this.mode === 'bridge') return Boolean(this.#bridgeState?.powered);
    return Boolean(this.settings?.get('bluetooth'));
  }

  get state() {
    return { mode: this.mode, enabled: this.enabled, scanning: this.scanning || Boolean(this.#bridgeState?.discovering), devices: this.devices() };
  }

  /**
   * Appareils connus et découverts :
   * { id, name, paired, connected, battery, icon, kind }
   */
  devices() {
    if (this.mode === 'bridge') {
      return (this.#bridgeState?.devices ?? []).map((d) => ({ id: d.address, address: d.address, name: d.name || d.address, paired: Boolean(d.paired), connected: Boolean(d.connected), battery: d.battery ?? null, icon: d.icon ?? null, kind: kindOf(d.icon) }));
    }
    const remembered = this.settings?.get('bluetooth.devices') ?? [];
    return remembered.map((d) => {
      const live = this.#web.get(d.id);
      return { id: d.id, name: d.name, paired: true, connected: Boolean(live?.connected), battery: live?.battery ?? null, icon: null, kind: 'ble', error: live?.error ?? null };
    });
  }

  get connectedCount() {
    return this.devices().filter((d) => d.connected).length;
  }

  // ───────────── Pont (BlueZ) ─────────────

  async refresh() {
    if (this.mode !== 'bridge') return this.state;
    this.#bridgeState = await this.bridge.get('bluetooth');
    this.#emit();
    return this.state;
  }

  watch() {
    if (!this.#poller) return () => {};
    this.#poller.start(3000);
    return () => this.#poller.start(15_000);
  }

  async setPowered(on) {
    if (this.mode === 'bridge') {
      await this.bridge.post('bluetooth/power', { enabled: Boolean(on) });
      await this.refresh().catch(() => {});
    } else {
      this.settings?.set('bluetooth', Boolean(on));
      this.#emit();
    }
  }

  async scan(seconds = 12) {
    if (this.mode !== 'bridge') throw new Error('Recherche impossible ici : utilisez « Ajouter un appareil ».');
    await this.bridge.post('bluetooth/scan', { seconds });
    this.scanning = true;
    this.#emit();
    this.timers.clearTimeout(this.#scanTimer);
    this.#scanTimer = this.timers.setTimeout(() => {
      this.scanning = false;
      this.refresh().catch(() => {});
    }, seconds * 1000);
  }

  async #bridgeAction(action, id) {
    if (!MAC.test(id)) throw new Error('Appareil inconnu');
    await this.bridge.post(`bluetooth/${action}`, { address: id }, { timeout: 45_000 });
    await this.refresh().catch(() => {});
  }

  // ───────────── Web Bluetooth ─────────────

  /** Ouvre la fenêtre de choix du navigateur et se connecte à l'appareil choisi. */
  async add() {
    if (this.mode === 'bridge') throw new Error('Touchez un appareil de la liste pour l\'appairer.');
    if (this.mode !== 'web') throw new Error(unsupportedReason(this.env));
    if (!this.enabled) throw new Error('Activez le Bluetooth');
    let device;
    try {
      device = await this.env.navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [BATTERY_SERVICE, 'device_information'] });
    } catch (error) {
      if (error?.name === 'NotFoundError') return null; // fenêtre fermée sans choix
      throw new Error(error?.name === 'SecurityError' ? 'Le Bluetooth demande une page sécurisée (https).' : error?.message || 'Bluetooth indisponible');
    }
    const remembered = (this.settings?.get('bluetooth.devices') ?? []).filter((d) => d.id !== device.id);
    this.settings?.set('bluetooth.devices', [...remembered, { id: device.id, name: device.name || 'Appareil Bluetooth' }]);
    this.#track(device);
    await this.#connectWeb(device);
    return { id: device.id, name: device.name };
  }

  #track(device) {
    const entry = this.#web.get(device.id) ?? { device, battery: null, connected: false, error: null };
    if (entry.device !== device || !entry.listening) {
      entry.device = device;
      entry.listening = true;
      device.addEventListener?.('gattserverdisconnected', () => {
        entry.connected = false;
        this.#emit();
      });
    }
    this.#web.set(device.id, entry);
    return entry;
  }

  async #connectWeb(device) {
    const entry = this.#track(device);
    entry.error = null;
    try {
      const server = await device.gatt.connect();
      entry.connected = true;
      try {
        const service = await server.getPrimaryService(BATTERY_SERVICE);
        const level = await service.getCharacteristic(BATTERY_LEVEL);
        const read = (value) => {
          entry.battery = value.getUint8(0);
          this.#emit();
        };
        read(await level.readValue());
        await level.startNotifications?.().catch(() => {});
        level.addEventListener?.('characteristicvaluechanged', (event) => read(event.target.value));
      } catch {
        /* pas de service batterie */
      }
      this.log?.info('bt', `connecté à ${device.name || device.id}`);
    } catch (error) {
      entry.connected = false;
      entry.error = 'Connexion impossible : l\'appareil est-il allumé et à portée ?';
      this.log?.warn('bt', `${device.name || device.id} : ${error?.message}`);
      throw new Error(entry.error);
    } finally {
      this.#emit();
    }
  }

  /** Appareils déjà autorisés (Chrome sait les retrouver sans nouvelle fenêtre de choix). */
  async #restoreWeb() {
    if (this.mode !== 'web' || !this.env.navigator.bluetooth.getDevices) return;
    try {
      const known = new Set((this.settings?.get('bluetooth.devices') ?? []).map((d) => d.id));
      for (const device of await this.env.navigator.bluetooth.getDevices()) if (known.has(device.id)) this.#track(device);
      this.#emit();
    } catch {
      /* non pris en charge */
    }
  }

  #disconnectWeb() {
    for (const entry of this.#web.values()) {
      if (entry.connected) entry.device.gatt?.disconnect();
      entry.connected = false;
    }
    this.#emit();
  }

  // ───────────── Actions communes ─────────────

  async connect(id) {
    if (this.mode === 'bridge') {
      // Appairer un appareil ne le connecte pas (BlueZ) : on enchaîne les deux.
      if (!this.devices().find((d) => d.id === id)?.paired) await this.#bridgeAction('pair', id);
      return this.#bridgeAction('connect', id);
    }
    if (!this.enabled) throw new Error('Activez le Bluetooth');
    const entry = this.#web.get(id);
    // Sans getDevices(), l'autorisation du navigateur ne survit pas au rechargement : il faut rechoisir l'appareil.
    if (!entry) return this.add();
    return this.#connectWeb(entry.device);
  }

  async pair(id) {
    if (this.mode !== 'bridge') return this.connect(id);
    return this.#bridgeAction('pair', id);
  }

  async disconnect(id) {
    if (this.mode === 'bridge') return this.#bridgeAction('disconnect', id);
    const entry = this.#web.get(id);
    entry?.device.gatt?.disconnect();
    if (entry) entry.connected = false;
    this.#emit();
  }

  async forget(id) {
    if (this.mode === 'bridge') return this.#bridgeAction('remove', id);
    const entry = this.#web.get(id);
    entry?.device.gatt?.disconnect();
    await entry?.device.forget?.().catch(() => {});
    this.#web.delete(id);
    this.settings?.set('bluetooth.devices', (this.settings.get('bluetooth.devices') ?? []).filter((d) => d.id !== id));
    this.#emit();
  }
}

/** Famille d'appareil (icône BlueZ) pour l'affichage. */
function kindOf(icon = '') {
  if (/audio|headset|headphone/.test(icon)) return 'audio';
  if (/phone/.test(icon)) return 'phone';
  if (/computer/.test(icon)) return 'computer';
  if (/input-keyboard/.test(icon)) return 'keyboard';
  if (/input-mouse|input-tablet/.test(icon)) return 'mouse';
  if (/input-gaming/.test(icon)) return 'gamepad';
  if (/watch/.test(icon)) return 'watch';
  return 'other';
}

/** Explication honnête quand la page n'a pas accès au Bluetooth. */
export function unsupportedReason(env = globalThis) {
  const ua = env.navigator?.userAgent ?? '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.navigator?.maxTouchPoints > 1)) return 'Safari ne donne pas accès au Bluetooth aux pages web sur iPhone et iPad.';
  if (/Firefox/.test(ua)) return 'Firefox ne donne pas accès au Bluetooth aux pages web. Utilisez Chrome.';
  if (env.isSecureContext === false) return 'Le Bluetooth demande une page sécurisée (https).';
  return 'Ce navigateur ne donne pas accès au Bluetooth.';
}
