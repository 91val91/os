/**
 * Gestionnaire de fenêtres : crée une fenêtre par processus, charge le
 * module de l'application, anime les transitions (ouverture depuis l'icône,
 * retour à l'accueil, changement d'app) et gère l'écran des apps récentes.
 */
import { h, animate, loadStyle } from '../lib/dom.js';
import { drag, viewport } from '../lib/gesture.js';
import { icon } from '../lib/icons.js';
import { appIcon } from './app-icon.js';
import { createAppContext } from './app-context.js';

const EASE = 'cubic-bezier(.2,.9,.25,1)';
const CARD_SCALE = 0.64;
const CARD_GAP = 18;

export class WindowManager {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.layer = ui.layers.windows;
    this.recentsLayer = ui.layers.recents;
    this.windows = new Map();
    this.current = null;
    this.z = 1;
    this.inRecents = false;
    this.recentsOrder = [];
    this.scroll = 0;
    this.gesture = null;

    this.k.events.on('process:exit', ({ pid }) => this.#destroy(pid));
    this.k.events.on('process:state', ({ pid, state }) => {
      const win = this.windows.get(pid);
      if (!win?.lifecycle) return;
      if (state === 'background') {
        win.lifecycle.emit('pause');
        win.hooks.onPause?.();
      } else if (state === 'foreground') {
        win.lifecycle.emit('resume');
        win.hooks.onResume?.();
      }
    });
    this.#setupRecentsGestures();
  }

  get size() {
    return { w: this.ui.screen.clientWidth, h: this.ui.screen.clientHeight };
  }

  get currentWindow() {
    return this.windows.get(this.current) ?? null;
  }

  get statusStyle() {
    return this.currentWindow?.statusStyle ?? 'auto';
  }

  setStatusBarStyle(pid, style) {
    const win = this.windows.get(pid);
    if (!win) return;
    win.statusStyle = style;
    if (pid === this.current) this.ui.statusbar.refreshStyle();
  }

  // ───────────── Lancement ─────────────

  async launch(appId, intent = { action: 'main' }, { callerPid = null, origin = null } = {}) {
    const pkg = this.k.packages.get(appId);
    if (!pkg || !this.k.packages.isInstalled(appId)) throw new Error(`Application introuvable : ${appId}`);
    let proc = this.k.processes.getByApp(appId);
    if (proc) {
      const win = this.windows.get(proc.pid);
      if (callerPid) proc.callerPid = callerPid;
      const hasData = intent && (intent.action !== 'main' || intent.data);
      if (hasData) proc.intent = intent;
      await this.focus(proc.pid, { origin });
      if (hasData && win?.ready) {
        win.lifecycle.emit('intent', intent);
        win.hooks.onIntent?.(intent);
      }
      return proc.pid;
    }
    proc = this.k.processes.spawn(appId, { intent, callerPid });
    const win = this.#create(proc, pkg);
    this.windows.set(proc.pid, win);
    this.#boot(win);
    await this.focus(proc.pid, { origin });
    return proc.pid;
  }

