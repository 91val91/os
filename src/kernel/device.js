/**
 * Couche d'abstraction matérielle (HAL) : batterie, vibreur, lampe,
 * informations sur l'appareil. Utilise les API du navigateur quand elles
 * existent et simule le reste. Le réseau est géré par NetworkService.
 */
export class DeviceService {
  constructor({ events = null, settings = null, env = globalThis, now = Date.now, log = null, network = null } = {}) {
    this.events = events;
    this.settings = settings;
    this.env = env;
    this.now = now;
    this.log = log;
    this.network = network;
    this.bootTime = now();
    this.battery = { level: 0.86, charging: false, simulated: true };
    this.lastDrain = now();
  }

  async init() {
    const nav = this.env.navigator;
    if (nav?.getBattery) {
      try {
        const battery = await nav.getBattery();
        // Ordinateurs sans batterie : batterie fictive pleine et branchée → simulation.
        const fake = battery.level === 1 && battery.charging && battery.chargingTime === 0;
        if (!fake) {
          const sync = () => {
            this.battery = { level: battery.level, charging: battery.charging, simulated: false };
            this.events?.emit('battery:change', { ...this.battery });
          };
          battery.addEventListener?.('levelchange', sync);
          battery.addEventListener?.('chargingchange', sync);
          sync();
        }
      } catch {
        /* simulation */
      }
    }
    this.log?.info('hal', `batterie ${this.battery.simulated ? 'simulée' : 'réelle'}`);
    return this;
  }

  /** Résumé de la connexion (voir NetworkService pour le détail). */
  get connectivity() {
    const n = this.network?.state;
    const online = n ? n.online : this.env.navigator?.onLine ?? true;
    return { airplane: Boolean(this.settings?.get('airplane')), online, type: n?.type ?? 'unknown', wifi: n?.type === 'wifi', cellular: n?.type === 'cellular', network: n?.wifi.connected?.ssid ?? null };
  }

  /** Avance la simulation de batterie (appelé périodiquement). */
  tick(now = this.now()) {
    if (!this.battery.simulated) return;
    const minutes = (now - this.lastDrain) / 60_000;
    if (minutes < 1) return;
    this.lastDrain = now;
    const saver = this.settings?.get('batterySaver');
    const delta = this.battery.charging ? 0.02 * minutes : -(saver ? 0.002 : 0.004) * minutes;
    const level = Math.min(1, Math.max(0.01, this.battery.level + delta));
    if (level !== this.battery.level) {
      const previous = this.battery.level;
      this.battery = { ...this.battery, level };
      this.events?.emit('battery:change', { ...this.battery, previous });
    }
  }

  setCharging(charging) {
    this.battery = { ...this.battery, charging, simulated: true };
    this.events?.emit('battery:change', { ...this.battery });
  }

  setBatteryLevel(level) {
    this.battery = { ...this.battery, level: Math.min(1, Math.max(0.01, level)), simulated: true };
    this.events?.emit('battery:change', { ...this.battery });
  }

  vibrate(pattern = 12) {
    if (this.settings?.get('haptics') === false) return false;
    try {
      return Boolean(this.env.navigator?.vibrate?.(pattern));
    } catch {
      return false;
    }
  }

  uptime() {
    return this.now() - this.bootTime;
  }

  info() {
    const nav = this.env.navigator ?? {};
    const screen = this.env.screen;
    return {
      model: 'Orion Phone (web)',
      userAgent: nav.userAgent ?? 'inconnu',
      platform: nav.userAgentData?.platform ?? nav.platform ?? 'inconnue',
      cores: nav.hardwareConcurrency ?? null,
      memory: nav.deviceMemory ?? null,
      screen: screen ? `${screen.width}×${screen.height} @${this.env.devicePixelRatio ?? 1}x` : 'inconnu',
      language: nav.language ?? 'fr-FR',
    };
  }

  /** Demande d'alimentation : 'lock' | 'reboot' | 'shutdown' (traitée par l'interface). */
  requestPower(action) {
    this.log?.info('power', `demande : ${action}`);
    this.events?.emit('power:request', { action });
  }
}
