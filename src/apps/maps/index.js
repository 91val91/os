/**
 * Plans : carte OpenStreetMap, position en direct (GPS du téléphone, ou
 * récepteur GPS d'Orion installé), recherche de lieux, itinéraires et
 * enregistrement de trajets (fichiers GPX dans Documents/Trajets).
 *
 * Services ouverts utilisés à la demande de l'utilisateur :
 * tuiles OpenStreetMap et OpenTopoMap, recherche Nominatim, itinéraires
 * OSRM (routing.openstreetmap.de). Les mentions de source restent affichées.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { spinner, segmented } from '../../lib/ui.js';
import { formatDuration } from '../../lib/format.js';
import { distance, formatCoordinates, toGpx } from '../../kernel/location.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const TILE = 256;
const MIN_ZOOM = 2;
const LAYERS = {
  plan: {
    label: 'Plan',
    max: 19,
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    credit: '© les contributeurs d\'OpenStreetMap',
    link: 'https://www.openstreetmap.org/copyright',
  },
  relief: {
    label: 'Relief',
    max: 17,
    url: (z, x, y) => `https://${'abc'[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`,
    credit: '© OpenStreetMap · SRTM · OpenTopoMap (CC-BY-SA)',
    link: 'https://opentopomap.org/about',
  },
};
const PROFILES = { car: { label: 'Voiture', server: 'routed-car' }, bike: { label: 'Vélo', server: 'routed-bike' }, foot: { label: 'À pied', server: 'routed-foot' } };
const TRIPS = '/home/Documents/Trajets';
const PARIS = { lat: 48.8566, lon: 2.3522 };

// ───────────── Projection de Mercator (Web) ─────────────

const worldSize = (zoom) => TILE * 2 ** zoom;
const clampLat = (lat) => Math.max(-85.05, Math.min(85.05, lat));

export function project({ lat, lon }, zoom) {
  const size = worldSize(zoom);
  const sin = Math.sin((clampLat(lat) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

export function unproject({ x, y }, zoom) {
  const size = worldSize(zoom);
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lon = ((((x / size) * 360 - 180 + 180) % 360) + 360) % 360 - 180;
  return { lat: clampLat((180 / Math.PI) * Math.atan(Math.sinh(n))), lon };
}

const metersPerPixel = (lat, zoom) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

export const formatDistance = (meters) => (meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0).replace('.', ',')} km`);

function formatTravel(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** Points d'un fichier GPX (trkpt, ou rtept/wpt à défaut). */
export function parseGpx(text) {
  const points = [];
  const re = /<(trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const match of String(text).matchAll(re)) {
    const body = match[4] ?? '';
    const time = /<time>([^<]+)<\/time>/.exec(body)?.[1];
    const ele = /<ele>([^<]+)<\/ele>/.exec(body)?.[1];
    points.push({ lat: Number(match[2]), lon: Number(match[3]), time: time ? Date.parse(time) : null, alt: ele ? Number(ele) : null });
  }
  // Attributs dans l'ordre lon puis lat.
  if (!points.length) {
    for (const match of String(text).matchAll(/<(?:trkpt|rtept)\b[^>]*?\blon="([-\d.]+)"[^>]*?\blat="([-\d.]+)"/g)) points.push({ lat: Number(match[2]), lon: Number(match[1]), time: null, alt: null });
  }
  return points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

const pathLength = (points) => points.reduce((sum, p, i) => (i ? sum + distance(points[i - 1], p) : 0), 0);

// ───────────── Carte ─────────────

function createMap(el, { center, zoom, layer, onUserMove, onLongPress, onDraw }) {
  const tiles = h('div.map-tiles');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('map-lines');
  const overlay = h('div.map-overlay');
  el.append(tiles, svg, overlay);
  const state = { center, zoom, layer };
  const images = new Map(); // clé → img
  let frame = 0;

  const size = () => ({ w: el.clientWidth, h: el.clientHeight });
  const maxZoom = () => LAYERS[state.layer].max;

  function toScreen(pos, zoom = state.zoom) {
    const p = project(pos, zoom);
    const c = project(state.center, zoom);
    const { w, h: height } = size();
    // Monde qui se répète en longitude : on prend la copie la plus proche du centre.
    const world = worldSize(zoom);
    let dx = p.x - c.x;
    if (dx > world / 2) dx -= world;
    if (dx < -world / 2) dx += world;
    return { x: dx + w / 2, y: p.y - c.y + height / 2 };
  }

  function fromScreen(x, y) {
    const c = project(state.center, state.zoom);
    const { w, h: height } = size();
    return unproject({ x: c.x + x - w / 2, y: c.y + y - height / 2 }, state.zoom);
  }

  function place(img) {
    const { z, tx, ty } = img;
    const { w, h: height } = size();
    const scale = 2 ** (state.zoom - z);
    const c = project(state.center, z);
    img.style.transform = `translate3d(${(tx * TILE - c.x) * scale + w / 2}px, ${(ty * TILE - c.y) * scale + height / 2}px, 0) scale(${scale})`;
  }

  function draw() {
    frame = 0;
    const { w, h: height } = size();
    if (!w || !height) return;
    const L = LAYERS[state.layer];
    const z = Math.max(0, Math.min(L.max, Math.round(state.zoom)));
    const scale = 2 ** (state.zoom - z);
    const c = project(state.center, z);
    const n = 2 ** z;
    const x0 = Math.floor((c.x - w / 2 / scale) / TILE);
    const x1 = Math.floor((c.x + w / 2 / scale) / TILE);
    const y0 = Math.max(0, Math.floor((c.y - height / 2 / scale) / TILE));
    const y1 = Math.min(n - 1, Math.floor((c.y + height / 2 / scale) / TILE));
    const wanted = new Set();
    let pending = 0;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const key = `${state.layer}/${z}/${tx}/${ty}`;
        wanted.add(key);
        let img = images.get(key);
        if (!img) {
          img = new Image();
          img.className = 'map-tile';
          img.alt = '';
          img.draggable = false;
          img.decoding = 'async';
          Object.assign(img, { z, tx, ty });
          img.onload = () => {
            img.classList.add('loaded');
            schedule();
          };
          img.onerror = () => img.classList.add('failed');
          img.src = L.url(z, wx, ty);
          tiles.append(img);
          images.set(key, img);
        }
        if (!img.complete) pending++;
        img.classList.remove('stale');
        place(img);
      }
    }
    // Les tuiles d'un autre niveau restent dessous tant que les nouvelles chargent (pas de flash).
    for (const [key, img] of images) {
      if (wanted.has(key)) continue;
      const sameLevel = img.z === z && key.startsWith(`${state.layer}/`);
      if (sameLevel || !pending || !img.classList.contains('loaded')) {
        img.remove();
        images.delete(key);
      } else {
        img.classList.add('stale');
        place(img);
      }
    }
    svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
    onDraw?.();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function setView({ center: c = state.center, zoom: z = state.zoom } = {}) {
    state.center = { lat: clampLat(c.lat), lon: c.lon };
    state.zoom = Math.max(MIN_ZOOM, Math.min(maxZoom(), z));
    schedule();
  }

  /** Zoome en gardant fixe le point de l'écran (x, y). */
  function zoomAround(zoom, x, y) {
    const anchor = fromScreen(x, y);
    const z = Math.max(MIN_ZOOM, Math.min(maxZoom(), zoom));
    const p = project(anchor, z);
    const { w, h: height } = size();
    setView({ center: unproject({ x: p.x - (x - w / 2), y: p.y - (y - height / 2) }, z), zoom: z });
  }

  function fit(points, padding = 60) {
    if (!points.length) return;
    if (points.length === 1) return setView({ center: points[0], zoom: Math.max(state.zoom, 15) });
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const sw = { lat: Math.min(...lats), lon: Math.min(...lons) };
    const ne = { lat: Math.max(...lats), lon: Math.max(...lons) };
    const { w, h: height } = size();
    let zoom = maxZoom();
    for (; zoom > MIN_ZOOM; zoom -= 0.25) {
      const a = project(sw, zoom);
      const b = project(ne, zoom);
      if (Math.abs(b.x - a.x) <= w - padding * 2 && Math.abs(a.y - b.y) <= height - padding * 2.5) break;
    }
    setView({ center: unproject({ x: (project(sw, zoom).x + project(ne, zoom).x) / 2, y: (project(sw, zoom).y + project(ne, zoom).y) / 2 }, zoom), zoom: Math.min(zoom, 17) });
  }

  // ── Gestes : glisser, pincer, molette, double-tap, appui long ──
  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;
  let pressTimer = null;
  const local = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function begin() {
    const pts = [...pointers.values()];
    if (pts.length === 1) {
      gesture = { type: 'pan', start: pts[0], center: project(state.center, state.zoom), moved: false };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: state.zoom, anchor: fromScreen(mid.x, mid.y), moved: true };
    } else {
      gesture = null;
    }
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.map-ui')) return;
    el.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    begin();
    clearTimeout(pressTimer);
    if (pointers.size === 1) {
      const at = local(e);
      pressTimer = setTimeout(() => {
        if (gesture && !gesture.moved) {
          gesture.moved = true;
          onLongPress?.(fromScreen(at.x, at.y));
        }
      }, 550);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (!gesture) return;
    const pts = [...pointers.values()];
    if (gesture.type === 'pan') {
      const p = pts[0];
      const dx = p.x - gesture.start.x;
      const dy = p.y - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      if (!gesture.moved) onUserMove?.();
      gesture.moved = true;
      clearTimeout(pressTimer);
      state.center = unproject({ x: gesture.center.x - dx, y: Math.max(0, Math.min(worldSize(state.zoom), gesture.center.y - dy)) }, state.zoom);
      schedule();
    } else if (pts.length >= 2) {
      clearTimeout(pressTimer);
      onUserMove?.();
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = Math.max(MIN_ZOOM, Math.min(maxZoom(), gesture.z0 + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0)));
      const p = project(gesture.anchor, z);
      const { w, h: height } = size();
      state.zoom = z;
      state.center = unproject({ x: p.x - (mid.x - w / 2), y: p.y - (mid.y - height / 2) }, z);
      schedule();
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const wasTap = gesture?.type === 'pan' && !gesture.moved && pointers.size === 1;
    const at = local(e);
    pointers.delete(e.pointerId);
    clearTimeout(pressTimer);
    begin();
    if (wasTap && e.type === 'pointerup') {
      const now = performance.now();
      if (now - lastTap < 320) {
        onUserMove?.();
        zoomAround(state.zoom + 1, at.x, at.y);
        lastTap = 0;
      } else {
        lastTap = now;
      }
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      onUserMove?.();
      const at = local(e);
      zoomAround(state.zoom - e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025), at.x, at.y);
    },
    { passive: false },
  );

  const observer = new ResizeObserver(() => schedule());
  observer.observe(el);

  return {
    state,
    svg,
    overlay,
    toScreen,
    fromScreen,
    setView,
    zoomAround,
    fit,
    schedule,
    setLayer(layer) {
      state.layer = layer;
      for (const img of images.values()) img.remove();
      images.clear();
      setView({ zoom: Math.min(state.zoom, LAYERS[layer].max) });
    },
    zoomBy(delta) {
      const { w, h: height } = size();
      zoomAround(Math.round(state.zoom) + delta, w / 2, height / 2);
    },
    metersPerPixel: () => metersPerPixel(state.center.lat, state.zoom),
    destroy: () => observer.disconnect(),
  };
}

