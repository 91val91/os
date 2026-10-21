/**
 * Illustrations des icônes d'applications : un SVG plein cadre par app, fond
 * compris (la forme de l'icône le découpe). Lumière venant d'en haut à
 * gauche, ombres portées nettes (sans flou), 2 à 4 couleurs par icône ;
 * l'essentiel tient dans un cercle de rayon 40 pour la forme ronde.
 */

// Chaque rendu a ses propres identifiants : une même icône est affichée
// plusieurs fois (accueil, tiroir, notifications) et ses copies peuvent
// être masquées ou détachées sans casser les dégradés des autres.
let seq = 0;

const attrs = (o) => Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(' ');

const stops = (colors) =>
  colors
    .map((c, i) => {
      const [color, offset] = Array.isArray(c) ? c : [c, i / (colors.length - 1)];
      return `<stop offset="${offset}" stop-color="${color}"/>`;
    })
    .join('');

/** Contexte de dessin : dégradés en coordonnées de l'icône (0–100). */
function painter() {
  const n = ++seq;
  const defs = [];
  const add = (tag, geometry, colors) => {
    const id = `oa${n}-${defs.length}`;
    defs.push(`<${tag} id="${id}" gradientUnits="userSpaceOnUse" ${attrs(geometry)}>${stops(colors)}</${tag}>`);
    return `url(#${id})`;
  };
  return {
    defs,
    lin: (colors, [x1, y1, x2, y2] = [30, 0, 70, 100]) => add('linearGradient', { x1, y1, x2, y2 }, colors),
    rad: (colors, [cx, cy, r]) => add('radialGradient', { cx, cy, r }, colors),
  };
}

const bg = (p, colors, dir = [25, 0, 75, 100]) => `<rect width="100" height="100" fill="${p.lin(colors, dir)}"/>`;

/** Ombre portée d'une forme (décalée vers le bas, un peu à droite). */
function drop(shape, paint, { shadow = '#000', o = 0.22, d = 2.4 } = {}) {
  const dark = { ...paint };
  for (const key of ['fill', 'stroke']) if (dark[key] && dark[key] !== 'none') dark[key] = shadow;
  return `<g ${attrs(dark)} opacity="${o}" transform="translate(${d / 3} ${d})">${shape}</g>`;
}

/** Forme en relief : son ombre puis elle-même. */
const lift = (shape, paint, shadow) => `${drop(shape, paint, shadow)}<g ${attrs(paint)}>${shape}</g>`;

const round = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

// ───── Formes partagées ─────

const HANDSET =
  'M35.4 47C39.4 54.6 45.6 60.7 53.2 64.6L58.7 59.1C59.6 58.2 60.9 57.9 62.1 58.3C65.1 59.3 68.3 59.8 71.6 59.8C73.6 59.8 75.3 61.4 75.3 63.4V71.6C75.3 73.6 73.6 75.3 71.6 75.3C46.4 75.3 24.7 53.6 24.7 28.4C24.7 26.4 26.4 24.7 28.4 24.7H36.6C38.6 24.7 40.2 26.4 40.2 28.4C40.2 31.7 40.7 34.9 41.7 37.9C42.1 39.1 41.8 40.4 40.9 41.3Z';

const BUBBLE =
  'M50 23C66 23 79 33.7 79 47C79 60.3 66 71 50 71C46.4 71 43 70.5 39.8 69.5C36 72.6 30.6 75 24.5 75.3C27.4 72.4 29.4 68.8 30 65.4C24.5 61.1 21 54.4 21 47C21 33.7 34 23 50 23Z';

const CLOUD =
  'M31 73C24.9 73 20 68.1 20 62C20 56.1 24.6 51.3 30.4 51C32.2 43.6 38.8 38.5 46.4 38.5C53.3 38.5 59.3 42.8 61.6 49C62.8 48.7 64.1 48.5 65.4 48.5C72.4 48.5 78 54.1 78 61C78 67.6 72.7 73 66.1 73Z';

