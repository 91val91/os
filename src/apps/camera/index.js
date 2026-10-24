/**
 * Appareil photo : flux de la caméra (getUserMedia) avec filtres, formats
 * 9:16, photo et carré, caméra avant/arrière, retardateur. Les préférences
 * (qualité, format, grille, miroir, son…) se règlent dans Réglages →
 * Appareil photo. Sans caméra, une scène simulée animée permet quand même
 * de prendre des photos.
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

const MODES = [
  { id: 'wide', label: '9:16', ratio: 9 / 16 },
  { id: 'photo', label: 'PHOTO', ratio: 3 / 4 },
  { id: 'square', label: 'CARRÉ', ratio: 1 },
];

/** Qualité : plus grand côté de la photo, compression JPEG et résolution demandée à la caméra. */
const QUALITY = {
  high: { max: 2560, jpeg: 0.92, ideal: [2560, 1920] },
  standard: { max: 1440, jpeg: 0.86, ideal: [1920, 1440] },
  compact: { max: 1080, jpeg: 0.72, ideal: [1280, 960] },
};
const TIMERS = [0, 3, 10];

export function mount(root, ctx) {
  const setting = (key) => ctx.settings.get(`camera.${key}`);
  // « Conserver les réglages » : format, filtre et caméra de la dernière ouverture.
  const kept = setting('preserve') ? ctx.storage.get('last', {}) : {};
  let facing = ctx.intent?.data?.facing ?? kept.facing ?? 'environment';
  let mode = MODES.some((m) => m.id === kept.mode) ? kept.mode : setting('format');
  let filter = FILTERS.find((f) => f.id === kept.filter) ?? FILTERS[0];
  let flash = false;
  let countdown = null;
  let stream = null;
  let simulated = false;
  let simFrame = null;
  let lastPhoto = latestPhoto();

  const video = h('video.cam-video', { autoplay: true, muted: true, playsInline: true });
  video.setAttribute('playsinline', '');
  const sim = h('canvas.cam-sim', { width: 720, height: 960 });
  const countdownEl = h('div.cam-countdown');
  const viewfinder = h('div.cam-viewfinder', video, sim, h('div.cam-grid'), h('div.cam-flash'), countdownEl);
  const notice = h('div.cam-notice');
  const thumb = h('button.cam-thumb', { type: 'button', 'aria-label': 'Dernière photo', onclick: openLast });
  const filterBar = h('div.cam-filters');
  const flashBtn = h('button.cam-top-btn', { type: 'button', 'aria-label': 'Flash', onclick: () => { flash = !flash; flashBtn.classList.toggle('on', flash); } }, icon('bolt', { size: 20 }));
  const timerBtn = h('button.cam-top-btn.cam-timer-btn', { type: 'button', 'aria-label': 'Retardateur', onclick: cycleTimer });
  const filterBtn = h('button.cam-top-btn', { type: 'button', 'aria-label': 'Filtres', onclick: () => root.classList.toggle('show-filters') }, icon('sparkles', { size: 20 }));
  const settingsBtn = h('button.cam-top-btn', { type: 'button', 'aria-label': 'Réglages de l\'appareil photo', onclick: () => ctx.startActivity({ app: 'settings', action: 'view', data: { page: 'camera' } }) }, icon('settings', { size: 20 }));
  const modes = h(
    'div.cam-modes',
    MODES.map((m) => h(`button${m.id === mode ? '.active' : ''}`, { type: 'button', dataset: { mode: m.id }, onclick: () => setMode(m.id) }, m.label)),
  );

  root.classList.add('camera');
  root.append(
    h('div.cam-top', flashBtn, timerBtn, notice, filterBtn, settingsBtn),
    viewfinder,
    filterBar,
    h(
      'div.cam-bottom',
      modes,
      h(
        'div.cam-controls',
        thumb,
        h('button.cam-shutter', { type: 'button', 'aria-label': 'Prendre une photo', onclick: shoot }, h('span')),
        h('button.cam-flip', { type: 'button', 'aria-label': 'Changer de caméra', onclick: flip }, icon('refresh', { size: 24 })),
      ),
    ),
  );

  function renderFilters() {
    filterBar.replaceChildren(
      ...FILTERS.map((f) =>
        h(`button.cam-filter${f.id === filter.id ? '.active' : ''}`, { type: 'button', onclick: () => { filter = f; applyFilter(); renderFilters(); remember(); } }, h('span.cam-filter-swatch', { style: { filter: f.css } }), f.label),
      ),
    );
  }

  function applyFilter() {
    viewfinder.style.setProperty('--filter', filter.css);
  }

  function setMode(m) {
    mode = m;
    viewfinder.classList.toggle('square', m === 'square');
    root.classList.toggle('wide', m === 'wide');
    modes.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    remember();
  }

  /** Mémorise la dernière utilisation (appliquée à l'ouverture si « Conserver les réglages »). */
  function remember() {
    ctx.storage.set('last', { mode, filter: filter.id, facing });
  }

  /** Grille, retardateur : suivent les Réglages, même modifiés pendant que l'app est ouverte. */
  function applySettings() {
    viewfinder.classList.toggle('no-grid', !setting('grid'));
    const seconds = setting('timer');
    timerBtn.classList.toggle('on', seconds > 0);
    timerBtn.replaceChildren(...[icon('timer', { size: 18 }), seconds ? h('span', `${seconds}s`) : null].filter(Boolean));
  }

  function cycleTimer() {
    const next = TIMERS[(TIMERS.indexOf(setting('timer')) + 1) % TIMERS.length];
    ctx.settings.set('camera.timer', next);
    ctx.ui.toast(next ? `Retardateur : ${next} secondes` : 'Retardateur désactivé');
  }

  /** Déclencheur : tout de suite, ou après le compte à rebours (un nouvel appui l'annule). */
  function shoot() {
    if (countdown) return cancelCountdown();
    let left = setting('timer');
    if (!left) return capture();
    const tick = () => {
      if (!left) {
        cancelCountdown();
        if (ctx.foreground) capture();
        return;
      }
      countdownEl.textContent = String(left);
      countdownEl.classList.add('visible');
      animate(countdownEl, [{ transform: 'scale(1.4)', opacity: 0.4 }, { transform: 'scale(1)', opacity: 1 }], { duration: 300 });
      ctx.sound.volumeTick();
      left--;
    };
    tick();
    countdown = setInterval(tick, 1000);
  }

  function cancelCountdown() {
    clearInterval(countdown);
    countdown = null;
    countdownEl.classList.remove('visible');
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
      const [width, height] = (QUALITY[setting('quality')] ?? QUALITY.standard).ideal;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: width }, height: { ideal: height } }, audio: false });
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
    cancelCountdown();
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
    remember();
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
    // Recadrage centré au format choisi (9:16, 3:4 ou 1:1).
    const ratio = MODES.find((m) => m.id === mode)?.ratio ?? 3 / 4;
    const quality = QUALITY[setting('quality')] ?? QUALITY.standard;
    let cw = sw;
    let ch = sw / ratio;
    if (ch > sh) {
      ch = sh;
      cw = sh * ratio;
    }
    const scale = Math.min(1, quality.max / Math.max(cw, ch));
    const canvas = h('canvas', { width: Math.round(cw * scale), height: Math.round(ch * scale) });
    const g = canvas.getContext('2d');
    g.filter = filter.css;
    // Selfie : enregistré comme dans le viseur (miroir) sauf si désactivé dans les Réglages.
    if (!simulated && facing === 'user' && setting('mirror')) {
      g.translate(canvas.width, 0);
      g.scale(-1, 1);
    }
    g.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', quality.jpeg);

    if (setting('shutterSound')) ctx.sound.shutter();
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
  applyFilter();
  setMode(mode);
  applySettings();
  for (const key of ['grid', 'timer']) ctx.settings.watch(`camera.${key}`, applySettings);
  // Nouveau format par défaut choisi dans les Réglages : appliqué tout de suite (sauf « Conserver »).
  ctx.settings.watch('camera.format', (value) => {
    if (!setting('preserve') && MODES.some((m) => m.id === value)) setMode(value);
  });
  // Appareil verrouillé pendant le compte à rebours : pas de photo derrière l'écran verrouillé.
  ctx.subscribe('device:lock', cancelCountdown);
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
    onResume: () => {
      applySettings();
      start();
    },
    onDestroy: stop,
    onIntent: (intent) => {
      if (intent?.data?.facing && intent.data.facing !== facing) flip();
    },
  };
}
