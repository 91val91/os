/**
 * Appareil photo : flux de la caméra (getUserMedia) avec filtres, formats
 * photo/carré, caméra avant/arrière. Sans caméra, une scène simulée
 * animée permet quand même de prendre des photos.
 */
import { h, animate } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { pad2 } from '../../lib/format.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const FILTERS = [
  { id: 'none', label: 'Original', css: 'none' },
  { id: 'vivid', label: 'Éclatant', css: 'saturate(1.5) contrast(1.08)' },
  { id: 'mono', label: 'Noir et blanc', css: 'grayscale(1) contrast(1.1)' },
  { id: 'sepia', label: 'Sépia', css: 'sepia(.8) contrast(1.05)' },
  { id: 'cool', label: 'Froid', css: 'saturate(1.1) hue-rotate(-15deg) brightness(1.05)' },
  { id: 'warm', label: 'Chaud', css: 'sepia(.25) saturate(1.3) brightness(1.04)' },
];

export function mount(root, ctx) {
  let facing = ctx.intent?.data?.facing ?? 'environment';
  let mode = 'photo';
  let filter = FILTERS[0];
  let flash = false;
  let stream = null;
  let simulated = false;
  let simFrame = null;
  let lastPhoto = latestPhoto();

  const video = h('video.cam-video', { autoplay: true, muted: true, playsInline: true });
  video.setAttribute('playsinline', '');
  const sim = h('canvas.cam-sim', { width: 720, height: 960 });
  const viewfinder = h('div.cam-viewfinder', video, sim, h('div.cam-grid'), h('div.cam-flash'));
  const notice = h('div.cam-notice');
  const thumb = h('button.cam-thumb', { type: 'button', 'aria-label': 'Dernière photo', onclick: openLast });
  const filterBar = h('div.cam-filters');
  const flashBtn = h('button.cam-top-btn', { type: 'button', 'aria-label': 'Flash', onclick: () => { flash = !flash; flashBtn.classList.toggle('on', flash); } }, icon('bolt', { size: 20 }));
  const filterBtn = h('button.cam-top-btn', { type: 'button', 'aria-label': 'Filtres', onclick: () => root.classList.toggle('show-filters') }, icon('sparkles', { size: 20 }));
  const modes = h(
    'div.cam-modes',
    ['photo', 'square'].map((m) => h(`button${m === mode ? '.active' : ''}`, { type: 'button', dataset: { mode: m }, onclick: () => setMode(m) }, m === 'photo' ? 'PHOTO' : 'CARRÉ')),
  );

  root.classList.add('camera');
  root.append(
    h('div.cam-top', flashBtn, notice, filterBtn),
    viewfinder,
    filterBar,
    h(
      'div.cam-bottom',
      modes,
      h(
        'div.cam-controls',
        thumb,
        h('button.cam-shutter', { type: 'button', 'aria-label': 'Prendre une photo', onclick: capture }, h('span')),
        h('button.cam-flip', { type: 'button', 'aria-label': 'Changer de caméra', onclick: flip }, icon('refresh', { size: 24 })),
      ),
    ),
  );

  function renderFilters() {
    filterBar.replaceChildren(
      ...FILTERS.map((f) =>
        h(`button.cam-filter${f.id === filter.id ? '.active' : ''}`, { type: 'button', onclick: () => { filter = f; viewfinder.style.setProperty('--filter', f.css); renderFilters(); } }, h('span.cam-filter-swatch', { style: { filter: f.css } }), f.label),
      ),
    );
  }

  function setMode(m) {
    mode = m;
    viewfinder.classList.toggle('square', m === 'square');
    modes.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  }

  function latestPhoto() {
    const dir = '/home/Photos';
    if (!ctx.fs.exists(dir)) return null;
    return ctx.fs.readdir(dir).filter((e) => e.mime?.startsWith('image/')).sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;
  }

  function renderThumb() {
    thumb.style.backgroundImage = lastPhoto && ctx.fs.exists(lastPhoto) ? `url("${ctx.fs.readFile(lastPhoto)}")` : '';
  }

  async function start() {
    stop();
    const allowed = await ctx.requestPermission('camera');
    if (!allowed) {
      startSimulation('Accès à la caméra refusé — scène simulée');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      startSimulation('Aucune caméra disponible — scène simulée');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      if (!ctx.foreground) {
        stop();
        return;
      }
      simulated = false;
      video.srcObject = stream;
      video.classList.toggle('mirror', facing === 'user');
      root.classList.remove('simulated');
      notice.textContent = '';
    } catch {
      startSimulation('Caméra indisponible — scène simulée');
    }
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    cancelAnimationFrame(simFrame);
    simFrame = null;
  }

  /** Scène animée de remplacement (paysage avec soleil et nuages). */
  function startSimulation(message) {
    simulated = true;
    root.classList.add('simulated');
    notice.textContent = message;
    const g = sim.getContext('2d');
    const t0 = performance.now();
    const draw = (now) => {
      const t = (now - t0) / 1000;
      const { width: w, height: hgt } = sim;
      const sky = g.createLinearGradient(0, 0, 0, hgt);
      sky.addColorStop(0, '#4a90e2');
      sky.addColorStop(0.6, '#a3d5ff');
      sky.addColorStop(1, '#ffe6b3');
      g.fillStyle = sky;
      g.fillRect(0, 0, w, hgt);
      g.fillStyle = '#fff6c2';
      g.beginPath();
      g.arc(w * 0.72, hgt * 0.22, 60, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,.9)';
      for (let i = 0; i < 3; i++) {
        const x = ((t * (20 + i * 12) + i * 260) % (w + 300)) - 150;
        const y = 120 + i * 90;
        g.beginPath();
        g.ellipse(x, y, 90, 30, 0, 0, Math.PI * 2);
        g.ellipse(x + 50, y - 18, 60, 30, 0, 0, Math.PI * 2);
        g.fill();
      }
      const layers = [['#5b8c5a', 0.62, 40], ['#3e6b48', 0.72, 60], ['#2c4a36', 0.84, 30]];
      for (const [color, base, amp] of layers) {
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(0, hgt);
        for (let x = 0; x <= w; x += 20) g.lineTo(x, hgt * base - Math.sin(x / 90 + base * 10) * amp - Math.cos(x / 37) * 8);
        g.lineTo(w, hgt);
        g.fill();
      }
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.font = '600 26px system-ui';
      g.fillText(new Date().toLocaleTimeString('fr-FR'), 24, hgt - 28);
      simFrame = requestAnimationFrame(draw);
    };
    simFrame = requestAnimationFrame(draw);
  }

  async function flip() {
    facing = facing === 'user' ? 'environment' : 'user';
    await animate(viewfinder, [{ transform: 'rotateY(0)' }, { transform: 'rotateY(90deg)' }], { duration: 160 });
    await start();
    animate(viewfinder, [{ transform: 'rotateY(-90deg)' }, { transform: 'rotateY(0)' }], { duration: 160 });
  }

  async function capture() {
    const source = simulated ? sim : video;
    const sw = simulated ? sim.width : video.videoWidth;
    const sh = simulated ? sim.height : video.videoHeight;
    if (!sw || !sh) {
      ctx.ui.toast('Caméra en cours de démarrage…');
      return;
    }
    // Recadrage 3:4 (photo) ou 1:1 (carré), centré.
    const ratio = mode === 'square' ? 1 : 3 / 4;
    let cw = sw;
    let ch = sw / ratio;
    if (ch > sh) {
      ch = sh;
      cw = sh * ratio;
    }
    const scale = Math.min(1, 1440 / Math.max(cw, ch));
    const canvas = h('canvas', { width: Math.round(cw * scale), height: Math.round(ch * scale) });
    const g = canvas.getContext('2d');
    g.filter = filter.css;
    if (!simulated && facing === 'user') {
      g.translate(canvas.width, 0);
      g.scale(-1, 1);
    }
    g.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.86);

    ctx.sound.shutter();
    ctx.ui.vibrate(15);
    const flashEl = viewfinder.querySelector('.cam-flash');
    animate(flashEl, [{ opacity: flash ? 1 : 0.75 }, { opacity: 0 }], { duration: flash ? 450 : 220 });

    const now = new Date();
    const name = `IMG_${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}.jpg`;
    const path = ctx.fs.uniquePath(`/home/Photos/${name}`);
    try {
      ctx.fs.writeFile(path, data, { mime: 'image/jpeg', parents: true });
    } catch (error) {
      ctx.ui.alert({ title: 'Enregistrement impossible', message: error.message });
      return;
    }
    lastPhoto = path;
    renderThumb();
    animate(thumb, [{ transform: 'scale(.6)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1.3)' });
    if (ctx.forResult) setTimeout(() => ctx.finish({ path }), 300);
  }

  function openLast() {
    if (lastPhoto && ctx.fs.exists(lastPhoto)) ctx.startActivity({ app: 'photos', action: 'view', type: 'image/jpeg', data: { path: lastPhoto } });
  }

  renderFilters();
  renderThumb();
  start();
  ctx.subscribe('fs:change', ({ path }) => {
    if (path.startsWith('/home/Photos')) {
      if (lastPhoto && !ctx.fs.exists(lastPhoto)) lastPhoto = latestPhoto();
      renderThumb();
    }
  });

  return {
    onPause: stop,
    onResume: () => start(),
    onDestroy: stop,
    onIntent: (intent) => {
      if (intent?.data?.facing && intent.data.facing !== facing) flip();
    },
  };
}