// ───────────── Application ─────────────

export function mount(root, ctx) {
  root.classList.add('maps');
  const saved = ctx.storage.get('view', null);
  let layer = ctx.storage.get('layer', 'plan');
  if (!LAYERS[layer]) layer = 'plan';

  let me = null; // dernière position
  let follow = false;
  let compass = false;
  let heading = null; // boussole de l'appareil
  let stopWatch = null;
  let locating = false;
  let watchError = null;
  let pin = null; // { lat, lon, name, detail }
  let route = null; // { profile, points, distance, duration } | { error } | { loading }
  let routeProfile = ctx.storage.get('profile', 'car');
  let shownTrip = null; // { name, points }
  let recording = null; // { points, startedAt, activity }

  const view = h('div.map-view');
  const credit = h('a.map-credit', { target: '_blank', rel: 'noopener' });
  const meMarker = h('div.map-me', h('div.map-me-cone'), h('div.map-me-dot'));
  const accuracy = h('div.map-accuracy');
  const pinMarker = h('div.map-pin', icon('location', { size: 34, stroke: 2 }));

  const map = createMap(view, {
    center: saved?.center ?? PARIS,
    zoom: saved?.zoom ?? (saved ? 12 : 5),
    layer,
    onUserMove: () => {
      if (follow) {
        follow = false;
        compass = false;
        renderControls();
      }
    },
    onLongPress: (pos) => {
      ctx.ui.vibrate(10);
      selectPlace({ ...pos, name: 'Lieu sélectionné', detail: formatCoordinates(pos, 5) });
    },
    onDraw: drawOverlay,
  });
  map.overlay.append(accuracy, meMarker, pinMarker);

  // ── Dessins par-dessus la carte ──
  function polyline(points, className) {
    if (points.length < 2) return null;
    const d = points.map((p, i) => {
      const s = map.toScreen(p);
      return `${i ? 'L' : 'M'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
    });
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d.join(''));
    path.setAttribute('class', className);
    return path;
  }

  function drawOverlay() {
    map.svg.replaceChildren(
      ...[shownTrip && polyline(shownTrip.points, 'line-trip'), route?.points && polyline(route.points, 'line-route-casing'), route?.points && polyline(route.points, 'line-route'), recording && polyline(recording.points, 'line-record')].filter(Boolean),
    );
    meMarker.hidden = !me;
    accuracy.hidden = !me?.accuracy;
    if (me) {
      const s = map.toScreen(me);
      meMarker.style.transform = `translate(${s.x}px, ${s.y}px)`;
      const dir = compass && heading != null ? heading : me.speed > 0.6 && me.heading != null ? me.heading : null;
      meMarker.classList.toggle('has-heading', dir != null);
      if (dir != null) meMarker.style.setProperty('--heading', `${dir}deg`);
      if (me.accuracy) {
        const r = Math.min(4000, me.accuracy / map.metersPerPixel());
        accuracy.style.transform = `translate(${s.x}px, ${s.y}px)`;
        accuracy.style.width = accuracy.style.height = `${r * 2}px`;
      }
    }
    pinMarker.hidden = !pin;
    if (pin) {
      const s = map.toScreen(pin);
      pinMarker.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
  }

  // ── Interface ──
  const searchInput = h('input', { type: 'search', placeholder: 'Rechercher un lieu ou une adresse', enterkeyhint: 'search', autocomplete: 'off' });
  const results = h('div.map-results.map-ui');
  const searchBar = h(
    'form.map-search.map-ui',
    { onsubmit: (e) => { e.preventDefault(); search(searchInput.value); } },
    icon('search', { size: 17 }),
    searchInput,
    h('button.map-search-clear', { type: 'button', 'aria-label': 'Effacer', onclick: () => { searchInput.value = ''; results.replaceChildren(); results.hidden = true; } }, icon('close', { size: 16 })),
  );
  results.hidden = true;

  const locateBtn = h('button.map-btn', { type: 'button', 'aria-label': 'Ma position', onclick: () => locateTap() });
  const controls = h(
    'div.map-controls.map-ui',
    h('div.map-btn-group', h('button.map-btn', { type: 'button', 'aria-label': 'Fond de carte', onclick: chooseLayer }, icon('layers', { size: 20 })), locateBtn),
    h('div.map-btn-group', h('button.map-btn', { type: 'button', 'aria-label': 'Zoom avant', onclick: () => map.zoomBy(1) }, icon('plus', { size: 20 })), h('button.map-btn', { type: 'button', 'aria-label': 'Zoom arrière', onclick: () => map.zoomBy(-1) }, icon('minus', { size: 20 }))),
  );
  const card = h('div.map-card.map-ui');
  root.append(view, h('div.map-top', searchBar, results), controls, card, credit);

  function renderControls() {
    locateBtn.classList.toggle('active', follow);
    locateBtn.replaceChildren(locating ? spinner(18) : icon(compass ? 'compass' : follow ? 'location-fill' : 'navigation', { size: 20 }));
    credit.textContent = LAYERS[layer].credit;
    credit.href = LAYERS[layer].link;
  }

  const fact = (label, value) => (value == null ? null : h('div.map-fact', h('span', label), h('strong', value)));

  function renderCard() {
    const parts = [];
    if (pin) {
      const away = me ? formatDistance(distance(me, pin)) : null;
      parts.push(
        h('div.map-card-head', h('div', h('strong', pin.name), h('span', [pin.detail, away && `à ${away}`].filter(Boolean).join(' · '))), h('button.map-close', { type: 'button', 'aria-label': 'Fermer', onclick: clearPin }, icon('close', { size: 16 }))),
        h('div.map-segment', segmented(Object.entries(PROFILES).map(([value, p]) => ({ value, label: p.label })), routeProfile, (v) => { routeProfile = v; ctx.storage.set('profile', v); if (route) computeRoute(); })),
        route?.loading ? h('div.map-route', spinner(16), 'Calcul de l\'itinéraire…') : null,
        route?.error ? h('div.map-route.error', route.error) : null,
        route?.points ? h('div.map-route', h('strong', formatTravel(route.duration)), h('span', formatDistance(route.distance))) : null,
        h('div.map-actions', h('button.map-action.primary', { type: 'button', onclick: computeRoute }, icon('route', { size: 18 }), 'Itinéraire'), h('button.map-action', { type: 'button', onclick: () => share(pin, pin.name) }, icon('share', { size: 18 }), 'Partager')),
      );
    } else if (shownTrip) {
      const duration = shownTrip.points.at(-1)?.time && shownTrip.points[0]?.time ? shownTrip.points.at(-1).time - shownTrip.points[0].time : null;
      parts.push(
        h('div.map-card-head', h('div', h('strong', shownTrip.name), h('span', [formatDistance(pathLength(shownTrip.points)), duration ? formatDuration(duration) : null].filter(Boolean).join(' · '))), h('button.map-close', { type: 'button', 'aria-label': 'Fermer', onclick: () => { shownTrip = null; renderCard(); map.schedule(); } }, icon('close', { size: 16 }))),
      );
    } else {
      const recLength = recording ? pathLength(recording.points) : 0;
      parts.push(
        h(
          'div.map-card-head',
          h(
            'div',
            h('strong', recording ? 'Enregistrement du trajet' : 'Ma position'),
            h('span', recording ? `${formatDistance(recLength)} · ${formatDuration(Date.now() - recording.startedAt)}` : me ? formatCoordinates(me, 5) : watchError ?? (locating ? 'Recherche de la position…' : 'Touchez le bouton de position pour vous localiser.')),
          ),
        ),
        me
          ? h(
              'div.map-facts',
              fact('Précision', me.accuracy != null ? `± ${Math.round(me.accuracy)} m` : null),
              fact('Altitude', me.alt != null ? `${Math.round(me.alt)} m` : null),
              fact('Vitesse', me.speed != null ? `${(me.speed * 3.6).toFixed(me.speed < 2.8 ? 1 : 0).replace('.', ',')} km/h` : null),
              fact('Satellites', me.satellites != null ? String(me.satellites) : null),
              fact('Source', me.source === 'gps' ? 'GPS' : 'Téléphone'),
            )
          : null,
        h(
          'div.map-actions',
          recording
            ? h('button.map-action.danger', { type: 'button', onclick: stopRecording }, icon('stop', { size: 18 }), 'Arrêter')
            : h('button.map-action.primary', { type: 'button', onclick: startRecording }, icon('record', { size: 18 }), 'Enregistrer un trajet'),
          me ? h('button.map-action', { type: 'button', onclick: () => share(me, 'Ma position') }, icon('share', { size: 18 }), 'Partager') : null,
          h('button.map-action', { type: 'button', onclick: tripsSheet }, icon('list', { size: 18 }), 'Trajets'),
        ),
      );
    }
    card.replaceChildren(...parts.filter(Boolean));
  }

  // ── Position ──
  async function startWatching() {
    if (stopWatch) return true;
    locating = !me;
    renderControls();
    try {
      stopWatch = await ctx.location.watch(onPosition, {
        onError: (message) => {
          watchError = message;
          locating = false;
          renderControls();
          renderCard();
        },
      });
      return true;
    } catch (error) {
      locating = false;
      watchError = error.message;
      renderControls();
      renderCard();
      ctx.ui.toast(error.message);
      return false;
    }
  }

  function stopWatching() {
    stopWatch?.();
    stopWatch = null;
  }

  function onPosition(position) {
    const first = !me;
    me = position;
    watchError = null;
    locating = false;
    if (recording) {
      const last = recording.points.at(-1);
      // Points imprécis ignorés, et pas de point tant qu'on n'a pas bougé de quelques mètres.
      if ((position.accuracy ?? 0) <= 60 && (!last || distance(last, position) >= Math.max(4, (position.accuracy ?? 0) / 3))) {
        recording.points.push({ lat: position.lat, lon: position.lon, alt: position.alt, time: position.time ?? Date.now() });
        recording.activity?.update({ text: formatDistance(pathLength(recording.points)) });
      }
    }
    if (first && follow) map.setView({ center: position, zoom: Math.max(map.state.zoom, 16) });
    else if (follow) map.setView({ center: position });
    else map.schedule();
    renderControls();
    renderCard();
  }

  async function locateTap() {
    if (!ctx.location.available) {
      ctx.ui.alert({ title: 'Localisation indisponible', message: 'Cet appareil ne fournit pas de position. Sur un téléphone, ouvrez Orion en https ; installé, branchez un récepteur GPS.' });
      return;
    }
    if (follow && !compass) {
      // Deuxième appui : la boussole oriente le repère.
      if (await enableCompass()) compass = true;
    } else if (compass) {
      compass = false;
    } else {
      follow = true;
      if (me) map.setView({ center: me, zoom: Math.max(map.state.zoom, 15) });
    }
    renderControls();
    if (!(await startWatching())) {
      follow = false;
      compass = false;
      renderControls();
    }
    map.schedule();
  }

  let compassListener = null;
  async function enableCompass() {
    if (compassListener) return true;
    const D = window.DeviceOrientationEvent;
    if (!D) {
      ctx.ui.toast('Pas de boussole sur cet appareil');
      return false;
    }
    if (typeof D.requestPermission === 'function') {
      try {
        if ((await D.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    compassListener = (e) => {
      const value = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null);
      if (value == null) return;
      heading = value;
      map.schedule();
    };
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(type, compassListener);
    ctx.on('destroy', () => window.removeEventListener(type, compassListener));
    return true;
  }

  // ── Recherche (Nominatim, seulement à la validation) ──
  async function search(query) {
    query = query.trim();
    if (!query) return;
    searchInput.blur();
    results.hidden = false;
    results.replaceChildren(h('div.map-result.muted', spinner(16), 'Recherche…'));
    try {
      const c = map.state.center;
      const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '8', 'accept-language': 'fr', viewbox: `${c.lon - 2},${c.lat + 2},${c.lon + 2},${c.lat - 2}` });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!response.ok) throw new Error(String(response.status));
      const places = await response.json();
      if (!places.length) {
        results.replaceChildren(h('div.map-result.muted', 'Aucun résultat'));
        return;
      }
      results.replaceChildren(
        ...places.map((place) => {
          const [name, ...rest] = place.display_name.split(', ');
          return h(
            'button.map-result',
            { type: 'button', onclick: () => {
              results.hidden = true;
              const bbox = place.boundingbox?.map(Number);
              selectPlace({ lat: Number(place.lat), lon: Number(place.lon), name, detail: rest.slice(0, 3).join(', ') }, bbox && [{ lat: bbox[0], lon: bbox[2] }, { lat: bbox[1], lon: bbox[3] }]);
            } },
            icon('location', { size: 18 }),
            h('span', h('strong', name), h('small', rest.slice(0, 3).join(', '))),
          );
        }),
        h('div.map-result.muted.small', 'Recherche : Nominatim / OpenStreetMap'),
      );
    } catch {
      results.replaceChildren(h('div.map-result.muted', navigator.onLine === false ? 'Pas de connexion à Internet' : 'Recherche indisponible pour le moment'));
    }
  }

  function selectPlace(place, bounds = null) {
    pin = place;
    route = null;
    follow = false;
    compass = false;
    if (bounds) map.fit(bounds, 30);
    else map.setView({ center: place, zoom: Math.max(map.state.zoom, 15) });
    renderControls();
    renderCard();
  }

  function clearPin() {
    pin = null;
    route = null;
    renderCard();
    map.schedule();
  }

  // ── Itinéraire (OSRM) ──
  async function computeRoute() {
    if (!pin) return;
    if (!me) {
      route = { loading: true };
      renderCard();
      if (!(await startWatching())) {
        route = null;
        renderCard();
        return;
      }
      try {
        me = await ctx.location.current({ timeout: 20_000 });
      } catch (error) {
        route = { error: error.message };
        renderCard();
        return;
      }
    }
    route = { loading: true };
    renderCard();
    const target = pin;
    try {
      const url = `https://routing.openstreetmap.de/${PROFILES[routeProfile].server}/route/v1/driving/${me.lon},${me.lat};${target.lon},${target.lat}?overview=full&geometries=geojson`;
      const response = await fetch(url);
      const data = await response.json();
      if (pin !== target) return;
      const best = data.routes?.[0];
      if (!best) throw new Error(data.message || 'Aucun itinéraire');
      route = { profile: routeProfile, distance: best.distance, duration: best.duration, points: best.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })) };
      map.fit([me, target, ...route.points], 50);
    } catch {
      if (pin !== target) return;
      route = { error: navigator.onLine === false ? 'Pas de connexion à Internet' : 'Itinéraire indisponible pour le moment' };
    }
    renderCard();
    map.schedule();
  }

  // ── Trajets (GPX) ──
  async function startRecording() {
    if (!(await startWatching())) return;
    follow = true;
    pin = null;
    route = null;
    shownTrip = null;
    recording = { points: me ? [{ lat: me.lat, lon: me.lon, alt: me.alt, time: Date.now() }] : [], startedAt: Date.now() };
    recording.activity = ctx.ui.liveActivity({ id: 'trip', icon: 'route', color: '#ff375f', text: formatDistance(pathLength(recording.points)) });
    renderControls();
    renderCard();
    map.schedule();
  }

  async function stopRecording() {
    const trip = recording;
    recording = null;
    trip.activity?.end();
    if (ctx.foreground === false) stopWatching();
    renderCard();
    map.schedule();
    if (trip.points.length < 2) {
      ctx.ui.toast('Trajet trop court : rien n\'a été enregistré');
      return;
    }
    const stamp = new Date(trip.startedAt);
    const defaultName = `Trajet du ${stamp.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${stamp.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    const name = ((await ctx.ui.prompt({ title: 'Enregistrer le trajet', message: `${formatDistance(pathLength(trip.points))} · ${formatDuration(Date.now() - trip.startedAt)}`, value: defaultName, confirmLabel: 'Enregistrer' })) ?? defaultName).trim() || defaultName;
    const fs = ctx.fs;
    if (!fs.exists(TRIPS)) fs.mkdir(TRIPS, { recursive: true });
    const path = fs.uniquePath(`${TRIPS}/${name.replace(/[/\\:]/g, '-')}.gpx`);
    fs.writeFile(path, toGpx(trip.points, { name }));
    shownTrip = { name, points: trip.points };
    follow = false;
    map.fit(trip.points);
    renderControls();
    renderCard();
    ctx.ui.toast('Trajet enregistré dans Documents › Trajets');
  }

  function showTrip(path) {
    const points = parseGpx(ctx.fs.readFile(path));
    if (!points.length) {
      ctx.ui.toast('Ce fichier ne contient pas de trajet');
      return;
    }
    shownTrip = { name: path.split('/').pop().replace(/\.gpx$/i, ''), points };
    pin = null;
    route = null;
    follow = false;
    map.fit(points);
    renderControls();
    renderCard();
  }

  async function tripsSheet() {
    const fs = ctx.fs;
    const files = fs.exists(TRIPS) ? fs.readdir(TRIPS).filter((f) => f.type === 'file' && /\.gpx$/i.test(f.name)).sort((a, b) => b.mtime - a.mtime) : [];
    if (!files.length) {
      ctx.ui.alert({ title: 'Aucun trajet', message: 'Touchez « Enregistrer un trajet » pendant un déplacement : il sera sauvegardé au format GPX dans Documents › Trajets.' });
      return;
    }
    const choice = await ctx.ui.actionSheet({ title: 'Mes trajets', actions: files.slice(0, 12).map((f) => ({ label: f.name.replace(/\.gpx$/i, ''), value: f.path, icon: 'route' })) });
    if (choice) showTrip(choice);
  }

  // ── Divers ──
  function share(pos, label) {
    const lat = pos.lat.toFixed(6);
    const lon = pos.lon.toFixed(6);
    ctx.ui.share({ type: 'text/plain', data: { text: `${label} : https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}` } });
  }

  async function chooseLayer() {
    const choice = await ctx.ui.actionSheet({ title: 'Fond de carte', actions: Object.entries(LAYERS).map(([value, l]) => ({ label: `${l.label}${value === layer ? ' ✓' : ''}`, value })) });
    if (!choice || choice === layer) return;
    layer = choice;
    ctx.storage.set('layer', layer);
    map.setLayer(layer);
    renderControls();
  }

  const saveView = () => ctx.storage.set('view', { center: map.state.center, zoom: Math.round(map.state.zoom * 4) / 4 });
  const offline = h('div.map-offline.map-ui', icon('wifi-off', { size: 14 }), 'Hors ligne : la carte ne se charge plus');
  root.append(offline);
  const syncOnline = () => (offline.hidden = navigator.onLine !== false);
  syncOnline();
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  const timer = ctx.setInterval(() => recording && renderCard(), 1000);

  ctx.on('pause', () => {
    saveView();
    // En arrière-plan, la position n'est suivie que pendant un enregistrement de trajet.
    if (!recording) stopWatching();
  });
  ctx.on('resume', () => {
    if (follow || me) startWatching();
  });
  ctx.on('destroy', () => {
    saveView();
    stopWatching();
    recording?.activity?.end();
    map.destroy();
    timer();
    window.removeEventListener('online', syncOnline);
    window.removeEventListener('offline', syncOnline);
  });
  ctx.onBack(() => {
    if (!results.hidden) {
      results.hidden = true;
      return true;
    }
    if (pin || shownTrip) {
      pin = null;
      route = null;
      shownTrip = null;
      renderCard();
      map.schedule();
      return true;
    }
    return false;
  });

  function handleIntent(intent) {
    const path = intent?.data?.path;
    if (path && /\.gpx$/i.test(path)) showTrip(path);
    else if (intent?.data?.lat != null) selectPlace({ lat: Number(intent.data.lat), lon: Number(intent.data.lon), name: intent.data.name ?? 'Lieu partagé', detail: formatCoordinates({ lat: Number(intent.data.lat), lon: Number(intent.data.lon) }) });
  }

  renderControls();
  renderCard();
  map.schedule();
  handleIntent(ctx.intent);
  // Position déjà autorisée : elle s'affiche dès l'ouverture.
  if (ctx.location.available && ctx.kernel?.permissions.check(ctx.app.id, 'location') === 'granted') {
    follow = !saved;
    startWatching();
  }
  return { onIntent: handleIntent };
}
