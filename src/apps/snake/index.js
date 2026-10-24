/**
 * Snake : le classique, sur canvas. Balayage, flèches ou croix directionnelle.
 * Le jeu se met en pause quand l'application passe en arrière-plan.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { swipe } from '../../lib/gesture.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const CELLS = 18;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

export function mount(root, ctx) {
  const canvas = h('canvas.snake-canvas', { width: 540, height: 540 });
  const g = canvas.getContext('2d');
  const scoreEl = h('strong');
  const bestEl = h('strong');
  const message = h('div.snake-message');
  let best = ctx.storage.get('best', 0);
  let snake;
  let direction;
  let queued;
  let food;
  let score;
  let state = 'ready'; // ready | running | paused | over
  let lastStep = 0;
  let speed = 150;

  function reset() {
    snake = [[8, 9], [7, 9], [6, 9]];
    direction = 'right';
    queued = [];
    score = 0;
    speed = 150;
    placeFood();
    state = 'ready';
    showMessage('Snake', 'Touchez pour jouer');
    draw();
  }

  function placeFood() {
    do {
      food = [Math.floor(Math.random() * CELLS), Math.floor(Math.random() * CELLS)];
    } while (snake.some(([x, y]) => x === food[0] && y === food[1]));
  }

  function showMessage(title, subtitle) {
    message.replaceChildren(h('strong', title), h('span', subtitle));
    message.hidden = false;
  }

  function start() {
    if (state === 'over') reset();
    state = 'running';
    message.hidden = true;
    lastStep = performance.now();
  }

  function pause() {
    if (state !== 'running') return;
    state = 'paused';
    showMessage('Pause', 'Touchez pour reprendre');
  }

  function turn(dir) {
    const last = queued.at(-1) ?? direction;
    if (dir === last || dir === OPPOSITE[last]) return;
    if (queued.length < 3) queued.push(dir);
    if (state === 'ready' || state === 'paused') start();
  }

  function step() {
    if (queued.length) direction = queued.shift();
    const [dx, dy] = DIRS[direction];
    const head = [snake[0][0] + dx, snake[0][1] + dy];
    const hit = head[0] < 0 || head[1] < 0 || head[0] >= CELLS || head[1] >= CELLS || snake.some(([x, y], i) => i < snake.length - 1 && x === head[0] && y === head[1]);
    if (hit) {
      state = 'over';
      ctx.ui.vibrate([60, 40, 120]);
      if (score > best) {
        best = score;
        ctx.storage.set('best', best);
      }
      showMessage('Perdu !', `Score : ${score} — touchez pour rejouer`);
      return;
    }
    snake.unshift(head);
    if (head[0] === food[0] && head[1] === food[1]) {
      score += 10;
      speed = Math.max(70, speed - 4);
      ctx.ui.vibrate(10);
      placeFood();
    } else {
      snake.pop();
    }
  }

  function draw() {
    const size = canvas.width / CELLS;
    g.fillStyle = '#0f1f17';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(255,255,255,.03)';
    for (let x = 0; x < CELLS; x++) for (let y = (x % 2); y < CELLS; y += 2) g.fillRect(x * size, y * size, size, size);
    g.fillStyle = '#ff5c5c';
    g.beginPath();
    g.arc(food[0] * size + size / 2, food[1] * size + size / 2, size * 0.38, 0, Math.PI * 2);
    g.fill();
    snake.forEach(([x, y], i) => {
      g.fillStyle = i === 0 ? '#9cff8f' : `hsl(${125 - Math.min(i, 30)}, 70%, ${55 - Math.min(i, 20)}%)`;
      const pad = i === 0 ? 1 : 2.5;
      g.beginPath();
      g.roundRect(x * size + pad, y * size + pad, size - pad * 2, size - pad * 2, 7);
      g.fill();
    });
    scoreEl.textContent = String(score);
    bestEl.textContent = String(Math.max(best, score));
  }

  ctx.raf((now) => {
    if (state === 'running' && now - lastStep >= speed) {
      lastStep = now;
      step();
      draw();
    }
  });

  const pad = (dir, name) => h('button.snake-pad-btn', { type: 'button', 'aria-label': dir, onpointerdown: (e) => { e.preventDefault(); turn(dir); } }, icon(name, { size: 26, stroke: 2.6 }));
  const board = h('div.snake-board', canvas, message);
  let lastSwipe = 0;
  board.addEventListener('click', () => {
    if (performance.now() - lastSwipe < 400) return;
    if (state === 'running') pause();
    else start();
  });

  root.classList.add('snake');
  root.append(
    h('div.snake-top', h('div.snake-title', 'Snake'), h('div.snake-scores', h('span', 'Score ', scoreEl), h('span', 'Record ', bestEl))),
    board,
    h('div.snake-pad', h('span'), pad('up', 'chevron-up'), h('span'), pad('left', 'chevron-left'), h('span.snake-pad-center'), pad('right', 'chevron-right'), h('span'), pad('down', 'chevron-down'), h('span')),
  );
  swipe(board, (dir) => {
    lastSwipe = performance.now();
    turn(dir);
  }, { threshold: 18 });
  const keys = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', z: 'up', s: 'down', q: 'left', d: 'right' };
  const onKey = (e) => {
    if (!ctx.foreground || e.altKey) return;
    if (keys[e.key]) {
      e.preventDefault();
      turn(keys[e.key]);
    } else if (e.key === ' ') {
      e.preventDefault();
      state === 'running' ? pause() : start();
    }
  };
  window.addEventListener('keydown', onKey);
  ctx.on('destroy', () => window.removeEventListener('keydown', onKey));
  reset();
  return { onPause: pause };
}
