/**
 * Navigation système :
 *  - mode « gestes » (iOS / Android 10+) : barre d'accueil en bas
 *    (glisser = accueil, glisser et maintenir = récentes, glisser
 *    latéralement = app précédente) et bords gauche/droit pour « Retour » ;
 *  - mode « boutons » (Android classique) : Retour, Accueil, Récentes.
 * Gère aussi le tirage de la barre d'état (volet / centre de contrôle).
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { drag, viewport } from '../lib/gesture.js';

export class Navigation {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.navbar;
  }

  start() {
    this.k.settings.watch('navigation', () => this.render());
    this.#setupEdges();
    this.#setupStatusPull();
    this.render();
  }

  get mode() {
    return this.k.settings.get('navigation') === 'buttons' ? 'buttons' : 'gestures';
  }

  render() {
    const mode = this.mode;
    this.ui.screen.dataset.nav = mode;
    if (mode === 'buttons') {
      const btn = (name, label, action) =>
        h('button.nav-btn', { type: 'button', 'aria-label': label, title: label, onclick: () => { this.k.device.vibrate(8); action(); } }, icon(name, { size: 20, stroke: 2.2 }));
      this.el.replaceChildren(
        h(
          'div.nav-buttons',
          btn('nav-back', 'Retour', () => this.ui.back()),
          btn('nav-home', 'Accueil', () => this.ui.goHome()),
          btn('nav-recents', 'Récentes', () => this.ui.toggleRecents()),
        ),
      );
    } else {
      const zone = h('div.nav-gesture', h('div.home-indicator'));
      this.el.replaceChildren(zone);
      this.#setupBar(zone);
    }
  }

  #screenX(clientX) {
    const rect = this.ui.screen.getBoundingClientRect();
    return (clientX - rect.left) / (viewport.scale || 1);
  }

  #setupBar(zone) {
    const ui = this.ui;
    let mode = null;
    let holdTimer = null;
    let held = false;
    let last = null;

    const arm = () => {
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        held = true;
        this.k.device.vibrate(10);
        zone.classList.add('held');
      }, 260);
    };

    drag(zone, {
      threshold: 6,
      filter: () => ['app', 'home'].includes(ui.state) && !ui.dialogs.open,
      onStart: ({ axis, dy }) => {
        held = false;
        last = null;
        if (ui.state === 'app') {
          if (axis === 'x') mode = 'switch';
          else mode = dy < 0 && ui.wm.gestureStart() ? 'app' : null;
        } else if (ui.state === 'home') {
          mode = axis === 'y' && dy < 0 ? 'home' : null;
          if (mode) ui.home.exitEditMode();
          if (mode) ui.drawer.dragStart();
        }
      },
      onMove: ({ dx, dy }) => {
        if (!mode || mode === 'switch') return;
        const moved = !last || Math.hypot(dx - last.dx, dy - last.dy) > 4;
        last = { dx, dy };
        if (moved) {
          held = false;
          zone.classList.remove('held');
          if (-dy > 50) arm();
        }
        if (mode === 'app') ui.wm.gestureMove(dx, dy);
        else if (mode === 'home') ui.drawer.dragMove(-dy);
      },
      onEnd: ({ dx, dy, vx, vy }) => {
        clearTimeout(holdTimer);
        zone.classList.remove('held');
        const h = ui.screen.clientHeight;
        if (mode === 'app') {
          const progress = -dy / (h * 0.7);
          if (held && progress > 0.08 && this.k.processes.list().length) ui.wm.gestureEnd('recents');
          else if (progress > 0.1 || vy < -0.5) ui.wm.gestureEnd('home');
          else ui.wm.gestureEnd('cancel');
        } else if (mode === 'switch') {
          if (Math.abs(dx) > 60 || Math.abs(vx) > 0.4) ui.wm.switchApp(dx > 0 ? 'previous' : 'next');
        } else if (mode === 'home') {
          if (held && this.k.processes.list().length) {
            ui.drawer.close(true);
            ui.showRecents();
          } else ui.drawer.dragEnd(-dy, -vy);
        }
        mode = null;
      },
      onCancel: () => {
        clearTimeout(holdTimer);
        if (mode === 'app') ui.wm.gestureEnd('cancel');
        if (mode === 'home') ui.drawer.close();
        mode = null;
      },
    });
  }

  /** Glisser depuis un bord latéral = Retour. */
  #setupEdges() {
    const ui = this.ui;
    const indicator = h('div.back-indicator', icon('chevron-left', { size: 22, stroke: 3 }));
    ui.screen.append(indicator);
    for (const side of ['left', 'right']) {
      const zone = h(`div.edge-zone.${side}`);
      ui.screen.append(zone);
      let armed = false;
      drag(zone, {
        axis: 'x',
        threshold: 4,
        filter: () => ui.state === 'app' && this.mode === 'gestures' && !ui.dialogs.open,
        onStart: ({ event }) => {
          const rect = ui.screen.getBoundingClientRect();
          indicator.style.top = `${(event.clientY - rect.top) / (viewport.scale || 1)}px`;
          indicator.className = `back-indicator visible ${side}`;
          armed = false;
        },
        onMove: ({ dx }) => {
          const distance = side === 'left' ? dx : -dx;
          const progress = Math.min(1, Math.max(0, distance / 90));
          indicator.style.setProperty('--p', String(progress));
          if (progress >= 1 && !armed) {
            armed = true;
            this.k.device.vibrate(8);
          } else if (progress < 1) armed = false;
          indicator.classList.toggle('armed', armed);
        },
        onEnd: () => {
          indicator.className = `back-indicator ${side}`;
          indicator.style.setProperty('--p', '0');
          if (armed) ui.back();
        },
        onCancel: () => {
          indicator.className = `back-indicator ${side}`;
        },
      });
    }
  }

  /** Tirer la barre d'état : gauche = notifications, droite = centre de contrôle. */
  #setupStatusPull() {
    const ui = this.ui;
    let panel = null;
    drag(ui.layers.statusbar, {
      axis: 'y',
      threshold: 6,
      filter: () => !['boot', 'off', 'setup'].includes(ui.state) && !ui.dialogs.open && !ui.shade.isOpen && !ui.controlCenter.isOpen,
      onStart: ({ startX, dy }) => {
        if (dy < 0) {
          panel = null;
          return;
        }
        const ratio = this.#screenX(startX) / ui.screen.clientWidth;
        panel = ratio > 0.62 ? ui.controlCenter : ui.shade;
        panel.dragStart();
      },
      onMove: ({ dy }) => panel?.dragMove(dy),
      onEnd: ({ dy, vy }) => {
        panel?.dragEnd(dy, vy);
        panel = null;
      },
      onCancel: () => {
        panel?.close();
        panel = null;
      },
    });
  }
}
