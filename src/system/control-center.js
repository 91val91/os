/**
 * Centre de contrôle (inspiré d'iOS) : connectivité, lecture en cours,
 * curseurs verticaux de luminosité et volume, raccourcis.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { drag } from '../lib/gesture.js';
import { PullPanel } from './pull-panel.js';
import { quickTiles } from './quick-settings.js';

export class ControlCenter extends PullPanel {
  constructor(ui) {
    super(ui, ui.layers.controlCenter, { travel: 380 });
    this.k = ui.kernel;
    this.tiles = quickTiles(ui);
  }

  start() {
    this.grid = h('div.cc-grid');
    this.el.replaceChildren(h('div.cc-scroll', this.grid));
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el || e.target.classList.contains('cc-scroll')) this.close();
    });
    this.enableSwipeToClose(this.el, { filter: (e) => !e.target.closest('.cc-slider') });
    this.k.events.on('settings:change', () => this.isOpen && this.render());
    this.k.events.on('media:change', () => this.isOpen && this.renderMedia());
  }

  onBeforeOpen() {
    this.render();
  }

  #round(id) {
    const tile = this.tiles[id];
    const active = tile.active();
    return h(
      `button.cc-round${active ? '.active' : ''}`,
      { type: 'button', title: tile.label, 'aria-label': tile.label, style: tile.color ? { '--tile': tile.color } : null, onclick: (e) => { e.stopPropagation(); tile.toggle(); this.k.device.vibrate(8); this.render(); } },
      icon(!active && tile.iconOff ? tile.iconOff : tile.icon, { size: 22 }),
    );
  }

  #module(className, ...children) {
    return h(`div.cc-module.${className}`, ...children);
  }

  #shortcut(name, label, action, active = false) {
    return h(`button.cc-module.cc-square${active ? '.active' : ''}`, { type: 'button', title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); action(); } }, icon(name, { size: 24 }));
  }

  #vslider(key, iconName, label) {
    const fill = h('div.cc-slider-fill');
    const el = h('div.cc-module.cc-slider', { role: 'slider', 'aria-label': label }, fill, h('span.cc-slider-icon', icon(iconName, { size: 22 })));
    const s = this.k.settings;
    const min = key === 'brightness' ? 0.15 : 0;
    const set = (v) => fill.style.setProperty('--v', String(v));
    set(s.get(key));
    let start = 0;
    drag(el, {
      threshold: 2,
      onStart: () => (start = s.get(key)),
      onMove: ({ dy }) => {
        const height = el.clientHeight || 160;
        const v = Math.min(1, Math.max(min, start - dy / height));
        s.set(key, Math.round(v * 100) / 100);
        set(v);
      },
      onEnd: () => key === 'volume' && this.ui.sound.volumeTick(),
    });
    el.addEventListener('click', (e) => e.stopPropagation());
    return el;
  }

  renderMedia() {
    if (!this.media) return;
    const session = this.k.media.get();
    const art = h('div.cc-art', session?.artwork ? { style: { backgroundImage: `url("${session.artwork}")` } } : null, session?.artwork ? null : icon('music-note', { size: 26 }));
    this.media.replaceChildren(
      h('div.cc-media-top', art, h('div.cc-media-text', h('strong', session?.title || 'Pas de lecture'), h('span', session?.artist || 'Musique'))),
      h(
        'div.cc-media-controls',
        h('button', { type: 'button', 'aria-label': 'Précédent', onclick: (e) => { e.stopPropagation(); this.k.media.command('previous'); } }, icon('previous', { size: 22 })),
        h('button.big', { type: 'button', 'aria-label': 'Lecture', onclick: (e) => { e.stopPropagation(); if (!this.k.media.command('toggle')) this.ui.launch('music'); } }, icon(session?.playing ? 'pause' : 'play', { size: 30 })),
        h('button', { type: 'button', 'aria-label': 'Suivant', onclick: (e) => { e.stopPropagation(); this.k.media.command('next'); } }, icon('next', { size: 22 })),
      ),
    );
  }

  render() {
    const go = (appId, intent) => () => {
      this.close();
      this.ui.openIntent(intent ?? { app: appId, action: 'main' });
    };
    this.media = this.#module('cc-media');
    this.renderMedia();
    const s = this.k.settings;
    this.grid.replaceChildren(
      this.#module('cc-connectivity', this.#round('airplane'), this.#round('cellular'), this.#round('wifi'), this.#round('bluetooth')),
      this.media,
      this.#module('cc-small', this.#round('rotation')),
      this.#module('cc-small', this.#round('silent')),
      this.#vslider('brightness', 'sun', 'Luminosité'),
      this.#vslider('volume', s.get('volume') > 0 ? 'volume' : 'volume-x', 'Volume'),
      h(
        `button.cc-module.cc-wide${s.get('dnd') ? '.active-dnd' : ''}`,
        { type: 'button', onclick: (e) => { e.stopPropagation(); this.tiles.dnd.toggle(); this.render(); } },
        h('span.cc-wide-icon', icon('moon-fill', { size: 20 })),
        h('span', h('strong', 'Concentration'), h('small', s.get('dnd') ? 'Ne pas déranger' : 'Désactivée')),
      ),
      this.#shortcut('flashlight', 'Lampe torche', () => { this.tiles.flashlight.toggle(); this.render(); }, s.get('flashlight')),
      this.#shortcut('timer', 'Minuteur', go('clock', { app: 'clock', action: 'view', data: { tab: 'timer' } })),
      this.#shortcut('calculator', 'Calculatrice', go('calculator')),
      this.#shortcut('camera', 'Appareil photo', go('camera')),
      this.#shortcut('contrast', 'Mode sombre', () => { this.tiles.dark.toggle(); this.render(); }, this.ui.theme.resolved === 'dark'),
      this.#shortcut('leaf', 'Économie d\'énergie', () => { this.tiles.saver.toggle(); this.render(); }, s.get('batterySaver')),
      this.#shortcut('lock', 'Verrouiller', () => { this.close(); this.ui.lockNow(); }),
      this.#shortcut('settings', 'Réglages', go('settings')),
    );
  }
}
