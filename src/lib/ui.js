/**
 * Kit de composants pour les applications (style iOS + Material).
 * Les styles correspondants sont dans src/styles/kit.css.
 */
import { h, animate } from './dom.js';
import { icon } from './icons.js';
import { drag } from './gesture.js';
import { initials, colorFor } from './format.js';

export function iconButton(name, onClick, { label = '', className = '', size = 22 } = {}) {
  return h(`button.icon-btn${className ? '.' + className.split(' ').join('.') : ''}`, { type: 'button', title: label, 'aria-label': label, onclick: onClick }, icon(name, { size }));
}

/**
 * Barre d'application avec grand titre repliable (iOS).
 * @param {{ title: string, large?: boolean, back?: { label?: string, onClick: Function }, actions?: Node[] }} options
 */
export function appBar({ title, large = true, back = null, actions = [], leading = null }) {
  const small = h('div.appbar-title', title);
  const big = large ? h('h1.appbar-large', title) : null;
  const bar = h(
    `header.appbar${large ? '.large' : ''}`,
    h(
      'div.appbar-row',
      h(
        'div.appbar-leading',
        back ? h('button.appbar-back', { type: 'button', onclick: back.onClick }, icon('chevron-left', { size: 26 }), h('span', back.label ?? '')) : leading,
      ),
      small,
      h('div.appbar-actions', actions),
    ),
    big,
  );
  bar.setTitle = (text) => {
    small.textContent = text;
    if (big) big.textContent = text;
  };
  return bar;
}

/** Replie le grand titre quand le contenu défile. */
export function collapseOnScroll(bar, scroller) {
  const update = () => bar.classList.toggle('collapsed', scroller.scrollTop > 28);
  scroller.addEventListener('scroll', update, { passive: true });
  update();
}

/** Barre d'onglets inférieure. */
export function tabBar(items, { value, onChange }) {
  const buttons = new Map();
  const bar = h(
    'nav.tabbar',
    items.map((item) => {
      const btn = h(
        'button.tab',
        { type: 'button', onclick: () => select(item.id, true) },
        h('span.tab-icon', icon(item.icon, { size: 24 }), item.badge ? h('span.badge', item.badge) : null),
        h('span.tab-label', item.label),
      );
      buttons.set(item.id, btn);
      return btn;
    }),
  );
  function select(id, notify = false) {
    for (const [key, btn] of buttons) btn.classList.toggle('active', key === id);
    bar.value = id;
    if (notify) onChange?.(id);
  }
  bar.select = select;
  bar.setBadge = (id, count) => {
    const holder = buttons.get(id)?.querySelector('.tab-icon');
    if (!holder) return;
    holder.querySelector('.badge')?.remove();
    if (count) holder.append(h('span.badge', count > 99 ? '99+' : String(count)));
  };
  select(value);
  return bar;
}

export function listGroup({ header = null, footer = null, items = [], className = '' } = {}) {
  return h(
    `section.list-group${className ? '.' + className : ''}`,
    header ? h('div.list-header', header) : null,
    h('div.list', items),
    footer ? h('div.list-footer', footer) : null,
  );
}

export function iconTile(name, color, size = 18) {
  return h('span.icon-tile', { style: { background: color } }, icon(name, { size, stroke: 2.2 }));
}

/**
 * Ligne de liste.
 * @param {object} o
 */
export function listItem({ icon: iconName, iconColor = 'var(--accent)', leading = null, title, subtitle = null, detail = null, chevron = false, onClick = null, trailing = null, destructive = false, className = '' }) {
  const lead = leading ?? (iconName ? iconTile(iconName, iconColor) : null);
  const row = h(
    `div.list-item${onClick ? '.tappable' : ''}${destructive ? '.destructive' : ''}${className ? '.' + className.split(' ').join('.') : ''}`,
    { role: onClick ? 'button' : null, tabindex: onClick ? 0 : null, onclick: onClick },
    lead ? h('div.li-leading', lead) : null,
    h('div.li-body', h('div.li-title', title), subtitle != null ? h('div.li-sub', subtitle) : null),
    detail != null ? h('div.li-detail', detail) : null,
    trailing,
    chevron ? h('span.li-chevron', icon('chevron-right', { size: 18 })) : null,
  );
  if (onClick) row.addEventListener('keydown', (e) => e.key === 'Enter' && onClick(e));
  return row;
}

export function toggle(checked, onChange, { label = '', disabled = false } = {}) {
  const input = h('input', { type: 'checkbox', checked: Boolean(checked), 'aria-label': label, disabled });
  input.addEventListener('change', () => onChange?.(input.checked));
  const el = h('label.switch', { onclick: (e) => e.stopPropagation() }, input, h('span.switch-track'));
  el.input = input;
  el.set = (value) => (input.checked = Boolean(value));
  return el;
}

