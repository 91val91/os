/**
 * Bannières de notification (« heads-up ») qui descendent du haut de l'écran.
 */
import { h, animate } from '../lib/dom.js';
import { drag } from '../lib/gesture.js';
import { relativeTime } from '../lib/format.js';
import { appIcon } from './app-icon.js';

export class Banners {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.banners;
    this.queue = [];
    this.current = null;
  }

  start() {
    this.k.events.on('notification:post', (n) => this.#onPost(n));
    this.k.events.on('notification:dismiss', ({ id }) => {
      if (this.current?.n.id === id) this.#hide();
      this.queue = this.queue.filter((n) => n.id !== id);
    });
  }

  #onPost(n) {
    const ui = this.ui;
    if (!n.silent) {
      if (!this.k.settings.get('dnd')) ui.sound.notify();
      this.k.device.vibrate([30, 60, 30]);
    }
    if (['off', 'boot', 'locked', 'setup'].includes(ui.state)) {
      if (ui.state === 'off' && !this.k.settings.get('dnd')) ui.wakeForNotification?.();
      return;
    }
    if (this.k.settings.get('dnd') || ui.shade.isOpen) return;
    this.queue.push(n);
    if (!this.current) this.#next();
  }

  #next() {
    const n = this.queue.shift();
    if (!n) return;
    const pkg = this.k.packages.get(n.appId) ?? { id: n.appId, name: n.appId, color: ['#8e8e93', '#636366'], icon: 'bell' };
    const el = h(
      'div.banner',
      { role: 'alert' },
      appIcon(pkg, { size: 38 }),
      h('div.banner-text', h('div.banner-head', h('strong', n.title), h('span', relativeTime(n.time, this.k.now()))), n.body ? h('div.banner-body', n.body) : null),
    );
    el.addEventListener('click', () => {
      if (el.dataset.dragged) return;
      this.#hide();
      this.ui.shade.openNotification(n);
    });
    drag(el, {
      onMove: ({ dy }) => {
        el.dataset.dragged = '1';
        el.style.transform = `translateY(${Math.min(dy, dy * 0.2)}px)`;
      },
      onEnd: ({ dy, vy }) => {
        if (dy < -30 || vy < -0.3) this.#hide();
        else if (dy > 60) {
          this.#hide();
          this.ui.shade.open();
        } else el.style.transform = '';
        setTimeout(() => delete el.dataset.dragged, 50);
      },
    });
    this.el.append(el);
    this.current = { n, el, timer: setTimeout(() => this.#hide(), 5000) };
    animate(el, [{ transform: 'translateY(-130%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: this.ui.dur(380), easing: 'cubic-bezier(.2,.9,.3,1.15)' });
  }

  async #hide() {
    const current = this.current;
    if (!current) return;
    this.current = null;
    clearTimeout(current.timer);
    await animate(current.el, [{ transform: current.el.style.transform || 'translateY(0)', opacity: 1 }, { transform: 'translateY(-130%)', opacity: 0 }], { duration: this.ui.dur(260), easing: 'ease-in', fill: 'forwards' });
    current.el.remove();
    this.#next();
  }

  clear() {
    this.queue = [];
    this.#hide();
  }
}
