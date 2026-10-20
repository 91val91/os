/**
 * Reconnaissance de gestes tactiles (souris et doigt via Pointer Events).
 *
 * `drag(el, handlers)` suit un glissement avec verrouillage d'axe et calcule
 * la vélocité ; `longPress(el, fn)` détecte un appui long.
 * Les déplacements sont corrigés par `viewport.scale` (écran mis à
 * l'échelle dans le cadre du téléphone sur ordinateur).
 */
export const viewport = { scale: 1 };

/**
 * @param {HTMLElement} el
 * @param {object} handlers
 * @param {(e: PointerEvent) => boolean} [handlers.filter] décide si le geste démarre
 * @param {'x'|'y'|null} [handlers.axis] axe imposé (le geste est abandonné sinon)
 * @param {(info) => void} [handlers.onStart]
 * @param {(info) => void} [handlers.onMove]
 * @param {(info) => void} [handlers.onEnd]
 * @param {(info) => void} [handlers.onCancel] axe refusé ou pointeur annulé
 * @param {number} [handlers.threshold]
 */
export function drag(el, { filter, axis = null, onStart, onMove, onEnd, onCancel, threshold = 8, capture = true } = {}) {
  let state = null;

  const info = (e) => {
    const scale = viewport.scale || 1;
    const dx = (e.clientX - state.x0) / scale;
    const dy = (e.clientY - state.y0) / scale;
    const now = performance.now();
    state.samples.push({ t: now, x: e.clientX / scale, y: e.clientY / scale });
    while (state.samples.length > 2 && now - state.samples[0].t > 100) state.samples.shift();
    const first = state.samples[0];
    const dt = Math.max(1, now - first.t);
    return {
      dx,
      dy,
      x: e.clientX,
      y: e.clientY,
      startX: state.x0,
      startY: state.y0,
      vx: (e.clientX / scale - first.x) / dt,
      vy: (e.clientY / scale - first.y) / dt,
      axis: state.axis,
      duration: now - state.t0,
      event: e,
      target: state.target,
    };
  };

  const down = (e) => {
    if (state || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (filter && !filter(e)) return;
    state = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), active: false, axis: null, samples: [], target: e.target };
    state.samples.push({ t: state.t0, x: e.clientX / (viewport.scale || 1), y: e.clientY / (viewport.scale || 1) });
    // Suivi au niveau de la fenêtre : le pointeur peut quitter l'élément
    // avant que le geste soit reconnu (souris, petites zones).
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const release = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };

  const move = (e) => {
    if (!state || e.pointerId !== state.id) return;
    const data = info(e);
    if (!state.active) {
      if (Math.hypot(data.dx, data.dy) < threshold) return;
      state.axis = Math.abs(data.dx) > Math.abs(data.dy) ? 'x' : 'y';
      if (axis && state.axis !== axis) {
        onCancel?.(data);
        state = null;
        release();
        return;
      }
      state.active = true;
      data.axis = state.axis;
      if (capture) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* pointeur déjà relâché */
        }
      }
      onStart?.(data);
    }
    if (e.cancelable) e.preventDefault();
    onMove?.(data);
  };

  const up = (e) => {
    if (!state || e.pointerId !== state.id) return;
    const wasActive = state.active;
    const data = info(e);
    const cancelled = e.type === 'pointercancel';
    state = null;
    release();
    if (!wasActive) return;
    if (cancelled) onCancel?.(data);
    else onEnd?.(data);
  };

  el.addEventListener('pointerdown', down);
  return () => {
    el.removeEventListener('pointerdown', down);
    release();
  };
}

/** Appui long : appelle `fn(event)` après `delay` ms sans mouvement. */
export function longPress(el, fn, { delay = 480, tolerance = 10 } = {}) {
  let timer = null;
  let origin = null;
  let fired = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired = false;
    origin = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      fired = true;
      fn(e);
    }, delay);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > tolerance) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  // Clic droit sur ordinateur = appui long.
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!fired) {
      fired = true;
      cancel();
      fn(e);
    }
  });
  // Empêche le clic qui suit un appui long.
  el.addEventListener(
    'click',
    (e) => {
      if (fired) {
        e.stopImmediatePropagation();
        e.preventDefault();
        fired = false;
      }
    },
    true,
  );
}

/** Balayage horizontal simple (jeux, visionneuses). */
export function swipe(el, onSwipe, { threshold = 30 } = {}) {
  return drag(el, {
    threshold: 6,
    onEnd: ({ dx, dy, vx, vy }) => {
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const distance = horizontal ? dx : dy;
      const velocity = horizontal ? vx : vy;
      if (Math.abs(distance) < threshold && Math.abs(velocity) < 0.5) return;
      onSwipe(horizontal ? (distance > 0 ? 'right' : 'left') : distance > 0 ? 'down' : 'up');
    },
  });
}