export function slider({ min = 0, max = 1, step = 0.01, value = 0, onInput, iconLeft = null, iconRight = null, label = '' }) {
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const sync = () => input.style.setProperty('--fill', `${((input.value - min) / (max - min)) * 100}%`);
  input.addEventListener('input', () => {
    sync();
    onInput?.(Number(input.value));
  });
  sync();
  const el = h('div.slider', iconLeft ? icon(iconLeft, { size: 18 }) : null, input, iconRight ? icon(iconRight, { size: 20 }) : null);
  el.input = input;
  el.set = (v) => {
    input.value = v;
    sync();
  };
  return el;
}

export function segmented(options, value, onChange) {
  const el = h('div.segmented', { role: 'tablist' });
  const buttons = options.map((opt) =>
    h('button', { type: 'button', role: 'tab', onclick: () => set(opt.value, true) }, opt.icon ? icon(opt.icon, { size: 16 }) : null, opt.label),
  );
  el.append(...buttons);
  function set(v, notify = false) {
    options.forEach((opt, i) => buttons[i].classList.toggle('active', opt.value === v));
    el.value = v;
    if (notify) onChange?.(v);
  }
  el.set = set;
  set(value);
  return el;
}

export function button(label, { variant = 'filled', onClick, icon: iconName = null, small = false, destructive = false, block = false, disabled = false } = {}) {
  return h(
    `button.btn.btn-${variant}${small ? '.small' : ''}${destructive ? '.destructive' : ''}${block ? '.block' : ''}`,
    { type: 'button', onclick: onClick, disabled },
    iconName ? icon(iconName, { size: small ? 16 : 18 }) : null,
    label ? h('span', label) : null,
  );
}

export function searchField({ placeholder = 'Rechercher', onInput, value = '' } = {}) {
  const input = h('input', { type: 'search', placeholder, value, enterkeyhint: 'search', autocomplete: 'off' });
  input.addEventListener('input', () => onInput?.(input.value));
  const el = h('label.search', icon('search', { size: 17 }), input);
  el.input = input;
  return el;
}

export function emptyState({ icon: iconName = 'info', title, message = '', action = null }) {
  return h('div.empty-state', h('div.empty-icon', icon(iconName, { size: 44, stroke: 1.6 })), h('h3', title), message ? h('p', message) : null, action);
}

export function avatar(name, { color = null, size = 40, photo = null } = {}) {
  const el = h('div.avatar', { style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px`, background: photo ? `center/cover url("${photo}")` : `linear-gradient(160deg, color-mix(in srgb, ${color ?? colorFor(name)} 75%, white), ${color ?? colorFor(name)})` } });
  if (!photo) {
    const text = initials(name);
    if (text === '#') el.append(icon('user', { size: Math.round(size * 0.55) }));
    else el.textContent = text;
  }
  return el;
}

export function field({ label, value = '', placeholder = '', type = 'text', onInput = null, multiline = false, autofocus = false, inputmode = null }) {
  const input = multiline
    ? h('textarea', { placeholder, rows: 3 }, value)
    : h('input', { type, value, placeholder, inputmode, autocomplete: 'off' });
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  if (autofocus) setTimeout(() => input.focus(), 350);
  const el = h('label.field', label ? h('span.field-label', label) : null, input);
  el.input = input;
  return el;
}

/** Bouton d'action flottant (Material). */
export function fab(iconName, onClick, label = '') {
  return h('button.fab', { type: 'button', onclick: onClick, 'aria-label': label, title: label }, icon(iconName, { size: 26 }));
}

/**
 * Feuille modale glissant depuis le bas, affichée dans `host` (racine de l'app).
 * Glisser la poignée vers le bas la ferme.
 */
export function sheet(host, { title = '', content, onClose, cancelLabel = 'Annuler', confirmLabel = null, onConfirm = null, full = false } = {}) {
  const panel = h(
    `div.sheet${full ? '.full' : ''}`,
    h('div.sheet-grabber'),
    h(
      'div.sheet-header',
      h('button.sheet-btn', { type: 'button', onclick: () => close() }, cancelLabel),
      h('div.sheet-title', title),
      confirmLabel
        ? h('button.sheet-btn.strong', { type: 'button', onclick: async () => { if ((await onConfirm?.()) !== false) close(true); } }, confirmLabel)
        : h('span.sheet-btn'),
    ),
    h('div.sheet-body', content),
  );
  const backdrop = h('div.sheet-backdrop', { onclick: () => close() });
  const layer = h('div.sheet-layer', backdrop, panel);
  host.append(layer);
  animate(panel, [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 320, easing: 'cubic-bezier(.2,.9,.3,1)' });
  animate(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 250 });

  drag(panel.querySelector('.sheet-grabber').parentElement, {
    axis: 'y',
    filter: (e) => !e.target.closest('.sheet-body') && !e.target.closest('button'),
    onMove: ({ dy }) => (panel.style.transform = `translateY(${Math.max(0, dy)}px)`),
    onEnd: ({ dy, vy }) => {
      if (dy > 120 || vy > 0.6) close();
      else {
        panel.style.transition = 'transform .25s';
        panel.style.transform = '';
        setTimeout(() => (panel.style.transition = ''), 260);
      }
    },
  });

  let closed = false;
  async function close(confirmed = false) {
    if (closed) return;
    closed = true;
    await Promise.all([
      animate(panel, [{ transform: getComputedStyle(panel).transform === 'none' ? 'translateY(0)' : getComputedStyle(panel).transform }, { transform: 'translateY(100%)' }], { duration: 240, easing: 'ease-in', fill: 'forwards' }),
      animate(backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: 'forwards' }),
    ]);
    layer.remove();
    onClose?.(confirmed);
  }
  return { el: panel, close };
}

/** Glisser une ligne vers la gauche pour révéler « Supprimer ». */
export function swipeToDelete(row, onDelete, { label = 'Supprimer' } = {}) {
  const action = h('button.swipe-action', { type: 'button', onclick: (e) => { e.stopPropagation(); remove(); } }, icon('trash', { size: 20 }), h('span', label));
  const wrap = h('div.swipe-wrap', action);
  row.replaceWith?.(wrap);
  wrap.append(row);
  let offset = 0;
  const set = (x, animated) => {
    offset = x;
    row.style.transition = animated ? 'transform .25s cubic-bezier(.2,.9,.3,1)' : '';
    row.style.transform = x ? `translateX(${x}px)` : '';
    if (!x) setTimeout(() => offset === 0 && wrap.classList.remove('swiping'), animated ? 260 : 0);
  };
  async function remove() {
    await animate(wrap, [{ height: `${wrap.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 220, fill: 'forwards' });
    onDelete();
  }
  drag(row, {
    axis: 'x',
    onStart: () => wrap.classList.add('swiping'),
    onMove: ({ dx }) => set(Math.min(0, dx + (offset < 0 ? -96 : 0)), false),
    onEnd: ({ dx, vx }) => {
      const total = dx + (offset < 0 ? -96 : 0);
      if (total < -wrap.offsetWidth * 0.55) return remove();
      set(total < -48 || vx < -0.5 ? -96 : 0, true);
    },
  });
  row.addEventListener('click', (e) => {
    if (offset !== 0) {
      e.stopPropagation();
      set(0, true);
    }
  }, true);
  return wrap;
}

