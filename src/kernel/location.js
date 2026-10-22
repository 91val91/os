/**
 * Localisation (GPS).
 *
 * - Orion installé (orion-server) avec un récepteur GPS (gpsd) : position,
 *   altitude, vitesse, cap, précision et nombre de satellites.
 * - Navigateur : API Geolocation (GPS du téléphone, Wi‑Fi, antennes). Elle
 *   demande une page sécurisée (https ou adresse locale) et l'accord du
 *   navigateur en plus de celui d'Orion.
 *
 * Une seule source est ouverte, partagée par toutes les applications qui
 * suivent la position. Les autorisations par application sont vérifiées par
 * le contexte des apps (ctx.location) ; ce service vérifie seulement que la
 * localisation est activée dans les Réglages.
 */
import { Poller } from './bridge.js';

export class LocationService {
  #watchers = new Set();
  #browserWatch = null;
  #poller = null;

  constructor({ events = null, settings = null, env = globalThis, bridge = null, log = null, now = Date.now, timers = globalThis } = {}) {
    this.events = events;
    this.settings = settings;
    this.env = env;
    this.bridge = bridge;
    this.log = log;
    this.now = now;
    this.timers = timers;
    /** Dernière position connue : { lat, lon, accuracy, alt, speed, heading, satellites, time, source } */
    this.last = null;
    this.error = null;
  }

  /** 'gps' (pont) | 'browser' | null */
  get source() {
    if (this.bridge?.has('gps')) return 'gps';
    if (this.env.navigator?.geolocation) return 'browser';
    return null;
  }

  get enabled() {
    return this.settings?.get('location') !== false;
  }

  /** Position suivie en ce moment (icône de la barre d'état). */
  get active() {
    return this.#watchers.size > 0;
  }

  init() {
    this.settings?.watch('location', (on) => {
      if (!on) this.#stop();
      else if (this.#watchers.size) this.#start();
      this.#emit();
    });
    return this;
  }

  shutdown() {
    this.#watchers.clear();
    this.#stop();
  }

  #emit() {
    this.events?.emit('location:change', { position: this.last, active: this.active, error: this.error, source: this.source });
  }

  #check() {
    if (!this.enabled) throw new Error('Le service de localisation est désactivé (Réglages → Confidentialité).');
    if (!this.source) throw new Error('Aucune source de localisation sur cet appareil.');
  }

  #update(position) {
    this.last = position;
    this.error = null;
    for (const fn of [...this.#watchers]) fn(position);
    this.#emit();
  }

  #fail(message) {
    this.error = message;
    this.#emit();
  }

  // ───────────── Sources ─────────────

  #fromBridge(data) {
    const fix = data?.fix;
    if (!fix) return null;
    return { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy ?? null, alt: fix.alt ?? null, speed: fix.speed ?? null, heading: fix.heading ?? null, satellites: fix.satellites ?? null, time: fix.time ? Date.parse(fix.time) || this.now() : this.now(), source: 'gps' };
  }

  #fromBrowser(pos) {
    const c = pos.coords;
    return { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy ?? null, alt: c.altitude ?? null, speed: c.speed ?? null, heading: Number.isFinite(c.heading) ? c.heading : null, satellites: null, time: pos.timestamp ?? this.now(), source: 'browser' };
  }

  #browserError(error) {
    if (error?.code === 1) return this.env.isSecureContext === false ? 'La localisation demande une page sécurisée (https).' : 'Le navigateur refuse l\'accès à la position. Autorisez-la dans ses réglages du site.';
    if (error?.code === 3) return 'Position introuvable (délai dépassé). Êtes-vous à l\'intérieur ?';
    return 'Position introuvable.';
  }

  #start() {
    if (!this.enabled || !this.source) return;
    if (this.source === 'gps') {
      this.#poller ??= new Poller({
        timers: this.timers,
        interval: 1000,
        fetch: () => this.bridge.get('gps', { timeout: 4000 }),
        onState: (data) => {
          const position = this.#fromBridge(data);
          if (position) this.#update(position);
          else this.#fail(data?.available === false ? 'Aucun récepteur GPS détecté.' : 'Recherche des satellites…');
        },
        onError: (error) => this.#fail(error.message),
      });
      if (!this.#poller.running) this.#poller.start();
    } else if (this.#browserWatch == null) {
      this.#browserWatch = this.env.navigator.geolocation.watchPosition(
        (pos) => this.#update(this.#fromBrowser(pos)),
        (error) => this.#fail(this.#browserError(error)),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 30_000 },
      );
    }
    this.log?.info('gps', `suivi de la position (${this.source === 'gps' ? 'récepteur GPS' : 'navigateur'})`);
  }

  #stop() {
    this.#poller?.stop();
    if (this.#browserWatch != null) this.env.navigator?.geolocation?.clearWatch(this.#browserWatch);
    this.#browserWatch = null;
  }

  // ───────────── API ─────────────

  /** Suit la position ; renvoie la fonction d'arrêt. */
  watch(fn) {
    this.#check();
    this.#watchers.add(fn);
    if (this.last && this.now() - this.last.time < 10_000) fn(this.last);
    if (this.#watchers.size === 1) {
      this.#start();
      this.#emit();
    }
    return () => {
      if (!this.#watchers.delete(fn)) return;
      if (!this.#watchers.size) {
        this.#stop();
        this.#emit();
      }
    };
  }

  /** Position actuelle (une mesure récente est réutilisée). */
  async current({ timeout = 20_000, maxAge = 30_000 } = {}) {
    this.#check();
    if (maxAge > 0 && this.last && this.now() - this.last.time <= maxAge) return this.last;
    if (this.source === 'browser') {
      return new Promise((resolve, reject) => {
        this.env.navigator.geolocation.getCurrentPosition(
          (pos) => {
            const position = this.#fromBrowser(pos);
            this.#update(position);
            resolve(position);
          },
          (error) => reject(new Error(this.#browserError(error))),
          { enableHighAccuracy: true, maximumAge: maxAge, timeout },
        );
      });
    }
    return new Promise((resolve, reject) => {
      let stop = () => {};
      const timer = this.timers.setTimeout(() => {
        stop();
        reject(new Error(this.error && this.error !== 'Recherche des satellites…' ? this.error : 'Pas encore de position GPS : placez-vous à découvert.'));
      }, timeout);
      stop = this.watch((position) => {
        this.timers.clearTimeout(timer);
        // Désabonnement après le retour de watch() (il peut appeler fn immédiatement).
        Promise.resolve().then(() => stop());
        resolve(position);
      });
    });
  }
}

/** Distance en mètres entre deux positions (formule de haversine). */
export function distance(a, b) {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Coordonnées lisibles : 48,8566° N, 2,3522° E */
export function formatCoordinates({ lat, lon }, digits = 5) {
  const f = (v) => Math.abs(v).toFixed(digits).replace('.', ',');
  return `${f(lat)}° ${lat >= 0 ? 'N' : 'S'}, ${f(lon)}° ${lon >= 0 ? 'E' : 'O'}`;
}

/** Trace GPX 1.1 d'un trajet. */
export function toGpx(points, { name = 'Trajet Orion' } = {}) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const pts = points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : ''}<time>${new Date(p.time).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Orion OS" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
