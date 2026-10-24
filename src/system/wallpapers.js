/**
 * Fonds d'écran fournis (dégradés CSS, aucune image externe).
 */
import { landscapeSVG, svgToDataUrl } from '../lib/artwork.js';

export const WALLPAPERS = [
  {
    id: 'aurora',
    name: 'Aurore',
    css: 'radial-gradient(120% 80% at 15% 10%, #ff6ec4aa 0, transparent 55%), radial-gradient(90% 70% at 90% 25%, #7873f5 0, transparent 60%), radial-gradient(120% 70% at 50% 100%, #22d3ee99 0, transparent 60%), linear-gradient(165deg, #312e81, #0f172a 70%)',
  },
  {
    id: 'sunset',
    name: 'Crépuscule',
    css: 'radial-gradient(100% 60% at 50% 110%, #ffd166 0, transparent 60%), linear-gradient(180deg, #2b1055 0%, #7597de 45%, #ff7e5f 80%, #feb47b 100%)',
  },
  {
    id: 'ocean',
    name: 'Océan',
    css: 'radial-gradient(90% 60% at 80% 0%, #67e8f9 0, transparent 60%), radial-gradient(80% 60% at 0% 100%, #1d4ed8 0, transparent 60%), linear-gradient(170deg, #0ea5e9, #0c4a6e)',
  },
  {
    id: 'forest',
    name: 'Forêt',
    css: 'radial-gradient(100% 70% at 20% 0%, #bef264aa 0, transparent 55%), radial-gradient(90% 60% at 100% 100%, #065f46 0, transparent 60%), linear-gradient(160deg, #15803d, #052e16)',
  },
  {
    id: 'nebula',
    name: 'Nébuleuse',
    css: 'radial-gradient(60% 40% at 30% 30%, #f0abfc88 0, transparent 70%), radial-gradient(70% 50% at 70% 70%, #818cf888 0, transparent 70%), radial-gradient(1px 1px at 20% 80%, #fff 0, transparent 100%), linear-gradient(180deg, #020617, #1e1b4b)',
  },
  {
    id: 'dune',
    name: 'Dune',
    css: 'radial-gradient(130% 70% at 50% 120%, #b45309 0, transparent 60%), radial-gradient(120% 60% at 10% 90%, #f59e0b 0, transparent 60%), linear-gradient(180deg, #fde68a, #fb923c 60%, #9a3412)',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    css: 'radial-gradient(100% 60% at 50% 0%, #52525b 0, transparent 70%), linear-gradient(180deg, #27272a, #09090b)',
  },
  {
    id: 'pastel',
    name: 'Pastel',
    css: 'radial-gradient(80% 60% at 0% 0%, #fbcfe8 0, transparent 60%), radial-gradient(80% 60% at 100% 30%, #bfdbfe 0, transparent 60%), radial-gradient(90% 60% at 30% 100%, #bbf7d0 0, transparent 60%), linear-gradient(180deg, #fef3c7, #e9d5ff)',
  },
  {
    id: 'landscape',
    name: 'Paysage',
    css: null, // généré à la demande
  },
];

let landscapeCache = null;

/** Valeur CSS `background` d'un fond d'écran (préréglage ou chemin VFS). */
export function wallpaperCss(id, fs) {
  if (id === 'landscape') {
    landscapeCache ??= `center / cover no-repeat url("${svgToDataUrl(landscapeSVG(424242, { width: 900, height: 1950 }))}")`;
    return landscapeCache;
  }
  const preset = WALLPAPERS.find((w) => w.id === id);
  if (preset) return preset.css;
  if (typeof id === 'string' && id.startsWith('/') && fs?.exists(id)) {
    return `center / cover no-repeat url("${fs.readFile(id)}")`;
  }
  return WALLPAPERS[0].css;
}
