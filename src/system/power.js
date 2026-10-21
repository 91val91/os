/**
 * Alimentation : écran de démarrage, menu marche/arrêt, extinction,
 * redémarrage, mise en veille de l'écran et HUD du volume.
 */
import { h, animate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

export function logo(size = 72) {
  const template = document.createElement('template');
  template.innerHTML = `<svg class="orion-logo" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <defs><linearGradient id="orion-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset=".5" stop-color="#818cf8"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs>
    <circle cx="50" cy="50" r="30" fill="none" stroke="url(#orion-g)" stroke-width="7"/>
    <ellipse cx="50" cy="50" rx="46" ry="15" fill="none" stroke="url(#orion-g)" stroke-width="3" transform="rotate(-28 50 50)" opacity=".85"/>
    <circle cx="86" cy="32" r="5" fill="#f9fafb"/></svg>`;
  return template.content.firstElementChild;
}

export class PowerManager {
  constructor(ui) {
    this.ui = ui;
  }

  showBoot() {
    const layer = this.ui.layers.boot;
    this.progress = h('div.boot-progress-bar');
    layer.replaceChildren(h('div.boot-content', logo(84), h('div.boot-name', 'Orion OS'), h('div.boot-progress', this.progress)));
    layer.classList.add('visible');
  }

  setBootProgress(p) {
    if (this.progress) this.progress.style.width = `${Math.round(p * 100)}%`;
  }

  async hideBoot() {
    const layer = this.ui.layers.boot;
    await animate(layer, [{ opacity: 1 }, { opacity: 0 }], { duration: 450, fill: 'forwards' });
    layer.classList.remove('visible');
    layer.getAnimations?.().forEach((a) => a.cancel());
    layer.replaceChildren();
  }

  /** Menu marche/arrêt (appui long sur le bouton latéral). */
  async showMenu() {
    if (this.menuOpen) return;
    this.menuOpen = true;
    const layer = this.ui.layers.dialogs;
    const close = () => {
      this.menuOpen = false;
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 220);
      this.ui.powerMenuClose = null;
    };
    const option = (name, label, action, cls = '') =>
      h(`button.power-option${cls}`, { type: 'button', onclick: (e) => { e.stopPropagation(); close(); action(); } }, h('span.power-icon', icon(name, { size: 26 })), h('span', label));
    const overlay = h(
      'div.power-overlay',
      { onclick: close },
      h(
        'div.power-menu',
        option('power', 'Éteindre', () => this.shutdown(), '.danger'),
        option('restart', 'Redémarrer', () => this.reboot()),
        option('lock', 'Verrouiller', () => this.ui.lockNow()),
        option('phone-fill', 'Urgence', () => this.ui.emergencyCall(), '.emergency'),
      ),
    );
    layer.append(overlay);
    this.ui.powerMenuClose = close;
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  async #blackout(message) {
    const ui = this.ui;
    ui.sound.stopAll();
    const off = ui.layers.off;
    off.replaceChildren(h('div.shutdown', h('div.spinner.light'), h('span', message)));
    off.classList.add('visible', 'shutting');
    await animate(off, [{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'forwards' });
    ui.kernel.shutdown();
    await new Promise((r) => setTimeout(r, 1200));
  }

  async shutdown() {
    await this.#blackout('Extinction…');
    const off = this.ui.layers.off;
    off.classList.remove('shutting');
    off.replaceChildren(h('div.power-off-hint', icon('power', { size: 22 }), h('span', document.body.classList.contains('fullscreen') ? 'Touchez l\'écran pour allumer' : 'Appuyez sur le bouton latéral pour allumer')));
    this.ui.state = 'off';
    this.ui.poweredOff = true;
  }

  async reboot() {
    await this.#blackout('Redémarrage…');
    location.reload();
  }

  /** Rallume après une extinction : redémarrage complet. */
  powerOn() {
    location.reload();
  }

  // ───────────── HUD volume ─────────────

  showVolume(value) {
    const layer = this.ui.layers.hud;
    if (!this.hud) {
      this.hudFill = h('div.hud-fill');
      this.hudIcon = h('div.hud-icon');
      this.hud = h('div.hud-volume', this.hudFill, this.hudIcon);
      layer.append(this.hud);
    }
    this.hudFill.style.height = `${Math.round(value * 100)}%`;
    this.hudIcon.replaceChildren(icon(value === 0 ? 'volume-x' : value < 0.5 ? 'volume-low' : 'volume', { size: 16 }));
    this.hud.classList.add('visible');
    clearTimeout(this.hudTimer);
    this.hudTimer = setTimeout(() => this.hud.classList.remove('visible'), 1400);
  }
}