function gearPath(teeth, outer, inner) {
  const pt = (r, a) => `${(50 + r * Math.cos(a)).toFixed(2)} ${(50 + r * Math.sin(a)).toFixed(2)}`;
  const step = (Math.PI * 2) / teeth;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    d += `${i ? 'L' : 'M'}${pt(inner, a - step * 0.3)}L${pt(outer, a - step * 0.16)}A${outer} ${outer} 0 0 1 ${pt(outer, a + step * 0.16)}`;
    d += `L${pt(inner, a + step * 0.3)}A${inner} ${inner} 0 0 1 ${pt(inner, a + step * 0.7)}`;
  }
  return `${d}Z`;
}

const GEAR = gearPath(8, 33, 26.5);

// Damier discret du plateau de Snake
const CHECKER = Array.from({ length: 64 }, (_, i) => [i % 8, Math.floor(i / 8)])
  .filter(([x, y]) => (x + y) % 2)
  .map(([x, y]) => `M${x * 12.5} ${y * 12.5}h12.5v12.5h-12.5z`)
  .join('');

// ───── Illustrations ─────

const ART = {
  phone: (p) =>
    bg(p, ['#7ef0a0', '#2fce62', '#13a046']) +
    lift(`<path d="${HANDSET}" transform="translate(50 50) scale(1.06) translate(-50 -50)"/>`, { fill: p.lin(['#ffffff', '#e0f7e7'], [0, 25, 0, 75]) }, { shadow: '#06561f', o: 0.28 }),

  messages: (p) =>
    bg(p, ['#86f27f', '#38cf4c', '#17a53a']) +
    lift(`<path d="${BUBBLE}"/>`, { fill: p.lin(['#ffffff', '#e3f8e2'], [0, 23, 0, 75]) }, { shadow: '#0b5a1d', o: 0.28 }) +
    `<g fill="${p.lin(['#4fd968', '#22b142'], [0, 42, 0, 52])}"><circle cx="37.5" cy="47" r="4.6"/><circle cx="50" cy="47" r="4.6"/><circle cx="62.5" cy="47" r="4.6"/></g>`,

  contacts: (p) =>
    bg(p, ['#62e6d6', '#1fb5ad', '#0c878c']) +
    '<rect x="62" y="28" width="15" height="10" rx="3.2" fill="#ff6b6b"/>' +
    '<rect x="62" y="41.5" width="15" height="10" rx="3.2" fill="#ffc23d"/>' +
    '<rect x="62" y="55" width="15" height="10" rx="3.2" fill="#5b8cff"/>' +
    lift('<rect x="23" y="21" width="47" height="58" rx="8"/>', { fill: p.lin(['#ffffff', '#e2f3f1'], [0, 21, 0, 79]) }, { shadow: '#04484a', o: 0.3 }) +
    `<g fill="${p.lin(['#2fc8ba', '#0e8a86'], [0, 32, 0, 72])}"><circle cx="46.5" cy="42" r="9.5"/><path d="M30.5 70.5C30.5 61 37.6 55.5 46.5 55.5S62.5 61 62.5 70.5Q62.5 72.5 60.5 72.5H32.5Q30.5 72.5 30.5 70.5Z"/></g>`,

  camera: (p) => {
    const body = '<rect x="36" y="25" width="25" height="14" rx="4.5"/><rect x="17" y="32" width="66" height="45" rx="11"/>';
    return (
      bg(p, ['#f8f9fb', '#d5d8de', '#a7acb6']) +
      lift(body, { fill: p.lin(['#555a64', '#2b2e35', '#1a1c20'], [0, 25, 0, 77]) }, { o: 0.25 }) +
      `<circle cx="50" cy="55" r="17.5" fill="${p.lin(['#f4f6f9', '#a1a8b3', '#6f7681'], [36, 38, 64, 72])}"/>` +
      '<circle cx="50" cy="55" r="13.6" fill="#101216"/>' +
      `<circle cx="50" cy="55" r="11" fill="${p.rad([['#8da2ff', 0], ['#3b46c4', 0.45], ['#0c0f30', 1]], [45, 50, 15])}"/>` +
      '<ellipse cx="45.4" cy="50.2" rx="3.6" ry="2.5" fill="#fff" opacity=".8" transform="rotate(-35 45.4 50.2)"/>' +
      '<circle cx="55" cy="60" r="1.7" fill="#fff" opacity=".35"/>' +
      `<circle cx="72" cy="41.5" r="3.3" fill="${p.lin(['#fff6d1', '#ffc83d'], [0, 38, 0, 45])}"/>`
    );
  },

  photos: (p) => {
    const colors = ['#ff9f0a', '#ffd60a', '#34c759', '#2fc5d9', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f'];
    const petals = colors.map((c, i) => `<ellipse cx="50" cy="32.6" rx="9.6" ry="16.6" fill="${c}" opacity=".84" transform="rotate(${i * 45} 50 50)"/>`);
    return bg(p, ['#ffffff', '#eff0f4']) + petals.join('');
  },

  // Les graduations et les aiguilles vivantes sont ajoutées par app-icon.js dans .art-dial
  clock: (p) =>
    bg(p, ['#474a53', '#1f2126', '#0f1013']) +
    lift('<circle cx="50" cy="50" r="40"/>', { fill: p.lin(['#ffffff', '#e5e7ec'], [30, 10, 70, 90]) }, { o: 0.45 }) +
    '<g class="art-dial" transform="translate(50 50) scale(.84) translate(-50 -50)"></g>',

  calculator: (p) => {
    const ops = '<path d="M34 24.5V43.5M24.5 34H43.5M56.5 34H75.5M27.3 59.3L40.7 72.7M40.7 59.3L27.3 72.7M56.5 61.5H75.5M56.5 70.5H75.5"/>';
    return bg(p, ['#ffb84d', '#ff8d1f', '#f2610c']) + lift(ops, { fill: 'none', stroke: p.lin(['#ffffff', '#fff1e3'], [0, 24, 0, 76]), 'stroke-width': 7, ...round }, { shadow: '#8a2c00', o: 0.28 });
  },

  notes: (p) => {
    const page = 'M31 22H69Q76 22 76 29V63L63 76H31Q24 76 24 69V29Q24 22 31 22Z';
    return (
      bg(p, ['#ffe88f', '#ffcc33', '#f6aa00']) +
      lift(`<path d="${page}"/>`, { fill: p.lin(['#ffffff', '#fdf5df'], [0, 22, 0, 76]) }, { shadow: '#8a5a00', o: 0.25 }) +
      `<path d="M24 35V29Q24 22 31 22H69Q76 22 76 29V35Z" fill="${p.lin(['#ffc247', '#f59a0b'], [0, 22, 0, 35])}"/>` +
      '<path d="M32 46H68M32 55.5H68M32 65H53" stroke="#e6d39e" stroke-width="3.8" stroke-linecap="round"/>' +
      `<path d="M63 76V68Q63 63 68 63H76Z" fill="${p.lin(['#f6e6b8', '#e0c172'], [63, 63, 72, 74])}"/>`
    );
  },

  // Jour et date remplis par app-icon.js
  calendar: (p) =>
    bg(p, ['#ffffff', '#eef0f4'], [0, 0, 0, 100]) +
    `<rect width="100" height="31" fill="${p.lin(['#ff6b60', '#eb3a30'], [0, 0, 0, 31])}"/>` +
    '<rect y="31" width="100" height="2" fill="#000" opacity=".06"/>' +
    '<text class="art-weekday" x="50" y="21.5" text-anchor="middle" font-size="14" font-weight="700" letter-spacing=".8" fill="#fff"></text>' +
    '<text class="art-date" x="50" y="82" text-anchor="middle" font-size="48" font-weight="400" letter-spacing="-1.5" fill="#1c1c1e"></text>',

  weather: (p) =>
    bg(p, ['#6fcbff', '#3593f5', '#1f60d6']) +
    '<circle cx="61" cy="38" r="20.5" fill="#fff4b0" opacity=".22"/>' +
    `<circle cx="61" cy="38" r="14.5" fill="${p.rad([['#fff8c9', 0], ['#ffd84d', 0.55], ['#ffa424', 1]], [56, 33, 19])}"/>` +
    lift(`<path d="${CLOUD}"/>`, { fill: p.lin(['#ffffff', '#d8e8fb'], [0, 38, 0, 73]) }, { shadow: '#0a3a8c', o: 0.3 }),

  music: (p) => {
    const note =
      '<ellipse cx="35.5" cy="68" rx="10" ry="7.8" transform="rotate(-20 35.5 68)"/><ellipse cx="64.5" cy="62" rx="10" ry="7.8" transform="rotate(-20 64.5 62)"/>' +
      '<rect x="40.2" y="31" width="5.6" height="37" rx="1"/><rect x="69.2" y="25" width="5.6" height="37" rx="1"/><path d="M40.2 29.8L74.8 22.2V32.4L40.2 40Z"/>';
    return bg(p, ['#ff7ea4', '#fb4168', '#df1f4c']) + lift(note, { fill: p.lin(['#ffffff', '#ffe1e9'], [0, 22, 0, 76]) }, { shadow: '#7a0a26', o: 0.28 });
  },

  browser: (p) => {
    const ticks = [0, 90, 180, 270].map((a) => `<path d="M50 22V27.5" transform="rotate(${a} 50 50)"/>`).join('');
    const minor = [45, 135, 225, 315].map((a) => `<path d="M50 23V26.5" transform="rotate(${a} 50 50)"/>`).join('');
    return (
      bg(p, ['#6ad9ff', '#2398ff', '#0b5df0']) +
      lift('<circle cx="50" cy="50" r="31"/>', { fill: p.lin(['#ffffff', '#dbe7f6'], [30, 19, 70, 81]) }, { shadow: '#06307a', o: 0.3 }) +
      `<g stroke="#a3b8d6" stroke-width="3.2" stroke-linecap="round">${ticks}</g>` +
      `<g stroke="#c8d6e8" stroke-width="2.4" stroke-linecap="round">${minor}</g>` +
      drop('<path d="M66.5 33.5L55 55L33.5 66.5L45 45Z"/>', { fill: '#000' }, { shadow: '#06307a', o: 0.2, d: 1.8 }) +
      `<path d="M66.5 33.5L55 55L45 45Z" fill="${p.lin(['#ff7062', '#e2232b'], [55, 35, 50, 55])}"/>` +
      `<path d="M33.5 66.5L45 45L55 55Z" fill="${p.lin(['#d9e1ec', '#93a3bb'], [45, 45, 40, 66])}"/>` +
      '<circle cx="50" cy="50" r="2.4" fill="#fff"/>'
    );
  },

  files: (p) => {
    const back = 'M20 31Q20 25 26 25H39.6Q42.6 25 44.5 27.4L47.4 31H74Q80 31 80 37V68Q80 74 74 74H26Q20 74 20 68Z';
    const front = 'M20 46.5Q20 41 26 41H74Q80 41 80 46.5V69Q80 75 74 75H26Q20 75 20 69Z';
    return (
      bg(p, ['#fbfdff', '#e1e9f6']) +
      lift(`<path d="${back}"/>`, { fill: p.lin(['#3f8ff7', '#1c60d6'], [0, 25, 0, 74]) }, { shadow: '#0b3a8a', o: 0.25 }) +
      '<rect x="26" y="34" width="48" height="22" rx="3" fill="#fff"/>' +
      lift(`<path d="${front}"/>`, { fill: p.lin(['#80c6ff', '#3a8af4'], [0, 41, 0, 75]) }, { shadow: '#0b3a8a', o: 0.22, d: 1.6 }) +
      '<path d="M25 42.6H75" stroke="#fff" stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round"/>'
    );
  },

  settings: (p) => {
    // Le trait arrondit les angles des dents
    const metal = p.lin(['#fdfdfe', '#cfd2d8', '#a2a6af'], [30, 16, 70, 84]);
    return (
      bg(p, ['#b8bbc3', '#80848e', '#565a63']) +
      lift(`<path d="${GEAR}"/>`, { fill: metal, stroke: metal, 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, { shadow: '#22252b', o: 0.3 }) +
      `<circle cx="50" cy="50" r="16.5" fill="${p.lin(['#3b3e45', '#6d717b'], [0, 33, 0, 67])}"/>` +
      lift('<circle cx="50" cy="50" r="9.5"/>', { fill: p.lin(['#f7f8fa', '#b7bbc3'], [0, 40, 0, 60]) }, { shadow: '#111', o: 0.35, d: 1.6 }) +
      '<circle cx="50" cy="50" r="3.6" fill="#4b4f57"/>'
    );
  },

  terminal: (p) => {
    const prompt = '<path d="M30 41L43 52.5L30 64M50 64H69"/>';
    return (
      bg(p, ['#454952', '#1f2227', '#0f1114']) +
      '<circle cx="27" cy="26.5" r="3.4" fill="#ff5f57"/><circle cx="37" cy="26.5" r="3.4" fill="#febc2e"/><circle cx="47" cy="26.5" r="3.4" fill="#28c840"/>' +
      lift(prompt, { fill: 'none', stroke: p.lin(['#a6ffc6', '#2fe07c'], [0, 41, 0, 64]), 'stroke-width': 7.5, ...round }, { o: 0.45 })
    );
  },

  store: (p) => {
    const bag = 'M30.6 36H69.4Q74.6 36 75.1 41.2L77.4 70.6Q78 77 71.6 77H28.4Q22 77 22.6 70.6L24.9 41.2Q25.4 36 30.6 36Z';
    return (
      bg(p, ['#8e95ff', '#5c5ef5', '#3b32c4']) +
      '<path d="M38.5 42V33.5A11.5 11.5 0 0 1 61.5 33.5V42" fill="none" stroke="#fff" stroke-opacity=".92" stroke-width="5.4" stroke-linecap="round"/>' +
      lift(`<path d="${bag}"/>`, { fill: p.lin(['#ffffff', '#e1e3ff'], [0, 36, 0, 77]) }, { shadow: '#1d1670', o: 0.3 }) +
      '<circle cx="38.5" cy="43" r="2.4" fill="#b7b9f2"/><circle cx="61.5" cy="43" r="2.4" fill="#b7b9f2"/>' +
      `<path d="M50 46Q51.8 55.4 61.5 57.5Q51.8 59.6 50 69Q48.2 59.6 38.5 57.5Q48.2 55.4 50 46Z" fill="${p.lin(['#ffa25a', '#ff4d8d', '#a855f7'], [42, 46, 58, 69])}"/>`
    );
  },

  game2048: (p) => {
    const tiles = [
      [22, 22, '#f8efe5', '#776e65', '2'],
      [52, 22, '#f5b47c', '#fff', '0'],
      [22, 52, '#f6795c', '#fff', '4'],
      [52, 52, '#eec53c', '#fff', '8'],
    ];
    const shapes = tiles.map(([x, y]) => `<rect x="${x}" y="${y}" width="26" height="26" rx="5.5"/>`).join('');
    return (
      bg(p, ['#d9c7b1', '#baa48b', '#947d66']) +
      drop(shapes, { fill: '#000' }, { shadow: '#4a3828', o: 0.3 }) +
      tiles.map(([x, y, fill, ink, digit]) => `<rect x="${x}" y="${y}" width="26" height="26" rx="5.5" fill="${fill}"/><text x="${x + 13}" y="${y + 20}" text-anchor="middle" font-size="20" font-weight="800" fill="${ink}">${digit}</text>`).join('')
    );
  },

  snake: (p) => {
    const body = '<path d="M25 71H53C61 71 65 66.5 65 60.5S61 50 53 50H45C37 50 33 45.5 33 39.5S37 29 45 29H57"/>';
    const green = p.lin(['#4fd35a', '#d2fb7a'], [25, 71, 60, 29]);
    return (
      bg(p, ['#24573f', '#133426', '#08180f']) +
      `<path d="${CHECKER}" fill="#fff" opacity=".035"/>` +
      drop(body, { fill: 'none', stroke: '#000', 'stroke-width': 11, ...round }, { o: 0.4 }) +
      `<g fill="none" stroke="${green}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">${body}</g>` +
      `<circle cx="59.5" cy="29" r="8" fill="${green}"/>` +
      '<circle cx="61.5" cy="26" r="2.4" fill="#fff"/><circle cx="62.2" cy="26" r="1.2" fill="#13203d"/>' +
      `<circle cx="76" cy="31" r="5.8" fill="${p.rad([['#ff8a80', 0], ['#ff3b30', 0.6], ['#c81d14', 1]], [74, 29, 8])}"/>` +
      '<path d="M76 25.5Q77.5 21.5 81 21.5Q80 25 76 25.5Z" fill="#6ee05a"/>'
    );
  },

  paint: (p) => {
    const palette =
      'M50 22C67.5 22 80 33 80 47.5C80 56 74.6 60.4 68.4 59.4C63.5 58.6 60.2 61.6 61.6 66.4C63.2 72 59.5 78 51 78C33.5 78 20 65.5 20 49.5C20 34 33.4 22 50 22Z' +
      'M70 42.5a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0Z';
    return (
      bg(p, ['#ffa0d6', '#e45fd5', '#9147ef'], [20, 0, 80, 100]) +
      lift(`<path d="${palette}" fill-rule="evenodd"/>`, { fill: p.lin(['#fffaf2', '#efdcc2'], [30, 22, 70, 78]) }, { shadow: '#4a0f70', o: 0.3 }) +
      '<circle cx="35" cy="45" r="6" fill="#ff4757"/><circle cx="48.5" cy="33.5" r="6" fill="#ffc312"/><circle cx="34.5" cy="60.5" r="6" fill="#2e86ff"/><circle cx="48.5" cy="68" r="5.6" fill="#2ed573"/>'
    );
  },

  recorder: (p) => {
    const mic = '<rect x="39" y="19" width="22" height="39" rx="11"/>';
    const stand = '<path d="M30 49A20 20 0 0 0 70 49M50 69V79M41 79H59"/>';
    const white = p.lin(['#ffffff', '#ffe0e3'], [0, 19, 0, 80]);
    return (
      bg(p, ['#ff8080', '#f03c4c', '#c21a38']) +
      lift(stand, { fill: 'none', stroke: white, 'stroke-width': 5.6, ...round }, { shadow: '#6b0016', o: 0.28 }) +
      lift(mic, { fill: white }, { shadow: '#6b0016', o: 0.28 }) +
      '<path d="M44 30H56M44 37H56M44 44H56" stroke="#f3a3ac" stroke-width="2.8" stroke-linecap="round"/>'
    );
  },
};

/** Illustration d'une app (élément <svg>), ou null si elle n'en a pas. */
export function appArt(id) {
  const draw = ART[id];
  if (!draw) return null;
  const p = painter();
  const body = draw(p);
  const template = document.createElement('template');
  template.innerHTML = `<svg class="app-art" viewBox="0 0 100 100" aria-hidden="true"><defs>${p.defs.join('')}</defs>${body}</svg>`;
  return template.content.firstElementChild;
}
