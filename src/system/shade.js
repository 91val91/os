/**
 * Volet de notifications (inspiré d'Android) : réglages rapides,
 * luminosité et liste des notifications.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { drag } from '../lib/gesture.js';
import { formatDate, formatTime, relativeTime } from '../lib/format.js';
import { slider, avatar } from '../lib/ui.js';
import { appIcon } from './app-icon.js';
import { PullPanel } from './pull-panel.js';
import { quickTiles } from './quick-settings.js';

const TILE_ORDER = ['wifi', 'cellular', 'bluetooth', 'airplane', 'dnd', 'flashlight', 'rotation', 'saver', 'dark', 'location', 'silent'];

export class NotificationShade extends PullPanel {
  constructor(ui) {
    super(ui, ui.layers.shade, { travel: 460 });
    this.k = ui.kernel;
    this.tiles = quickTiles(ui);
    this.expanded = false;
  }

  start() {
    const k = this.k;
    this.clock = h('div.shade-clock');
    this.date = h('div.shade-date');
    this.tileGrid = h('div.qs-grid');
    this.brightness = slider({ min: 0.15, max: 1, step: 0.01, value: k.settings.get('brightness'), iconLeft: 'sun', onInput: (v) => k.settings.set('brightness', v), label: 'Luminosité' });
    this.list = h('div.shade-list');
    this.empty = h('div.shade-empty', icon('bell', { size: 30, stroke: 1.6 }), h('span', 'Aucune notification'));
    // Compte connecté : changer d'utilisateur ou gérer les comptes.
    this.userBtn = h('button.round-btn.shade-user', { type: 'button', 'aria-label': 'Utilisateurs', hidden: !k.accounts, onclick: () => { this.close(); this.ui.showAccountPicker({ manage: true }); } });
    this.renderUser();
    k.events.on('account:change', () => this.renderUser());
    this.clearBtn = h('button.shade-clear', { type: 'button', onclick: () => k.notifications.clear() }, 'Tout effacer');
    const head = h(
      'div.shade-head',
      h('div', this.clock, this.date),
      h(
        'div.shade-actions',
        this.userBtn,
        h('button.round-btn', { type: 'button', 'aria-label': 'Éteindre', onclick: () => { this.close(); this.ui.power.showMenu(); } }, icon('power', { size: 18 })),
        h('button.round-btn', { type: 'button', 'aria-label': 'Réglages', onclick: () => { this.close(); this.ui.launch('settings'); } }, icon('settings', { size: 18 })),
      ),
    );
    this.top = h('div.shade-top', head, this.tileGrid, h('div.qs-brightness', this.brightness), h('button.shade-expand', { type: 'button', 'aria-label': 'Développer', onclick: () => this.toggleExpanded() }, icon('chevron-down', { size: 20 })));
    this.handle = h('div.shade-handle', h('span'));
    this.el.replaceChildren(h('div.shade-panel', this.top, h('div.shade-scroll', this.list, this.empty, this.clearBtn), this.handle));
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.enableSwipeToClose(this.top);
    this.enableSwipeToClose(this.handle);

    for (const type of ['notification:post', 'notification:dismiss', 'notification:read']) k.events.on(type, () => this.isVisible && this.renderList());
    k.events.on('settings:change', () => this.isVisible && this.renderTiles());
    k.settings.watch('brightness', (v) => this.brightness.set(v));
  }

  get isVisible() {
    return this.el.classList.contains('visible');
  }

  renderUser() {
    const account = this.k.account;
    if (account) this.userBtn.replaceChildren(avatar(account.name || '?', { size: 34, color: account.color, photo: account.photo }));
  }

  onBeforeOpen() {
    this.renderHeader();
    this.renderTiles();
    this.renderList();
  }

  onOpen() {
    this.k.notifications.markAllRead();
  }

  toggleExpanded() {
    this.expanded = !this.expanded;
    this.el.classList.toggle('expanded', this.expanded);
    this.renderTiles();
  }

  renderHeader() {
    const now = this.k.now();
    this.clock.textContent = formatTime(now, this.k.settings.get('use24h'));
    this.date.textContent = formatDate(now);
  }

  renderTiles() {
    const ids = this.expanded ? TILE_ORDER : TILE_ORDER.slice(0, 4);
    this.tileGrid.replaceChildren(
      ...ids.map((id) => {
        const tile = this.tiles[id];
        const active = tile.active();
        const el = h(
          `button.qs-tile${active ? '.active' : ''}`,
          { type: 'button', style: tile.color ? { '--tile': tile.color } : null, onclick: () => { tile.toggle(); this.k.device.vibrate(8); this.renderTiles(); } },
          h('span.qs-icon', icon(!active && tile.iconOff ? tile.iconOff : tile.icon, { size: 20 })),
          h('span.qs-text', h('span.qs-label', tile.label), this.expanded && tile.detail ? h('span.qs-detail', tile.detail()) : null),
        );
        return el;
      }),
    );
  }

  renderList() {
    const items = this.k.notifications.list();
    this.empty.classList.toggle('visible', !items.length);
    this.clearBtn.classList.toggle('visible', items.length > 0);
    this.list.replaceChildren(...items.map((n) => this.card(n)));
  }

  card(n, { compact = false, onOpen = null } = {}) {
    const pkg = this.k.packages.get(n.appId) ?? { id: n.appId, name: n.appId, icon: 'bell', color: ['#8e8e93', '#636366'] };
    const el = h(
      'div.notif-card',
      { role: 'button', tabindex: 0 },
      h('div.notif-head', appIcon(pkg, { size: 20 }), h('span.notif-app', pkg.name), h('span.notif-time', relativeTime(n.time, this.k.now()))),
      h('div.notif-title', n.title),
      n.body ? h('div.notif-body', n.body) : null,
    );
    if (compact) el.classList.add('compact');
    el.addEventListener('click', () => {
      if (el.dataset.swiped) return;
      if (onOpen) onOpen(n);
      else this.openNotification(n);
    });
    drag(el, {
      axis: 'x',
      onMove: ({ dx }) => {
        el.dataset.swiped = '1';
        el.style.transition = 'none';
        el.style.transform = `translateX(${dx}px)`;
        el.style.opacity = String(1 - Math.min(1, Math.abs(dx) / 260));
      },
      onEnd: ({ dx, vx }) => {
        el.style.transition = '';
        if (Math.abs(dx) > 110 || Math.abs(vx) > 0.6) {
          el.style.transform = `translateX(${Math.sign(dx || vx) * 120}%)`;
          el.style.opacity = '0';
          setTimeout(() => this.k.notifications.dismiss(n.id), 180);
        } else {
          el.style.transform = '';
          el.style.opacity = '';
        }
        setTimeout(() => delete el.dataset.swiped, 50);
      },
    });
    return el;
  }

  async openNotification(n) {
    this.k.notifications.dismiss(n.id);
    this.close();
    await this.ui.openIntent(n.intent ?? { app: n.appId, action: 'main' }, { appId: n.appId });
  }
}
