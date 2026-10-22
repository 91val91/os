/**
 * Écran d'accueil (lanceur) : pages d'icônes, dock, widgets, badges,
 * menu contextuel par appui long et mode édition (glisser-déposer).
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { drag, longPress, viewport } from '../lib/gesture.js';
import { describeWeather } from '../lib/weather-codes.js';
import { appIcon, clockFace, refreshCalendarIcons } from './app-icon.js';

const DEFAULT_LAYOUT = {
  dock: ['phone', 'messages', 'browser', 'camera'],
  pages: [['photos', 'clock', 'calendar', 'weather', 'notes', 'calculator', 'music', 'contacts', 'files', 'store', 'settings']],
  hidden: [],
};
const DOCK_MAX = 4;
const capacity = (index) => (index === 0 ? 16 : 24);

export class HomeScreen {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.home;
    this.page = 0;
    this.editing = false;
    this.dragging = null;
  }

  start() {
    this.layout = this.#loadLayout();
    this.track = h('div.home-pages');
    this.viewportEl = h('div.home-viewport', this.track);
    this.dots = h('div.home-dots');
    this.dock = h('div.home-dock');
    this.searchPill = h('button.home-search', { type: 'button', onclick: () => this.ui.drawer.open({ search: true }) }, icon('search', { size: 14, stroke: 2.4 }), 'Rechercher');
    this.doneBtn = h('button.home-done', { type: 'button', onclick: () => this.exitEditMode() }, 'OK');
    this.el.replaceChildren(this.viewportEl, this.dots, this.searchPill, this.dock, this.doneBtn);
    this.#setupGestures();

    const k = this.k;
    k.events.on('package:install', ({ id }) => {
      this.#place(id);
      this.#save();
      this.render();
    });
    k.events.on('package:uninstall', ({ id }) => {
      this.#remove(id);
      this.layout.hidden = this.layout.hidden.filter((x) => x !== id);
      this.#save();
      this.render();
    });
    for (const type of ['notification:post', 'notification:dismiss', 'sms:received', 'sms:read', 'call:log']) {
      k.events.on(type, () => this.#updateBadges());
    }
    k.fs.watch('/data/weather', () => this.#renderWeather());
    setInterval(() => {
      if (this.dateKey !== new Date().toDateString()) {
        refreshCalendarIcons();
        this.#renderDate();
      }
    }, 30_000);
    this.render();
  }

  // ───────────── Disposition ─────────────

  #loadLayout() {
    const saved = this.k.settings.get('homeLayout');
    const layout = saved?.pages ? structuredClone(saved) : structuredClone(DEFAULT_LAYOUT);
    layout.hidden ??= [];
    const installed = new Set(this.k.packages.list().filter((p) => !p.hidden).map((p) => p.id));
    layout.dock = layout.dock.filter((id) => installed.has(id));
    layout.pages = layout.pages.map((page) => page.filter((id) => installed.has(id)));
    layout.hidden = layout.hidden.filter((id) => installed.has(id));
    if (!layout.pages.length) layout.pages.push([]);
    const placed = new Set([...layout.dock, ...layout.pages.flat(), ...layout.hidden]);
    for (const id of installed) if (!placed.has(id)) this.#place(id, layout);
    this.#normalize(layout);
    return layout;
  }

  #save() {
    this.k.settings.set('homeLayout', structuredClone(this.layout));
  }

  #place(id, layout = this.layout) {
    if ([...layout.dock, ...layout.pages.flat()].includes(id)) return;
    layout.hidden = layout.hidden.filter((x) => x !== id);
    const index = layout.pages.findIndex((p, i) => p.length < capacity(i));
    if (index >= 0) layout.pages[index].push(id);
    else layout.pages.push([id]);
  }

  #remove(id, layout = this.layout) {
    layout.dock = layout.dock.filter((x) => x !== id);
    layout.pages = layout.pages.map((p) => p.filter((x) => x !== id));
    this.#normalize(layout);
  }

  /** Reporte les débordements sur la page suivante et supprime les pages vides. */
  #normalize(layout = this.layout) {
    for (let i = 0; i < layout.pages.length; i++) {
      const extra = layout.pages[i].length - capacity(i);
      if (extra > 0) {
        const moved = layout.pages[i].splice(capacity(i), extra);
        if (!layout.pages[i + 1]) layout.pages.push([]);
        layout.pages[i + 1].unshift(...moved);
      }
    }
    layout.pages = layout.pages.filter((p, i) => i === 0 || p.length || (this.dragging && i === this.page));
    if (layout.dock.length > DOCK_MAX) {
      const extra = layout.dock.splice(DOCK_MAX);
      layout.pages[0].unshift(...extra);
      this.#normalize(layout);
    }
    this.page = Math.min(this.page, layout.pages.length - 1);
  }

  hideFromHome(id) {
    this.#remove(id);
    if (!this.layout.hidden.includes(id)) this.layout.hidden.push(id);
    this.#save();
    this.render();
  }

  addToHome(id) {
    this.#place(id);
    this.#save();
    this.render();
  }

  isOnHome(id) {
    return [...this.layout.dock, ...this.layout.pages.flat()].includes(id);
  }

  // ───────────── Rendu ─────────────

  render() {
    const pages = this.layout.pages.map((ids, index) => {
      const page = h('div.home-page', { dataset: { index: String(index) } });
      if (index === 0) page.append(this.#widgets());
      ids.forEach((id) => page.append(this.#cell(id)));
      return page;
    });
    this.track.replaceChildren(...pages);
    this.dock.replaceChildren(...this.layout.dock.map((id) => this.#cell(id, true)));
    this.dots.replaceChildren(...this.layout.pages.map((_, i) => h(`span${i === this.page ? '.active' : ''}`)));
    this.dots.classList.toggle('hidden', this.layout.pages.length < 2);
    this.#applyPage(false);
    this.#updateBadges();
  }

  #badgeFor(id) {
    const k = this.k;
    if (id === 'messages') return k.telephony.unreadCount();
    return k.notifications.list({ appId: id }).length;
  }

  #updateBadges() {
    for (const cell of this.el.querySelectorAll('.home-app')) {
      const count = this.#badgeFor(cell.dataset.app);
      const iconEl = cell.querySelector('.app-icon');
      let badge = iconEl.querySelector('.icon-badge');
      if (!count) badge?.remove();
      else {
        badge ??= iconEl.appendChild(h('span.icon-badge'));
        badge.textContent = count > 99 ? '99+' : String(count);
      }
    }
  }

  #cell(id, inDock = false) {
    const pkg = this.k.packages.get(id);
    const iconEl = appIcon(pkg, { size: 'var(--icon-size)' });
    const cell = h(
      'div.home-app',
      { dataset: { app: id }, role: 'button', tabindex: 0, 'aria-label': pkg.name },
      h('button.remove-badge', { type: 'button', 'aria-label': `Retirer ${pkg.name}`, onclick: (e) => { e.stopPropagation(); this.#askRemove(id); } }, icon('minus', { size: 14, stroke: 3 })),
      iconEl,
      inDock ? null : h('span.home-label', pkg.name),
    );
    if (this.dragging?.id === id) cell.classList.add('placeholder');
    cell.addEventListener('click', () => {
      if (this.editing || this.justDragged) return;
      this.k.device.vibrate(6);
      this.ui.launch(id, { action: 'main' }, { origin: iconEl.getBoundingClientRect() });
    });
    cell.addEventListener('keydown', (e) => e.key === 'Enter' && cell.click());
    longPress(cell, () => {
      if (this.editing) return;
      this.k.device.vibrate(15);
      this.#contextMenu(cell, id);
    });
    cell.addEventListener('pointerdown', (e) => this.#maybeStartDrag(e, cell, id));
    return cell;
  }

  #widgets() {
    this.clockWidget = h(
      'button.widget.widget-clock',
      { type: 'button', onclick: () => !this.editing && this.ui.launch('clock') },
      h('div.widget-face', clockFace({ size: '100%' })),
    );
    this.weatherWidget = h('button.widget.widget-weather', { type: 'button', onclick: () => !this.editing && this.ui.launch('weather') });
    this.#renderWeather();
    this.#renderDate();
    return h('div.home-widgets', this.clockWidget, this.weatherWidget);
  }

  #renderDate() {
    this.dateKey = new Date().toDateString();
  }

  #renderWeather() {
    if (!this.weatherWidget) return;
    const data = this.k.fs.readJSON('/data/weather/storage.json', {})?.cache;
    if (!data) {
      this.weatherWidget.replaceChildren(
        h('div.ww-city', 'Météo'),
        h('div.ww-temp', '--°'),
        h('div.ww-icon', icon('cloud-sun', { size: 28 })),
        h('div.ww-desc', 'Touchez pour charger'),
      );
      return;
    }
    const d = describeWeather(data.code, data.isDay);
    this.weatherWidget.classList.toggle('night', !data.isDay);
    this.weatherWidget.replaceChildren(
      h('div.ww-city', data.city, data.located ? icon('location-fill', { size: 10 }) : null),
      h('div.ww-temp', `${Math.round(data.temp)}°`),
      h('div.ww-icon', icon(d.icon, { size: 26 })),
      h('div.ww-desc', d.label),
      h('div.ww-range', `H:${Math.round(data.max)}°  B:${Math.round(data.min)}°`),
    );
  }

  #applyPage(animated = true) {
    this.track.style.transition = animated ? `transform ${this.ui.dur(380)}ms cubic-bezier(.2,.9,.3,1)` : 'none';
    this.track.style.transform = `translateX(${-this.page * 100}%)`;
    [...this.dots.children].forEach((d, i) => d.classList.toggle('active', i === this.page));
  }

  setPage(index, animated = true) {
    this.page = Math.max(0, Math.min(this.layout.pages.length - 1, index));
    this.#applyPage(animated);
  }

  iconRect(appId) {
    if (this.ui.drawer.isOpen) return null;
    const selector = `.home-page[data-index="${this.page}"] .home-app[data-app="${appId}"] .app-icon, .home-dock .home-app[data-app="${appId}"] .app-icon`;
    return this.el.querySelector(selector)?.getBoundingClientRect() ?? null;
  }

  // ───────────── Gestes ─────────────

  #setupGestures() {
    let mode = null;
    drag(this.viewportEl, {
      filter: (e) => this.ui.state === 'home' && !this.dragging && !(this.editing && e.target.closest('.home-app')),
      onStart: ({ axis, dy }) => {
        if (axis === 'x') mode = 'pages';
        else if (this.editing) mode = null;
        else if (dy < 0) {
          mode = 'drawer';
          this.ui.drawer.dragStart();
        } else {
          mode = 'shade';
          this.ui.shade.dragStart();
        }
        this.justDragged = true;
      },
      onMove: ({ dx, dy }) => {
        if (mode === 'pages') {
          const w = this.viewportEl.clientWidth;
          let offset = -this.page * w + dx;
          const min = -(this.layout.pages.length - 1) * w;
          if (offset > 0) offset *= 0.3;
          if (offset < min) offset = min + (offset - min) * 0.3;
          this.track.style.transition = 'none';
          this.track.style.transform = `translateX(${offset}px)`;
        } else if (mode === 'drawer') this.ui.drawer.dragMove(-dy);
        else if (mode === 'shade') this.ui.shade.dragMove(dy);
      },
      onEnd: ({ dx, vx, dy, vy }) => {
        if (mode === 'pages') {
          const w = this.viewportEl.clientWidth;
          let target = this.page;
          if (dx < -w * 0.25 || vx < -0.4) target++;
          else if (dx > w * 0.25 || vx > 0.4) target--;
          this.setPage(target);
        } else if (mode === 'drawer') this.ui.drawer.dragEnd(-dy, -vy);
        else if (mode === 'shade') this.ui.shade.dragEnd(dy, vy);
        mode = null;
        setTimeout(() => (this.justDragged = false), 30);
      },
    });
    this.viewportEl.addEventListener('pointerdown', () => (this.justDragged = false));
    this.viewportEl.addEventListener('click', (e) => {
      if (this.editing && !e.target.closest('.home-app') && !e.target.closest('.widget')) this.exitEditMode();
    });
    longPress(this.viewportEl, (e) => {
      if (this.editing || e.target.closest?.('.home-app') || this.ui.state !== 'home') return;
      this.k.device.vibrate(15);
      this.#wallpaperMenu();
    });
  }

  async #wallpaperMenu() {
    const choice = await this.ui.dialogs.actionSheet({
      actions: [
        { label: "Modifier l'écran d'accueil", value: 'edit', icon: 'apps' },
        { label: "Fond d'écran", value: 'wallpaper', icon: 'image' },
        { label: 'Réglages', value: 'settings', icon: 'settings' },
      ],
    });
    if (choice === 'edit') this.enterEditMode();
    if (choice === 'wallpaper') this.ui.openIntent({ app: 'settings', action: 'view', data: { page: 'wallpaper' } });
    if (choice === 'settings') this.ui.launch('settings');
  }

  // ───────────── Menu contextuel ─────────────

  #contextMenu(cell, id) {
    const pkg = this.k.packages.get(id);
    const screen = this.ui.screen.getBoundingClientRect();
    const s = viewport.scale || 1;
    const rect = cell.querySelector('.app-icon').getBoundingClientRect();
    const x = (rect.left - screen.left) / s;
    const y = (rect.top - screen.top) / s;
    const size = rect.width / s;
    const close = () => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), this.ui.dur(200));
      this.ui.contextMenuClose = null;
    };
    const item = (label, iconName, action, destructive = false) =>
      h(`button.ctx-item${destructive ? '.destructive' : ''}`, { type: 'button', onclick: (e) => { e.stopPropagation(); close(); action(); } }, h('span', label), icon(iconName, { size: 18 }));
    const items = [
      ...pkg.shortcuts.map((sc) => item(sc.label, sc.icon ?? 'arrow-right', () => this.ui.openIntent({ app: id, ...sc.intent }))),
      item("Modifier l'écran d'accueil", 'apps', () => this.enterEditMode()),
      item("Infos sur l'app", 'info', () => this.ui.openIntent({ app: 'settings', action: 'view', data: { page: 'app', app: id } })),
      item("Retirer de l'accueil", 'minus', () => this.hideFromHome(id)),
      pkg.system ? null : item("Supprimer l'app", 'trash', () => this.#confirmUninstall(id), true),
    ].filter(Boolean);
    const menu = h('div.ctx-menu', items);
    const clone = appIcon(pkg, { size: `${size}px` });
    clone.classList.add('ctx-icon');
    clone.style.left = `${x}px`;
    clone.style.top = `${y}px`;
    const below = y < this.ui.screen.clientHeight * 0.55;
    menu.style.left = `${Math.min(Math.max(12, x - 8), this.ui.screen.clientWidth - 262)}px`;
    if (below) menu.style.top = `${y + size + 12}px`;
    else menu.style.bottom = `${this.ui.screen.clientHeight - y + 12}px`;
    menu.classList.toggle('above', !below);
    const overlay = h('div.ctx-overlay', { onclick: close }, clone, menu);
    this.ui.layers.dialogs.append(overlay);
    this.ui.contextMenuClose = close;
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  async #confirmUninstall(id) {
    const pkg = this.k.packages.get(id);
    const ok = await this.ui.dialogs.confirm({
      title: `Supprimer « ${pkg.name} » ?`,
      message: "Supprimer cette app supprimera également ses données.",
      confirmLabel: 'Supprimer',
      destructive: true,
    });
    if (ok) {
      await this.k.packages.uninstall(id);
      this.ui.dialogs.toast(`${pkg.name} a été supprimée`);
    }
  }

  async #askRemove(id) {
    const pkg = this.k.packages.get(id);
    const actions = [{ label: "Retirer de l'écran d'accueil", value: 'hide' }];
    if (!pkg.system) actions.push({ label: "Supprimer l'app", value: 'delete', destructive: true });
    const choice = await this.ui.dialogs.actionSheet({ title: pkg.name, message: pkg.system ? "L'app restera disponible dans le tiroir d'applications." : '', actions });
    if (choice === 'hide') this.hideFromHome(id);
    if (choice === 'delete') this.#confirmUninstall(id);
  }

  // ───────────── Mode édition ─────────────

  enterEditMode() {
    if (this.editing) return;
    this.editing = true;
    this.el.classList.add('editing');
    this.k.device.vibrate(12);
  }

  exitEditMode() {
    if (!this.editing) return false;
    this.editing = false;
    this.el.classList.remove('editing');
    this.#save();
    return true;
  }

  #maybeStartDrag(e, cell, id) {
    if (!this.editing || this.dragging || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest('.remove-badge')) return;
    const start = { x: e.clientX, y: e.clientY };
    const move = (ev) => {
      if (!this.dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        this.#beginDrag(cell, id, ev);
      }
      this.#moveDrag(ev);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (this.dragging) this.#endDrag();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  #screenPoint(ev) {
    const screen = this.ui.screen.getBoundingClientRect();
    const s = viewport.scale || 1;
    return { x: (ev.clientX - screen.left) / s, y: (ev.clientY - screen.top) / s };
  }

  #beginDrag(cell, id, ev) {
    const rect = cell.querySelector('.app-icon').getBoundingClientRect();
    const s = viewport.scale || 1;
    const ghost = appIcon(this.k.packages.get(id), { size: `${rect.width / s}px` });
    ghost.classList.add('drag-ghost');
    this.ui.screen.append(ghost);
    const p = this.#screenPoint(ev);
    const screen = this.ui.screen.getBoundingClientRect();
    this.dragging = { id, ghost, offsetX: p.x - (rect.left - screen.left) / s, offsetY: p.y - (rect.top - screen.top) / s, edgeTimer: null };
    cell.classList.add('placeholder');
    this.k.device.vibrate(10);
  }

  #moveDrag(ev) {
    const d = this.dragging;
    const p = this.#screenPoint(ev);
    d.ghost.style.transform = `translate(${p.x - d.offsetX}px, ${p.y - d.offsetY}px) scale(1.12)`;

    // Changement de page en approchant du bord.
    const w = this.ui.screen.clientWidth;
    const edge = p.x < 22 ? -1 : p.x > w - 22 ? 1 : 0;
    if (edge && !d.edgeTimer) {
      d.edgeTimer = setTimeout(() => {
        d.edgeTimer = null;
        const target = this.page + edge;
        if (target < 0) return;
        if (target >= this.layout.pages.length) {
          if (this.layout.pages[this.page].length <= 1) return;
          this.layout.pages.push([]);
        }
        this.#moveTo(d.id, 'page', target, null);
        this.setPage(target);
      }, 650);
    } else if (!edge && d.edgeTimer) {
      clearTimeout(d.edgeTimer);
      d.edgeTimer = null;
    }

    const under = document.elementsFromPoint(ev.clientX, ev.clientY);
    const targetCell = under.find((el) => el.classList?.contains('home-app') && el.dataset.app !== d.id);
    if (targetCell) {
      const inDock = Boolean(targetCell.closest('.home-dock'));
      this.#moveTo(d.id, inDock ? 'dock' : 'page', inDock ? null : this.page, targetCell.dataset.app);
      return;
    }
    if (under.some((el) => el === this.dock)) this.#moveTo(d.id, 'dock', null, null);
  }

  /** Déplace `id` avant `beforeId` dans la cible (ou à la fin). */
  #moveTo(id, container, pageIndex, beforeId) {
    const layout = this.layout;
    const list = container === 'dock' ? layout.dock : layout.pages[pageIndex];
    if (!list) return;
    const currentIndex = list.indexOf(id);
    const targetIndex = beforeId ? list.indexOf(beforeId) : list.length;
    if (currentIndex >= 0 && (currentIndex === targetIndex || (!beforeId && currentIndex === list.length - 1))) return;
    if (container === 'dock' && currentIndex < 0 && layout.dock.length >= DOCK_MAX) return;
    const sig = JSON.stringify([layout.dock, layout.pages]);
    if (currentIndex >= 0) {
      // Réordonne dans le même conteneur : échange de position.
      list.splice(currentIndex, 1);
      list.splice(beforeId ? list.indexOf(beforeId) + (currentIndex <= targetIndex ? 1 : 0) : list.length, 0, id);
    } else {
      layout.dock = layout.dock.filter((x) => x !== id);
      layout.pages = layout.pages.map((p) => p.filter((x) => x !== id));
      const fresh = container === 'dock' ? layout.dock : layout.pages[pageIndex];
      const at = beforeId ? fresh.indexOf(beforeId) : fresh.length;
      fresh.splice(at < 0 ? fresh.length : at, 0, id);
    }
    this.#normalize();
    if (JSON.stringify([layout.dock, layout.pages]) !== sig) this.render();
  }

  #endDrag() {
    const d = this.dragging;
    clearTimeout(d.edgeTimer);
    d.ghost.remove();
    this.dragging = null;
    this.#normalize();
    this.#save();
    this.render();
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false), 50);
  }
}
