/**
 * 2048 : glissez pour fusionner les tuiles identiques.
 */
import { h } from '../../lib/dom.js';
import { swipe } from '../../lib/gesture.js';
import { emptyGrid, addRandomTile, move, canMove, hasWon, SIZE } from './logic.js';

export const styles = [new URL('./style.css', import.meta.url).href];

export function mount(root, ctx) {
  let state = ctx.storage.get('state', null);
  let best = ctx.storage.get('best', 0);
  let wonShown = state?.wonShown ?? false;

  const scoreEl = h('strong');
  const bestEl = h('strong');
  const board = h('div.g2048-board');
  const overlay = h('div.g2048-overlay');

  function newGame() {
    state = { grid: addRandomTile(addRandomTile(emptyGrid())), score: 0, wonShown: false };
    wonShown = false;
    save();
    render();
  }

  function save() {
    ctx.storage.set('state', { ...state, wonShown });
    ctx.storage.set('best', best);
  }

  function play(direction) {
    if (overlay.classList.contains('visible')) return;
    const result = move(state.grid, direction);
    if (!result.moved) {
      board.animate?.([{ transform: 'translateX(0)' }, { transform: `translateX(${direction === 'left' ? -6 : direction === 'right' ? 6 : 0}px) translateY(${direction === 'up' ? -6 : direction === 'down' ? 6 : 0}px)` }, { transform: 'none' }], { duration: 160 });
      return;
    }
    const merged = new Set();
    result.grid.forEach((v, i) => {
      if (v && v !== state.grid[i] && state.grid[i] !== 0) merged.add(i);
    });
    state.grid = addRandomTile(result.grid);
    state.score += result.score;
    best = Math.max(best, state.score);
    if (result.score) ctx.ui.vibrate(8);
    save();
    render(merged);
    if (hasWon(state.grid) && !wonShown) {
      wonShown = true;
      save();
      showOverlay('Vous avez gagné ! 🎉', 'Continuer', () => overlay.classList.remove('visible'));
    } else if (!canMove(state.grid)) {
      showOverlay('Partie terminée', 'Rejouer', newGame);
    }
  }

  function showOverlay(title, label, action) {
    overlay.replaceChildren(h('strong', title), h('span', `Score : ${state.score}`), h('button.btn.btn-filled', { type: 'button', onclick: () => { overlay.classList.remove('visible'); action(); } }, label));
    overlay.classList.add('visible');
  }

  function render(merged = new Set()) {
    scoreEl.textContent = String(state.score);
    bestEl.textContent = String(best);
    board.replaceChildren(
      ...state.grid.map((v, i) =>
        h(
          `div.g2048-cell${v ? `.v${Math.min(v, 4096)}` : ''}${merged.has(i) ? '.merged' : ''}`,
          { style: { gridRow: Math.floor(i / SIZE) + 1, gridColumn: (i % SIZE) + 1 } },
          v ? String(v) : '',
        ),
      ),
      overlay,
    );
  }

  root.classList.add('g2048');
  root.append(
    h(
      'div.g2048-top',
      h('div.g2048-title', '2048'),
      h('div.g2048-scores', h('div.g2048-score', h('small', 'SCORE'), scoreEl), h('div.g2048-score', h('small', 'MEILLEUR'), bestEl)),
    ),
    h('div.g2048-actions', h('p', 'Fusionnez les tuiles pour atteindre 2048 !'), h('button.btn.btn-filled.small', { type: 'button', onclick: newGame }, 'Nouvelle partie')),
    board,
    h('p.g2048-help', 'Balayez dans une direction ou utilisez les flèches du clavier.'),
  );

  swipe(board, play, { threshold: 24 });
  const keys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const onKey = (e) => {
    if (!ctx.foreground || e.altKey || !keys[e.key]) return;
    e.preventDefault();
    play(keys[e.key]);
  };
  window.addEventListener('keydown', onKey);
  ctx.on('destroy', () => window.removeEventListener('keydown', onKey));

  if (!state?.grid) newGame();
  else render();
}