/** Indicateur de chargement. */
export function spinner(size = 28) {
  return h('div.spinner', { style: { width: `${size}px`, height: `${size}px` } });
}

/**
 * Pile de navigation (pages qui glissent depuis la droite, façon iOS).
 * Chaque page est un élément ; `onPop` est appelé quand elle est retirée.
 */
export function navStack(root) {
  const container = h('div.nav-stack');
  root.append(container);
  const stack = [];
  const ease = 'cubic-bezier(.2,.9,.3,1)';
  return {
    get depth() {
      return stack.length;
    },
    get top() {
      return stack.at(-1) ?? null;
    },
    push(page, { animated = true } = {}) {
      const previous = stack.at(-1);
      page.classList.add('nav-page');
      stack.push(page);
      container.append(page);
      if (!previous) return page;
      if (!animated) {
        previous.classList.add('covered');
        return page;
      }
      animate(page, [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], { duration: 380, easing: ease });
      animate(previous, [{ transform: 'translateX(0)' }, { transform: 'translateX(-28%)' }], { duration: 380, easing: ease }).then(() => {
        if (stack.at(-1) !== previous) previous.classList.add('covered');
      });
      return page;
    },
    async pop({ animated = true } = {}) {
      if (stack.length <= 1) return false;
      const page = stack.pop();
      const previous = stack.at(-1);
      previous.classList.remove('covered');
      if (animated) {
        await Promise.all([
          animate(page, [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], { duration: 320, easing: ease, fill: 'forwards' }),
          animate(previous, [{ transform: 'translateX(-28%)' }, { transform: 'translateX(0)' }], { duration: 320, easing: ease }),
        ]);
      }
      page.remove();
      page.onPop?.();
      previous.onShow?.();
      return true;
    },
    async popToRoot() {
      while (stack.length > 2) {
        const page = stack.splice(stack.length - 2, 1)[0];
        page.remove();
        page.onPop?.();
      }
      return this.pop();
    },
    reset(page) {
      for (const p of stack.splice(0)) {
        p.remove();
        p.onPop?.();
      }
      this.push(page, { animated: false });
    },
  };
}

/** Page standard : barre d'application + zone défilante. */
export function page({ title, large = true, back = null, actions = [], content = [], className = '' }) {
  const bar = appBar({ title, large, back, actions });
  const scroll = h('div.app-scroll', h('div.app-content', content));
  const el = h(`div.page${className ? '.' + className : ''}`, bar, scroll);
  collapseOnScroll(bar, scroll);
  el.bar = bar;
  el.scroll = scroll;
  el.content = scroll.firstChild;
  return el;
}
