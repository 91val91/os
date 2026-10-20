/**
 * Tiroir d'applications (Android) avec recherche universelle :
 * applications, contacts, fichiers, calcul rapide et recherche Web.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { drag, longPress } from '../lib/gesture.js';
import { evaluate, formatNumber, looksLikeMath } from '../lib/expr.js';
import { avatar } from '../lib/ui.js';
import { displayName } from '../kernel/contacts.js';
import { appIcon } from './app-icon.js';

export class AppDrawer {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.drawer;
    this.isOpen = false;
    this.travel = 520;
  }

  start() {
    this.input = h('input', { type: 'search', placeholder: 'Rechercher des apps, contacts, fichiers…', autocomplete: 'off', enterkeyhint: 'search' });
    this.input.addEventListener('input', () => this.#search());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.el.querySelector('.drawer-results [data-primary]')?.click();
      if (e.key === 'Escape') this.close();
    });
    this.grid = h('div.drawer-grid');
    this.results = h('div.drawer-results');
    this.scroller = h('div.drawer-scroll', this.results, this.grid);
    const header = h('div.drawer-header', h('div.drawer-grabber'), h('label.drawer-search', icon('search', { size: 18 }), this.input));
    this.el.replaceChildren(h('div.drawer-panel', header, this.scroller));
    this.el.style.setProperty('--p', '0');

    drag(header, {
      axis: 'y',
      filter: () => this.isOpen,
      onStart: () => this.el.classList.add('dragging'),
      onMove: ({ dy }) => this.#set(1 - Math.max(0, dy) / this.travel),
      onEnd: ({ dy, vy }) => this.dragEnd(this.travel - Math.max(0, dy), -vy),
    });
    // Glisser vers le bas depuis le haut de la liste ferme le tiroir.
    drag(this.scroller, {
      axis: 'y',
      filter: () => this.isOpen && this.scroller.scrollTop <= 0,
      onStart: ({ dy }) => dy > 0 && this.el.classList.add('dragging'),
      onMove: ({ dy }) => dy > 0 && this.#set(1 - dy / this.travel),
      onEnd: ({ dy, vy }) => (dy > 0 ? this.dragEnd(this.travel - dy, -vy) : this.el.classList.remove('dragging')),
    });

    for (const type of ['package:install', 'package:uninstall']) this.k.events.on(type, () => this.render());
    this.render();
  }

  #set(p) {
    this.el.style.setProperty('--p', String(Math.min(1, Math.max(0, p))));
  }

  render() {
    const apps = this.k.packages.list().filter((p) => !p.hidden);
    this.grid.replaceChildren(...apps.map((pkg) => this.#appButton(pkg)));
  }

  #appButton(pkg) {
    const iconEl = appIcon(pkg, { size: 'var(--icon-size)' });
    const el = h('button.drawer-app', { type: 'button', onclick: () => this.#launch(pkg.id, iconEl) }, iconEl, h('span', pkg.name));
    longPress(el, () => this.#menu(pkg));
    return el;
  }

  #launch(appId, iconEl) {
    const rect = iconEl?.getBoundingClientRect();
    this.close(true);
    this.ui.launch(appId, { action: 'main' }, { origin: rect });
  }

  async #menu(pkg) {
    this.k.device.vibrate(15);
    const onHome = this.ui.home.isOnHome(pkg.id);
    const choice = await this.ui.dialogs.actionSheet({
      title: pkg.name,
      actions: [
        onHome ? null : { label: "Ajouter à l'écran d'accueil", value: 'add', icon: 'plus' },
        { label: "Infos sur l'app", value: 'info', icon: 'info' },
        pkg.system ? null : { label: 'Désinstaller', value: 'uninstall', icon: 'trash', destructive: true },
      ].filter(Boolean),
    });
    if (choice === 'add') {
      this.ui.home.addToHome(pkg.id);
      this.ui.dialogs.toast(`${pkg.name} ajoutée à l'écran d'accueil`);
    } else if (choice === 'info') {
      this.close(true);
      this.ui.openIntent({ app: 'settings', action: 'view', data: { page: 'app', app: pkg.id } });
    } else if (choice === 'uninstall') {
      const ok = await this.ui.dialogs.confirm({ title: `Désinstaller ${pkg.name} ?`, confirmLabel: 'Désinstaller', destructive: true });
      if (ok) await this.k.packages.uninstall(pkg.id);
    }
  }

  #search() {
    const q = this.input.value.trim();
    this.el.classList.toggle('searching', Boolean(q));
    if (!q) {
      this.results.replaceChildren();
      return;
    }
    const lower = q.toLowerCase();
    const sections = [];
    let primarySet = false;
    const primary = (el) => {
      if (!primarySet) {
        el.dataset.primary = '1';
        primarySet = true;
      }
      return el;
    };

    if (looksLikeMath(q)) {
      const value = formatNumber(evaluate(q));
      sections.push(h('div.search-calc', h('span', q), h('strong', `= ${value}`)));
    }

    const apps = this.k.packages.list().filter((p) => !p.hidden && (p.name.toLowerCase().includes(lower) || p.id.includes(lower)));
    if (apps.length) {
      sections.push(h('div.search-title', 'Applications'), h('div.search-apps', apps.slice(0, 8).map((pkg) => primary(this.#appButton(pkg)))));
    }

    const contacts = this.k.contacts.search(q).slice(0, 4);
    if (contacts.length) {
      sections.push(
        h('div.search-title', 'Contacts'),
        h(
          'div.search-list',
          contacts.map((c) =>
            primary(
              h(
                'button.search-row',
                { type: 'button', onclick: () => { this.close(true); this.ui.openIntent({ app: 'contacts', action: 'view', data: { id: c.id } }); } },
                avatar(displayName(c), { color: c.color, size: 34 }),
                h('span.search-row-text', h('strong', displayName(c)), h('small', c.phone)),
                h('span.search-row-action', { onclick: (e) => { e.stopPropagation(); this.close(true); this.ui.openIntent({ action: 'dial', data: { number: c.phone } }); } }, icon('phone-fill', { size: 18 })),
              ),
            ),
          ),
        ),
      );
    }

    const files = [];
    for (const entry of this.k.fs.walk('/home')) {
      if (entry.type === 'file' && !entry.name.startsWith('.') && entry.name.toLowerCase().includes(lower)) files.push(entry);
      if (files.length >= 5) break;
    }
    if (files.length) {
      sections.push(
        h('div.search-title', 'Fichiers'),
        h(
          'div.search-list',
          files.map((f) =>
            primary(
              h(
                'button.search-row',
                { type: 'button', onclick: () => { this.close(true); this.ui.openIntent({ action: 'view', type: f.mime, data: { path: f.path } }); } },
                h('span.search-file-icon', icon(f.mime?.startsWith('image/') ? 'image' : f.mime?.startsWith('audio/') ? 'music' : 'file-text', { size: 20 })),
                h('span.search-row-text', h('strong', f.name), h('small', f.path.replace(/\/[^/]+$/, ''))),
              ),
            ),
          ),
        ),
      );
    }

    sections.push(
      h('div.search-title', 'Web'),
      h(
        'div.search-list',
        primary(
          h(
            'button.search-row',
            { type: 'button', onclick: () => { this.close(true); this.ui.openIntent({ app: 'browser', action: 'view', data: { query: q } }); } },
            h('span.search-file-icon', icon('globe', { size: 20 })),
            h('span.search-row-text', h('strong', `Rechercher « ${q} »`), h('small', 'Navigateur')),
          ),
        ),
      ),
    );
    this.results.replaceChildren(...sections);
  }

  // ───────────── Ouverture / fermeture ─────────────

  dragStart() {
    this.el.classList.add('visible', 'dragging');
  }

  dragMove(distance) {
    this.#set(distance / this.travel);
  }

  dragEnd(distance, velocity) {
    this.el.classList.remove('dragging');
    if (distance > this.travel * 0.25 || velocity > 0.4) this.open();
    else this.close();
  }

  open({ search = false } = {}) {
    this.ui.closeOverlays({ except: this });
    this.isOpen = true;
    this.el.classList.add('visible');
    void this.el.offsetWidth;
    this.el.classList.remove('dragging');
    this.el.classList.add('open');
    this.#set(1);
    if (search) setTimeout(() => this.input.focus(), this.ui.dur(250));
  }

  close(immediate = false) {
    if (!this.isOpen && !this.el.classList.contains('visible')) return false;
    this.isOpen = false;
    this.el.classList.remove('open', 'dragging');
    this.#set(0);
    this.input.blur();
    const finish = () => {
      if (this.isOpen) return;
      this.el.classList.remove('visible', 'searching');
      this.input.value = '';
      this.results.replaceChildren();
      this.scroller.scrollTop = 0;
    };
    if (immediate || this.ui.animScale === 0) finish();
    else setTimeout(finish, this.ui.dur(320));
    return true;
  }
}
