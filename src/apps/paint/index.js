/**
 * Dessin : peinture au doigt avec couleurs, tailles de pinceau, gomme,
 * annulation et export PNG vers Photos.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { iconButton } from '../../lib/ui.js';
import { pad2 } from '../../lib/format.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const COLORS = ['#111111', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#8e5e3c'];
const SIZES = [3, 8, 16, 32];

export function mount(root, ctx) {
  const canvas = h('canvas.paint-canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  let color = ctx.storage.get('color', COLORS[7]);
  let size = ctx.storage.get('size', SIZES[1]);
  let eraser = false;
  const undo = [];
  const redo = [];
  let drawing = null;
  let dirty = false;

  const board = h('div.paint-board', canvas);

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(board.offsetWidth * ratio);
    const height = Math.round(board.offsetHeight * ratio);
    if (!width || !height || (canvas.width === width && canvas.height === height)) return;
    const previous = canvas.width ? g.getImageData(0, 0, canvas.width, canvas.height) : null;
    canvas.width = width;
    canvas.height = height;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, width, height);
    if (previous) g.putImageData(previous, 0, 0);
  }

  function snapshot() {
    undo.push(g.getImageData(0, 0, canvas.width, canvas.height));
    if (undo.length > 25) undo.shift();
    redo.length = 0;
    renderTools();
  }

  function point(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * canvas.width, y: ((e.clientY - rect.top) / rect.height) * canvas.height, p: e.pressure && e.pointerType === 'pen' ? e.pressure : 0.6 };
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    snapshot();
    drawing = { id: e.pointerId, last: point(e) };
    dirty = true;
    const p = drawing.last;
    g.fillStyle = eraser ? '#fff' : color;
    g.beginPath();
    g.arc(p.x, p.y, (size * (window.devicePixelRatio || 1)) / 2, 0, Math.PI * 2);
    g.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== drawing.id) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const p = point(ev);
      const ratio = window.devicePixelRatio || 1;
      g.strokeStyle = eraser ? '#fff' : color;
      g.lineWidth = size * ratio * (eraser ? 1.6 : 0.6 + p.p * 0.8);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(drawing.last.x, drawing.last.y);
      g.lineTo(p.x, p.y);
      g.stroke();
      drawing.last = p;
    }
  });
  const end = () => (drawing = null);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  function undoStep() {
    if (!undo.length) return;
    redo.push(g.getImageData(0, 0, canvas.width, canvas.height));
    g.putImageData(undo.pop(), 0, 0);
    renderTools();
  }

  function redoStep() {
    if (!redo.length) return;
    undo.push(g.getImageData(0, 0, canvas.width, canvas.height));
    g.putImageData(redo.pop(), 0, 0);
    renderTools();
  }

  async function clearAll() {
    if (!(await ctx.ui.confirm({ title: 'Effacer le dessin ?', confirmLabel: 'Effacer', destructive: true }))) return;
    snapshot();
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    dirty = false;
  }

  function save() {
    const now = new Date();
    const path = ctx.fs.uniquePath(`/home/Photos/Dessin ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}h${pad2(now.getMinutes())}.png`);
    ctx.fs.writeFile(path, canvas.toDataURL('image/png'), { mime: 'image/png', parents: true });
    dirty = false;
    ctx.ui.toast('Dessin enregistré dans Photos', { icon: 'check-circle' });
    return path;
  }

  const undoBtn = iconButton('undo', undoStep, { label: 'Annuler' });
  const redoBtn = iconButton('redo', redoStep, { label: 'Rétablir' });
  const palette = h('div.paint-palette');
  const sizes = h('div.paint-sizes');
  const eraserBtn = h('button.paint-tool', { type: 'button', 'aria-label': 'Gomme', onclick: () => { eraser = !eraser; renderTools(); } }, icon('eraser', { size: 22 }));

  function renderTools() {
    undoBtn.disabled = !undo.length;
    redoBtn.disabled = !redo.length;
    eraserBtn.classList.toggle('active', eraser);
    palette.replaceChildren(
      ...COLORS.map((c) => h(`button.paint-color${c === color && !eraser ? '.active' : ''}`, { type: 'button', 'aria-label': c, style: { background: c }, onclick: () => { color = c; eraser = false; ctx.storage.set('color', c); renderTools(); } })),
    );
    sizes.replaceChildren(
      ...SIZES.map((s) => h(`button.paint-size${s === size ? '.active' : ''}`, { type: 'button', 'aria-label': `Taille ${s}`, onclick: () => { size = s; ctx.storage.set('size', s); renderTools(); } }, h('span', { style: { width: `${Math.min(26, s)}px`, height: `${Math.min(26, s)}px`, background: eraser ? '#999' : color } }))),
      eraserBtn,
    );
  }

  root.classList.add('paint');
  root.append(
    h(
      'div.paint-top',
      h('div.paint-left', undoBtn, redoBtn),
      h('div.paint-right', iconButton('trash', clearAll, { label: 'Effacer tout' }), iconButton('share', () => { const path = save(); ctx.ui.share({ type: 'image/png', data: { image: ctx.fs.readFile(path), path } }); }, { label: 'Partager' }), h('button.appbar-text.strong', { type: 'button', onclick: save }, 'Enregistrer')),
    ),
    board,
    h('div.paint-bottom', sizes, palette),
  );
  renderTools();
  const observer = new ResizeObserver(() => resize());
  observer.observe(board);
  ctx.on('destroy', () => observer.disconnect());
  ctx.onBack(async () => {
    if (!dirty) return false;
    const choice = await ctx.ui.alert({
      title: 'Enregistrer le dessin ?',
      buttons: [
        { label: 'Ne pas enregistrer', value: 'discard', role: 'destructive' },
        { label: 'Enregistrer', value: 'save' },
        { label: 'Annuler', value: 'cancel', role: 'cancel' },
      ],
    });
    if (choice === 'save') save();
    if (choice === 'discard') dirty = false;
    return choice === 'cancel' || choice == null;
  });
}
