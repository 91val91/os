/**
 * Rendu des icônes d'applications : illustration propre à chaque app
 * (app-art.js), avec icônes « vivantes » pour le Calendrier (jour et date)
 * et l'Horloge (aiguilles). Une app sans illustration (tierce) garde un
 * dégradé de ses couleurs et un pictogramme.
 */
import { h, svgEl } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { appArt } from './app-art.js';

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

function watchClock(svg) {
  updateClock(svg);
  liveClocks.add(svg);
  clockTimer ??= setInterval(tickClocks, 1000);
  return svg;
}

/** Graduations et aiguilles d'un cadran 100 × 100 (centre 50, 50). */
function clockHands({ seconds = true, dark = true } = {}) {
  const ink = dark ? '#fff' : '#1c1d22';
  const ticks = Array.from({ length: 12 }, (_, i) =>
    svgEl('line', { x1: 50, y1: 8, x2: 50, y2: i % 3 ? 13 : 16.5, stroke: i % 3 ? (dark ? '#8e8e93' : '#a1a3aa') : ink, 'stroke-width': i % 3 ? 2.2 : 3.6, 'stroke-linecap': 'round', transform: `rotate(${i * 30} 50 50)` }),
  );
  return [
    ...ticks,
    svgEl('line', { class: 'h', x1: 50, y1: 53, x2: 50, y2: 28, stroke: ink, 'stroke-width': 5.4, 'stroke-linecap': 'round' }),
    svgEl('line', { class: 'm', x1: 50, y1: 54, x2: 50, y2: 15, stroke: ink, 'stroke-width': 3.6, 'stroke-linecap': 'round' }),
    svgEl('line', { class: 's', x1: 50, y1: 59, x2: 50, y2: 12, stroke: '#ff9500', 'stroke-width': 1.8, 'stroke-linecap': 'round', opacity: seconds ? 1 : 0 }),
    svgEl('circle', { cx: 50, cy: 50, r: 3.4, fill: '#ff9500' }),
    svgEl('circle', { cx: 50, cy: 50, r: 1.3, fill: dark ? '#111' : '#fff' }),
  ];
}

export function clockFace({ size = 100, seconds = true, dark = true } = {}) {
  const svg = svgEl(
    'svg',
    { viewBox: '0 0 100 100', width: size, height: size, class: 'clock-face' },
    svgEl('circle', { cx: 50, cy: 50, r: 48, fill: dark ? '#111' : '#fff' }),
    ...clockHands({ seconds, dark }),
  );
  return watchClock(svg);
}

function setCalendarDate(svg, now = new Date()) {
  svg.querySelector('.art-weekday').textContent = now.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '').toUpperCase();
  svg.querySelector('.art-date').textContent = String(now.getDate());
}

/**
 * @param {object} pkg manifeste
 * @param {{ size?: number, badge?: number }} [options]
 */
export function appIcon(pkg, { size = 60, badge = 0 } = {}) {
  const dim = typeof size === 'number' ? `${size}px` : size;
  const el = h('div.app-icon', { style: { width: dim, height: dim }, dataset: { app: pkg.id } });
  const art = appArt(pkg.id);
  if (art) {
    el.append(art);
    if (pkg.id === 'calendar') {
      el.classList.add('live-calendar');
      setCalendarDate(art);
    } else if (pkg.id === 'clock') {
      el.classList.add('live-clock');
      art.querySelector('.art-dial').append(...clockHands({ dark: false }));
      watchClock(art);
    }
  } else {
    const [from, to] = pkg.color ?? ['#8e8e93', '#636366'];
    el.style.background = `linear-gradient(160deg, ${from}, ${to})`;
    el.append(icon(pkg.icon ?? 'apps', { size: 24, stroke: pkg.iconStroke ?? 2, className: 'glyph' }));
  }
  if (badge) el.append(h('span.icon-badge', badge > 99 ? '99+' : String(badge)));
  return el;
}

/** Rafraîchit les icônes Calendrier (changement de jour). */
export function refreshCalendarIcons(root = document) {
  for (const svg of root.querySelectorAll('.live-calendar .app-art')) setCalendarDate(svg);
}
