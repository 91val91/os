/**
 * Rendu des icônes d'applications (dégradé + pictogramme), avec icônes
 * « vivantes » pour le Calendrier (date du jour) et l'Horloge (aiguilles).
 */
import { h, svgEl } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

const liveClocks = new Set();
let clockTimer = null;

function updateClock(svg) {
  const now = new Date();
  const minutes = now.getMinutes() + now.getSeconds() / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  svg.querySelector('.h').setAttribute('transform', `rotate(${hours * 30} 50 50)`);
  svg.querySelector('.m').setAttribute('transform', `rotate(${minutes * 6} 50 50)`);
  svg.querySelector('.s').setAttribute('transform', `rotate(${now.getSeconds() * 6} 50 50)`);
}

function tickClocks() {
  for (const svg of liveClocks) {
    if (!svg.isConnected) liveClocks.delete(svg);
    else updateClock(svg);
  }
  if (!liveClocks.size) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

export function clockFace({ size = 100, seconds = true, dark = true } = {}) {
  const ticks = Array.from({ length: 12 }, (_, i) =>
    svgEl('line', { x1: 50, y1: 8, x2: 50, y2: i % 3 ? 13 : 16, stroke: dark ? '#fff' : '#111', 'stroke-width': i % 3 ? 2 : 3.2, 'stroke-linecap': 'round', transform: `rotate(${i * 30} 50 50)`, opacity: i % 3 ? 0.55 : 1 }),
  );
  const svg = svgEl(
    'svg',
    { viewBox: '0 0 100 100', width: size, height: size, class: 'clock-face' },
    svgEl('circle', { cx: 50, cy: 50, r: 48, fill: dark ? '#111' : '#fff' }),
    ...ticks,
    svgEl('line', { class: 'h', x1: 50, y1: 52, x2: 50, y2: 27, stroke: dark ? '#fff' : '#111', 'stroke-width': 5, 'stroke-linecap': 'round' }),
    svgEl('line', { class: 'm', x1: 50, y1: 54, x2: 50, y2: 15, stroke: dark ? '#fff' : '#111', 'stroke-width': 3.4, 'stroke-linecap': 'round' }),
    svgEl('line', { class: 's', x1: 50, y1: 58, x2: 50, y2: 12, stroke: '#ff9500', 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: seconds ? 1 : 0 }),
    svgEl('circle', { cx: 50, cy: 50, r: 3, fill: '#ff9500' }),
  );
  updateClock(svg);
  liveClocks.add(svg);
  clockTimer ??= setInterval(tickClocks, 1000);
  return svg;
}

function calendarGlyph() {
  const now = new Date();
  const day = now.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  return h('div.calicon', h('span.calicon-day', day), h('span.calicon-num', String(now.getDate())));
}

/**
 * @param {object} pkg manifeste
 * @param {{ size?: number, badge?: number }} [options]
 */
export function appIcon(pkg, { size = 60, badge = 0 } = {}) {
  const [from, to] = pkg.color ?? ['#8e8e93', '#636366'];
  const dim = typeof size === 'number' ? `${size}px` : size;
  const el = h('div.app-icon', {
    style: { width: dim, height: dim, background: `linear-gradient(160deg, ${from}, ${to})` },
    dataset: { app: pkg.id },
  });
  if (pkg.id === 'calendar') {
    el.classList.add('live-calendar');
    el.append(calendarGlyph());
  } else if (pkg.id === 'clock') {
    el.classList.add('live-clock');
    el.append(clockFace({ size: '86%' }));
  } else {
    el.append(icon(pkg.icon ?? 'apps', { size: 24, stroke: pkg.iconStroke ?? 2, className: 'glyph' }));
  }
  if (badge) el.append(h('span.icon-badge', badge > 99 ? '99+' : String(badge)));
  return el;
}

/** Rafraîchit les icônes Calendrier (changement de jour). */
export function refreshCalendarIcons(root = document) {
  for (const el of root.querySelectorAll('.live-calendar')) el.replaceChildren(calendarGlyph());
}