  #create(proc, pkg) {
    const splash = h('div.splash', { style: { '--splash': pkg.color?.[1] ?? '#333' } }, appIcon(pkg, { size: 88 }));
    const body = h('div.app-root', { dataset: { app: pkg.id } });
    const el = h('div.window', { dataset: { app: pkg.id, pid: String(proc.pid) } }, body, splash);
    this.layer.append(el);
    return { pid: proc.pid, appId: pkg.id, pkg, el, body, splash, hooks: {}, ready: false, statusStyle: pkg.statusBar ?? 'auto' };
  }

  async #boot(win) {
    const started = performance.now();
    try {
      const module = await win.pkg.load();
      if (module.styles?.length) await Promise.all(module.styles.map((href) => loadStyle(href)));
      if (!this.windows.has(win.pid)) return;
      const proc = this.k.processes.get(win.pid);
      Object.assign(win, createAppContext({ ui: this.ui, proc, pkg: win.pkg }));
      win.hooks = (await module.mount(win.body, win.ctx)) ?? {};
      win.ready = true;
      const elapsed = performance.now() - started;
      this.k.log.info('wm', `${win.appId} prêt en ${Math.round(elapsed)} ms`);
      setTimeout(() => this.#hideSplash(win), Math.max(0, 220 * this.ui.animScale - elapsed));
    } catch (error) {
      this.#crash(win, error);
    }
  }

  #hideSplash(win) {
    animate(win.splash, [{ opacity: 1 }, { opacity: 0 }], { duration: this.ui.dur(180), fill: 'forwards' }).then(() => win.splash.remove());
  }

  async #crash(win, error) {
    console.error(error);
    this.k.log.error(win.appId, error?.stack ?? String(error));
    this.k.processes.kill(win.pid, 'crash');
    const choice = await this.ui.dialogs.alert({
      title: `« ${win.pkg.name} » s'est arrêtée`,
      message: String(error?.message ?? error),
      buttons: [
        { label: 'Fermer', value: 'close', role: 'cancel' },
        { label: 'Réessayer', value: 'retry' },
      ],
    });
    if (choice === 'retry') this.ui.launch(win.appId);
  }

  // ───────────── Premier plan ─────────────

  /** Coordonnées d'un DOMRect dans le repère de l'écran (non mis à l'échelle). */
  #toScreen(rect) {
    const screen = this.ui.screen.getBoundingClientRect();
    const s = viewport.scale || 1;
    return { x: (rect.left - screen.left) / s, y: (rect.top - screen.top) / s, w: rect.width / s, h: rect.height / s };
  }

  /** Transformation qui ramène la fenêtre sur la zone d'une icône. */
  #iconTransform(rect) {
    const { w, h } = this.size;
    const r = this.#toScreen(rect);
    const s = r.w / w;
    const inset = (h - w) / 2;
    return {
      transform: `translate(${r.x}px, ${r.y - inset * s}px) scale(${s})`,
      clipPath: `inset(${inset}px 0px round ${w * 0.23}px)`,
    };
  }

  async focus(pid, { origin = null } = {}) {
    const win = this.windows.get(pid);
    if (!win) return;
    if (this.inRecents) return this.exitRecents(pid);
    const previous = this.current !== pid ? this.currentWindow : null;
    this.current = pid;
    this.k.processes.setForeground(pid);
    win.el.getAnimations?.().forEach((a) => a.cancel());
    win.el.style.zIndex = String(++this.z);
    win.el.style.transform = '';
    win.el.style.clipPath = '';
    win.el.classList.add('visible');
    this.ui.setState('app');
    const d = this.ui.animScale;
    if (origin && d > 0) {
      const from = this.#iconTransform(origin);
      await animate(win.el, [from, { transform: 'translate(0px, 0px) scale(1)', clipPath: `inset(0px 0px round ${this.ui.screenRadius}px)` }], { duration: 420 * d, easing: EASE });
    } else if (previous && d > 0) {
      await animate(win.el, [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], { duration: 320 * d, easing: EASE });
    } else if (d > 0 && !previous) {
      await animate(win.el, [{ opacity: 0, transform: 'translate(5%, 5%) scale(.9)' }, { opacity: 1, transform: 'translate(0, 0) scale(1)' }], { duration: 260 * d, easing: EASE });
    }
    if (previous && this.current === pid && previous.pid !== pid) this.#hide(previous);
  }

  #hide(win) {
    win.el.classList.remove('visible');
    win.el.style.transform = '';
    win.el.style.clipPath = '';
  }

  /** Renvoie l'app au premier plan en arrière-plan et révèle l'accueil. */
  async minimize({ animated = true } = {}) {
    const win = this.currentWindow;
    this.current = null;
    this.k.processes.backgroundAll();
    if (!win) return;
    const rect = this.ui.home.iconRect(win.appId);
    const d = this.ui.animScale;
    const from = { transform: getComputedStyle(win.el).transform === 'none' ? 'translate(0px, 0px) scale(1)' : getComputedStyle(win.el).transform, clipPath: `inset(0px 0px round ${this.ui.screenRadius}px)`, opacity: 1 };
    win.el.style.transition = '';
    if (animated && d > 0) {
      if (rect) {
        await animate(win.el, [from, { ...this.#iconTransform(rect), opacity: 1 }], { duration: 380 * d, easing: EASE });
      } else {
        await animate(win.el, [from, { transform: `translate(${this.size.w * 0.3}px, ${this.size.h * 0.35}px) scale(.4)`, opacity: 0, clipPath: from.clipPath }], { duration: 300 * d, easing: EASE });
      }
    }
    if (this.current !== win.pid) this.#hide(win);
  }

  /** Ferme (tue) une application. */
  async close(pid) {
    const win = this.windows.get(pid);
    if (!win) return;
    if (pid === this.current) {
      await this.minimize();
      this.ui.setState('home');
    }
    this.k.processes.kill(pid, 'close');
  }

  #destroy(pid) {
    const win = this.windows.get(pid);
    if (!win) return;
    this.windows.delete(pid);
    try {
      win.hooks.onDestroy?.();
    } catch (error) {
      this.k.log.error(win.appId, String(error));
    }
    win.dispose?.();
    win.el.remove();
    if (this.inRecents) {
      this.recentsOrder = this.recentsOrder.filter((p) => p !== pid);
      this.headers?.get(pid)?.remove();
      this.headers?.delete(pid);
      this.scroll = Math.min(this.scroll, Math.max(0, this.recentsOrder.length - 1));
      this.#layoutRecents(true);
      this.#updateRecentsChrome();
    }
    if (this.current === pid) {
      this.current = null;
      queueMicrotask(() => {
        if (this.current == null && !this.inRecents && this.ui.state === 'app') this.ui.setState('home');
      });
    }
  }

  async back() {
    const win = this.currentWindow;
    if (!win) return false;
    if (win.runBack && (await win.runBack())) return true;
    if (win.hooks.onBack && (await win.hooks.onBack())) return true;
    const proc = this.k.processes.get(win.pid);
    if (proc?.callerPid && this.k.processes.get(proc.callerPid)) {
      this.k.am.finish(win.pid, null);
      return true;
    }
    await this.ui.goHome();
    return true;
  }

  /** Bascule vers l'app précédente (glissement horizontal sur la barre). */
  async switchApp(direction) {
    const list = this.k.processes.list().filter((p) => this.windows.has(p.pid));
    if (list.length < 2) return false;
    const target = direction === 'previous' ? list[1] : list.at(-1);
    if (!target || target.pid === this.current) return false;
    const previous = this.currentWindow;
    const win = this.windows.get(target.pid);
    this.current = target.pid;
    this.k.processes.setForeground(target.pid);
    win.el.style.zIndex = String(++this.z);
    win.el.classList.add('visible');
    const d = this.ui.animScale;
    const sign = direction === 'previous' ? -1 : 1;
    await Promise.all([
      animate(win.el, [{ transform: `translateX(${sign * -100}%)` }, { transform: 'translateX(0)' }], { duration: 320 * d, easing: EASE }),
      previous ? animate(previous.el, [{ transform: 'translateX(0)' }, { transform: `translateX(${sign * 100}%)` }], { duration: 320 * d, easing: EASE }) : null,
    ]);
    if (previous && previous.pid !== this.current) this.#hide(previous);
    this.ui.setState('app');
    return true;
  }

  // ───────────── Geste « accueil » piloté au doigt ─────────────

  gestureStart() {
    const win = this.currentWindow;
    if (!win) return false;
    win.el.getAnimations?.().forEach((a) => a.cancel());
    win.el.style.transition = 'none';
    win.el.classList.add('gesturing');
    this.gesture = { win };
    return true;
  }

  gestureMove(dx, dy) {
    if (!this.gesture) return 0;
    const { w, h } = this.size;
    const progress = Math.min(1, Math.max(0, -dy / (h * 0.7)));
    const s = 1 - progress * 0.6;
    const tx = w / 2 + dx * 0.7 - (w * s) / 2;
    const ty = h / 2 + Math.min(0, dy) * 0.55 - (h * s) / 2 + Math.max(0, dy) * 0.2;
    const el = this.gesture.win.el;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    el.style.clipPath = `inset(0px round ${this.ui.screenRadius + progress * 40}px)`;
    return progress;
  }

  async gestureEnd(action) {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const { win } = g;
    win.el.classList.remove('gesturing');
    if (action === 'cancel') {
      const d = this.ui.animScale;
      await animate(win.el, [{ transform: win.el.style.transform, clipPath: win.el.style.clipPath }, { transform: 'translate(0px, 0px) scale(1)', clipPath: `inset(0px round ${this.ui.screenRadius}px)` }], { duration: 280 * d, easing: EASE });
      win.el.style.transform = '';
      win.el.style.clipPath = '';
      win.el.style.transition = '';
    } else if (action === 'recents') {
      win.el.style.transition = '';
      this.showRecents();
    } else {
      win.el.style.transition = '';
      await this.ui.goHome();
      win.el.style.transform = '';
      win.el.style.clipPath = '';
    }
  }

  // ───────────── Apps récentes ─────────────

  showRecents() {
    if (this.inRecents) return;
    const order = this.k.processes
      .list()
      .filter((p) => this.windows.has(p.pid))
      .reverse()
      .map((p) => p.pid);
    this.inRecents = true;
    this.recentsFrom = this.current;
    this.current = null;
    this.k.processes.backgroundAll();
    this.recentsOrder = order;
    this.scroll = Math.max(0, order.length - 1);
    if (this.recentsFrom == null && order.length > 1) this.scroll = order.length - 1;
    this.ui.setState('recents');
    this.#buildRecentsChrome();
    for (const pid of order) {
      const win = this.windows.get(pid);
      win.el.getAnimations?.().forEach((a) => a.cancel());
      if (!win.el.classList.contains('visible')) {
        // Fenêtres masquées : elles apparaissent depuis le bas.
        const g = this.#geometry(order.indexOf(pid));
        win.el.style.transition = 'none';
        win.el.style.transform = `translate(${g.x}px, ${g.y + 120}px) scale(${g.s})`;
        win.el.style.opacity = '0';
      }
      win.el.classList.add('visible', 'in-recents');
    }
    void this.layer.offsetWidth; // force le recalcul avant la transition
    this.#layoutRecents(true);
  }

  #geometry(index) {
    const { w, h } = this.size;
    const s = CARD_SCALE;
    const cw = w * s;
    const ch = h * s;
    return { x: (w - cw) / 2 + (index - this.scroll) * (cw + CARD_GAP), y: (h - ch) / 2 - 8, s, cw, ch };
  }

  #layoutRecents(animated) {
    const d = this.ui.animScale;
    this.recentsOrder.forEach((pid, i) => {
      const win = this.windows.get(pid);
      if (!win) return;
      const g = this.#geometry(i);
      const lift = win.dismissY ?? 0;
      win.el.style.transition = animated ? `transform ${340 * d}ms ${EASE}, opacity ${300 * d}ms, clip-path ${300 * d}ms` : 'none';
      win.el.style.transform = `translate(${g.x}px, ${g.y + lift}px) scale(${g.s})`;
      win.el.style.clipPath = `inset(0px round 44px)`;
      win.el.style.opacity = String(Math.max(0, 1 + lift / (this.size.h * 0.6)));
      win.el.style.zIndex = String(1000 + i);
      const header = this.headers?.get(pid);
      if (header) {
        header.style.transition = win.el.style.transition;
        header.style.width = `${g.cw}px`;
        header.style.transform = `translate(${g.x}px, ${g.y - 42 + lift}px)`;
        header.style.opacity = win.el.style.opacity;
      }
    });
  }

  #buildRecentsChrome() {
    this.headers = new Map();
    const layer = this.recentsLayer;
    layer.replaceChildren();
    for (const pid of this.recentsOrder) {
      const win = this.windows.get(pid);
      const header = h('div.recents-header', appIcon(win.pkg, { size: 28 }), h('span', win.pkg.name));
      this.headers.set(pid, header);
      layer.append(header);
    }
    this.emptyLabel = h('div.recents-empty', 'Aucune application récente');
    this.clearButton = h('button.recents-clear', { type: 'button', onclick: (e) => { e.stopPropagation(); this.closeAll(); } }, icon('close', { size: 16 }), 'Tout effacer');
    layer.append(this.emptyLabel, this.clearButton);
    layer.classList.add('active');
    this.#updateRecentsChrome();
  }

  #updateRecentsChrome() {
    const empty = this.recentsOrder.length === 0;
    this.emptyLabel?.classList.toggle('visible', empty);
    this.clearButton?.classList.toggle('visible', !empty);
  }

  #cardAt(clientX, clientY) {
    const screen = this.ui.screen.getBoundingClientRect();
    const s = viewport.scale || 1;
    const x = (clientX - screen.left) / s;
    const y = (clientY - screen.top) / s;
    for (let i = 0; i < this.recentsOrder.length; i++) {
      const g = this.#geometry(i);
      if (x >= g.x && x <= g.x + g.cw && y >= g.y - 44 && y <= g.y + g.ch) return this.recentsOrder[i];
    }
    return null;
  }

  #setupRecentsGestures() {
    const layer = this.recentsLayer;
    let mode = null;
    let base = 0;
    let target = null;
    drag(layer, {
      filter: () => this.inRecents,
      onStart: ({ axis, dy, event }) => {
        this.recentsDragged = true;
        if (axis === 'x') {
          mode = 'scroll';
          base = this.scroll;
        } else if (dy < 0) {
          target = this.#cardAt(event.clientX, event.clientY);
          mode = target ? 'dismiss' : null;
        } else {
          mode = null;
        }
      },
      onMove: ({ dx, dy }) => {
        if (mode === 'scroll') {
          const { cw } = this.#geometry(0);
          let next = base - dx / (cw + CARD_GAP);
          const max = Math.max(0, this.recentsOrder.length - 1);
          if (next < 0) next *= 0.35;
          if (next > max) next = max + (next - max) * 0.35;
          this.scroll = next;
          this.#layoutRecents(false);
        } else if (mode === 'dismiss') {
          const win = this.windows.get(target);
          if (win) win.dismissY = Math.min(0, dy);
          this.#layoutRecents(false);
        }
      },
      onEnd: ({ vx, dy, vy }) => {
        if (mode === 'scroll') {
          const max = Math.max(0, this.recentsOrder.length - 1);
          this.scroll = Math.min(max, Math.max(0, Math.round(this.scroll - vx * 2.2)));
          this.#layoutRecents(true);
        } else if (mode === 'dismiss') {
          const win = this.windows.get(target);
          if (win && (dy < -this.size.h * 0.18 || vy < -0.6)) {
            win.dismissY = -this.size.h;
            this.#layoutRecents(true);
            const pid = target;
            setTimeout(() => this.k.processes.kill(pid, 'recents'), 220 * this.ui.animScale);
          } else if (win) {
            win.dismissY = 0;
            this.#layoutRecents(true);
          }
        }
        mode = null;
        target = null;
      },
    });
    layer.addEventListener('click', (e) => {
      if (!this.inRecents) return;
      if (this.recentsDragged) {
        this.recentsDragged = false;
        return;
      }
      const pid = this.#cardAt(e.clientX, e.clientY);
      if (pid) this.exitRecents(pid);
      else this.ui.goHome();
    });
    layer.addEventListener('pointerdown', () => (this.recentsDragged = false));
  }

  #cleanupRecents() {
    this.inRecents = false;
    this.recentsLayer.classList.remove('active');
    this.recentsLayer.replaceChildren();
    this.headers = null;
    for (const win of this.windows.values()) {
      win.el.classList.remove('in-recents');
      win.el.style.transition = '';
      win.el.style.opacity = '';
      win.el.style.clipPath = '';
      win.dismissY = 0;
    }
  }

  async exitRecents(pid) {
    const win = this.windows.get(pid);
    if (!win) return;
    const index = this.recentsOrder.indexOf(pid);
    this.scroll = index;
    this.#layoutRecents(true);
    const d = this.ui.animScale;
    win.el.style.zIndex = String(++this.z + 2000);
    win.el.style.transition = `transform ${300 * d}ms ${EASE}, clip-path ${300 * d}ms`;
    win.el.style.transform = 'translate(0px, 0px) scale(1)';
    win.el.style.clipPath = `inset(0px round ${this.ui.screenRadius}px)`;
    this.recentsLayer.classList.remove('active');
    await new Promise((r) => setTimeout(r, 320 * d));
    const others = this.recentsOrder.filter((p) => p !== pid);
    this.#cleanupRecents();
    for (const other of others) {
      const w = this.windows.get(other);
      if (w) this.#hide(w);
    }
    win.el.style.transform = '';
    win.el.style.zIndex = String(++this.z);
    this.current = pid;
    this.k.processes.setForeground(pid);
    this.ui.setState('app');
  }

  /** Quitte l'écran des récentes vers l'accueil. */
  async closeRecents() {
    if (!this.inRecents) return;
    const d = this.ui.animScale;
    for (const pid of this.recentsOrder) {
      const win = this.windows.get(pid);
      if (!win) continue;
      win.el.style.transition = `transform ${260 * d}ms ease-in, opacity ${260 * d}ms`;
      win.el.style.transform += ' translateY(160px)';
      win.el.style.opacity = '0';
    }
    this.recentsLayer.classList.remove('active');
    await new Promise((r) => setTimeout(r, 260 * d));
    const order = this.recentsOrder;
    this.#cleanupRecents();
    for (const pid of order) {
      const win = this.windows.get(pid);
      if (win) this.#hide(win);
    }
  }

  closeAll() {
    const pids = [...this.recentsOrder];
    pids.forEach((pid, i) => {
      const win = this.windows.get(pid);
      if (win) win.dismissY = -this.size.h;
      setTimeout(() => this.k.processes.kill(pid, 'recents'), 60 * i);
    });
    this.#layoutRecents(true);
    setTimeout(() => this.ui.goHome(), 250 + pids.length * 60);
  }

  killAll() {
    for (const pid of [...this.windows.keys()]) this.k.processes.kill(pid, 'shutdown');
  }
}
