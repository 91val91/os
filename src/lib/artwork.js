/**
 * Génération procédurale d'images vectorielles (SVG) : paysages pour les
 * photos d'exemple, pochettes d'albums. Aucune ressource externe.
 */
export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKIES = [
  ['#ff9a8b', '#ff6a88', '#ffcf91'], // coucher de soleil
  ['#1e3c72', '#2a5298', '#7aa7e8'], // crépuscule bleu
  ['#f6d365', '#fda085', '#fbe3b5'], // aube dorée
  ['#0f2027', '#203a43', '#2c5364'], // nuit
  ['#a1c4fd', '#c2e9fb', '#e0f4ff'], // ciel clair
  ['#654ea3', '#da98b4', '#f6c8d1'], // lavande
];

const HILLS = [
  ['#2d3a4a', '#3d5068', '#55708f'],
  ['#1f4037', '#2e6b57', '#4c9a7a'],
  ['#3b2c4f', '#5b4475', '#8a6aa8'],
  ['#4a2c2a', '#7a4636', '#b06a4c'],
];

function ridge(random, width, height, base, amplitude, steps = 9) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    const y = base - random() * amplitude;
    points.push([x, y]);
  }
  let d = `M0 ${height} L0 ${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const cx = (px + x) / 2;
    d += ` Q${px.toFixed(1)} ${py.toFixed(1)} ${cx.toFixed(1)} ${((py + y) / 2).toFixed(1)}`;
  }
  d += ` L${width} ${points.at(-1)[1].toFixed(1)} L${width} ${height} Z`;
  return d;
}

export function landscapeSVG(seed, { width = 1200, height = 900 } = {}) {
  const random = mulberry32(typeof seed === 'number' ? seed : hashString(String(seed)));
  const sky = SKIES[Math.floor(random() * SKIES.length)];
  const hills = HILLS[Math.floor(random() * HILLS.length)];
  const night = sky === SKIES[3];
  const sunX = width * (0.2 + random() * 0.6);
  const sunY = height * (0.25 + random() * 0.2);
  const stars = night
    ? Array.from({ length: 60 }, () => `<circle cx="${(random() * width).toFixed(0)}" cy="${(random() * height * 0.6).toFixed(0)}" r="${(random() * 1.8 + 0.4).toFixed(1)}" fill="#fff" opacity="${(random() * 0.6 + 0.3).toFixed(2)}"/>`).join('')
    : '';
  const layers = hills
    .map((color, i) => `<path d="${ridge(random, width, height, height * (0.55 + i * 0.13), height * (0.18 - i * 0.03))}" fill="${color}"/>`)
    .reverse()
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset=".6" stop-color="${sky[1]}"/><stop offset="1" stop-color="${sky[2]}"/></linearGradient>
<radialGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="${width}" height="${height}" fill="url(#s)"/>${stars}
<circle cx="${sunX.toFixed(0)}" cy="${sunY.toFixed(0)}" r="${(height * 0.22).toFixed(0)}" fill="url(#g)" opacity=".55"/>
<circle cx="${sunX.toFixed(0)}" cy="${sunY.toFixed(0)}" r="${(height * 0.07).toFixed(0)}" fill="${night ? '#f4f1de' : '#fff7e0'}"/>
${layers}</svg>`;
}

export function albumArtSVG(seed, size = 400) {
  const random = mulberry32(hashString(String(seed)));
  const hue = Math.floor(random() * 360);
  const hue2 = (hue + 40 + random() * 120) % 360;
  const shapes = Array.from({ length: 5 }, () => {
    const r = (0.1 + random() * 0.35) * size;
    return `<circle cx="${(random() * size).toFixed(0)}" cy="${(random() * size).toFixed(0)}" r="${r.toFixed(0)}" fill="hsl(${((hue + random() * 90) % 360).toFixed(0)} 80% 65%)" opacity="${(0.25 + random() * 0.4).toFixed(2)}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 45%)"/><stop offset="1" stop-color="hsl(${hue2.toFixed(0)} 75% 25%)"/></linearGradient></defs><rect width="${size}" height="${size}" fill="url(#a)"/>${shapes}</svg>`;
}

export function svgToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
