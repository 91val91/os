/**
 * Logique pure du jeu 2048 (testable sans navigateur).
 * La grille est un tableau de 16 cases : 0 = vide, sinon valeur de la tuile.
 */
export const SIZE = 4;

export function emptyGrid() {
  return Array(SIZE * SIZE).fill(0);
}

export function addRandomTile(grid, random = Math.random) {
  const empty = grid.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!empty.length) return grid;
  const next = [...grid];
  next[empty[Math.floor(random() * empty.length)]] = random() < 0.9 ? 2 : 4;
  return next;
}

/** Fait glisser une ligne vers la gauche ; renvoie la ligne et les points gagnés. */
export function slideLine(line) {
  const values = line.filter(Boolean);
  const out = [];
  let score = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === values[i + 1]) {
      out.push(values[i] * 2);
      score += values[i] * 2;
      i++;
    } else {
      out.push(values[i]);
    }
  }
  while (out.length < line.length) out.push(0);
  return { line: out, score };
}

const index = (row, col) => row * SIZE + col;

/**
 * @param {number[]} grid
 * @param {'left'|'right'|'up'|'down'} direction
 * @returns {{ grid: number[], score: number, moved: boolean }}
 */
export function move(grid, direction) {
  const next = emptyGrid();
  let score = 0;
  for (let k = 0; k < SIZE; k++) {
    const cells = [];
    for (let j = 0; j < SIZE; j++) {
      if (direction === 'left') cells.push(index(k, j));
      if (direction === 'right') cells.push(index(k, SIZE - 1 - j));
      if (direction === 'up') cells.push(index(j, k));
      if (direction === 'down') cells.push(index(SIZE - 1 - j, k));
    }
    const result = slideLine(cells.map((c) => grid[c]));
    score += result.score;
    cells.forEach((c, j) => (next[c] = result.line[j]));
  }
  const moved = next.some((v, i) => v !== grid[i]);
  return { grid: next, score, moved };
}

export function canMove(grid) {
  if (grid.includes(0)) return true;
  return ['left', 'right', 'up', 'down'].some((d) => move(grid, d).moved);
}

export function hasWon(grid) {
  return grid.some((v) => v >= 2048);
}
