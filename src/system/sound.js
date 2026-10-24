/**
 * Synthèse sonore du système (Web Audio) : clics, notifications, sonneries,
 * tonalités DTMF, obturateur. Aucun fichier audio n'est nécessaire.
 */
const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

export class SoundManager {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.loops = new Map();
    this.playbackHolders = new Set();
    // Les navigateurs mobiles n'autorisent le son qu'après un geste de l'utilisateur.
    const unlock = () => {
      const ctx = this.#context();
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
      window.addEventListener(type, unlock, { capture: true });
    }
  }

  /**
   * Sur iPhone, Web Audio est coupé par l'interrupteur silencieux du téléphone ;
   * la catégorie « playback » le fait sonner quand même (réveil, appel, musique).
   * `holder` identifie qui en a besoin : la catégorie reste active tant qu'il en reste un.
   */
  setPlaybackSession(holder, active) {
    if (active) this.playbackHolders.add(holder);
    else this.playbackHolders.delete(holder);
    if (globalThis.navigator?.audioSession) navigator.audioSession.type = this.playbackHolders.size ? 'playback' : 'auto';
  }

  #context() {
    if (this.ctx) return this.ctx;
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) return null;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  get volume() {
    return this.settings.get('volume');
  }

  /** Sons d'interface : coupés en mode silencieux ou si désactivés. */
  #uiAllowed() {
    return this.settings.get('sounds') && !this.settings.get('silent');
  }

  tone(freqs, { duration = 0.12, type = 'sine', gain = 0.25, when = 0, attack = 0.005, release = 0.08, ignoreSilent = false } = {}) {
    const ctx = this.#context();
    if (!ctx || ctx.state === 'closed') return;
    if (!ignoreSilent && this.settings.get('silent')) return;
    const volume = this.volume;
    if (volume <= 0) return;
    const start = ctx.currentTime + when;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain * volume, start + attack);
    env.gain.setValueAtTime(gain * volume, start + Math.max(attack, duration - release));
    env.gain.linearRampToValueAtTime(0, start + duration);
    env.connect(this.master);
    for (const f of [].concat(freqs)) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f, start);
      osc.connect(env);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    }
  }

  noise({ duration = 0.08, gain = 0.3, when = 0 } = {}) {
    const ctx = this.#context();
    if (!ctx || this.settings.get('silent')) return;
    const length = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain * this.volume;
    src.connect(g).connect(this.master);
    src.start(ctx.currentTime + when);
  }

  click() {
    if (this.#uiAllowed()) this.tone(1800, { duration: 0.02, type: 'square', gain: 0.04, release: 0.015 });
  }

  lock() {
    if (!this.#uiAllowed()) return;
    this.tone(1400, { duration: 0.04, type: 'triangle', gain: 0.18 });
    this.tone(700, { duration: 0.06, type: 'triangle', gain: 0.15, when: 0.03 });
  }

  unlock() {
    if (this.#uiAllowed()) this.tone([880, 1320], { duration: 0.09, type: 'sine', gain: 0.08 });
  }

  notify() {
    if (this.settings.get('silent')) return;
    this.tone(1046.5, { duration: 0.14, gain: 0.18 });
    this.tone(1568, { duration: 0.22, gain: 0.16, when: 0.12 });
  }

  sent() {
    if (this.#uiAllowed()) this.tone([1318.5, 1760], { duration: 0.12, gain: 0.1, type: 'sine' });
  }

  shutter() {
    this.noise({ duration: 0.05, gain: 0.35 });
    this.noise({ duration: 0.07, gain: 0.25, when: 0.08 });
  }

  dtmf(key) {
    const pair = DTMF[key];
    if (pair) this.tone(pair, { duration: 0.16, gain: 0.12 });
  }

  charge() {
    if (!this.#uiAllowed()) return;
    this.tone(660, { duration: 0.1, gain: 0.12 });
    this.tone(990, { duration: 0.16, gain: 0.12, when: 0.1 });
  }

  volumeTick() {
    this.tone(900, { duration: 0.05, gain: 0.12, type: 'sine' });
  }

  /** Boucle sonore (sonnerie, réveil) jusqu'à `stopLoop(name)`. */
  startLoop(name) {
    this.stopLoop(name);
    this.setPlaybackSession(`loop:${name}`, true);
    const patterns = {
      ring: { every: 2600, play: () => [0, 0.2, 0.4, 0.6].forEach((t, i) => this.tone(i % 2 ? 1318.5 : 1568, { duration: 0.18, gain: 0.22, when: t, ignoreSilent: false })) },
      alarm: { every: 1100, play: () => [0, 0.18, 0.36].forEach((t) => this.tone([880, 1760], { duration: 0.12, gain: 0.22, type: 'triangle', when: t, ignoreSilent: true })) },
      ringback: { every: 3000, play: () => this.tone([440, 480], { duration: 1.2, gain: 0.06, ignoreSilent: true }) },
    };
    const pattern = patterns[name];
    if (!pattern) return;
    pattern.play();
    this.loops.set(name, setInterval(pattern.play, pattern.every));
  }

  stopLoop(name) {
    clearInterval(this.loops.get(name));
    this.loops.delete(name);
    this.setPlaybackSession(`loop:${name}`, false);
  }

  stopAll() {
    for (const name of [...this.loops.keys()]) this.stopLoop(name);
  }
}
