import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, formatNumber, looksLikeMath, clean } from '../src/lib/expr.js';
import { slideLine, move, canMove, addRandomTile, emptyGrid, hasWon } from '../src/apps/game2048/logic.js';
import { formatDuration, formatBytes, initials, relativeTime } from '../src/lib/format.js';
import { landscapeSVG, hashString, mulberry32 } from '../src/lib/artwork.js';
import { sha256Hex } from '../src/lib/sha256.js';
import { createHash } from 'node:crypto';

test('expressions : priorités, associativité, unaire', () => {
  assert.equal(evaluate('2 + 3 × 4'), 14);
  assert.equal(evaluate('(2 + 3) × 4'), 20);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('10 − 4 − 3'), 3);
  assert.equal(evaluate('12 ÷ 4 ÷ 3'), 1);
  assert.equal(clean(evaluate('0,1 + 0,2')), 0.3);
});

test('expressions : fonctions, constantes, %, !, multiplication implicite', () => {
  assert.equal(evaluate('sin(90)', { degrees: true }), 1);
  assert.equal(evaluate('√16 + sqrt(9)'), 7);
  assert.equal(evaluate('2π'), 2 * Math.PI);
  assert.equal(evaluate('50%'), 0.5);
  assert.equal(evaluate('7 % 3'), 1);
  assert.equal(evaluate('5!'), 120);
  assert.equal(evaluate('2(3 + 4)'), 14);
  assert.equal(evaluate('(1 + 2'), 3);
  assert.equal(evaluate('1e3 + 1'), 1001);
});

test('expressions : erreurs explicites', () => {
  assert.throws(() => evaluate('1 / 0'), /Division par zéro/);
  assert.throws(() => evaluate('2 +'), /incomplète/);
  assert.throws(() => evaluate('abc'), /Inconnu/);
  assert.throws(() => evaluate(''), /vide/);
  assert.throws(() => evaluate('(-1)!'), /Factorielle/);
});

test('format des nombres et détection de calcul', () => {
  assert.equal(formatNumber(1234.5).replace(/\s/g, ' '), '1 234,5');
  assert.equal(formatNumber(Infinity), '∞');
  assert.equal(looksLikeMath('12*7'), true);
  assert.equal(looksLikeMath('2026'), false);
  assert.equal(looksLikeMath('bonjour'), false);
});

test('2048 : glissement et fusion d\'une ligne', () => {
  assert.deepEqual(slideLine([2, 2, 2, 2]), { line: [4, 4, 0, 0], score: 8 });
  assert.deepEqual(slideLine([2, 0, 2, 4]), { line: [4, 4, 0, 0], score: 4 });
  assert.deepEqual(slideLine([4, 4, 8, 0]), { line: [8, 8, 0, 0], score: 8 });
  assert.deepEqual(slideLine([0, 0, 0, 2]), { line: [2, 0, 0, 0], score: 0 });
});

test('2048 : mouvements, fin de partie, victoire', () => {
  const grid = [2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.deepEqual(move(grid, 'left').grid.slice(0, 4), [4, 0, 0, 0]);
  assert.deepEqual(move(grid, 'right').grid.slice(0, 4), [0, 0, 0, 4]);
  assert.equal(move(grid, 'up').moved, false);
  assert.equal(move(grid, 'down').grid[12], 2);
  const blocked = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  assert.equal(canMove(blocked), false);
  assert.equal(hasWon([...emptyGrid().slice(1), 2048]), true);
  const filled = addRandomTile(emptyGrid(), mulberry32(1));
  assert.equal(filled.filter(Boolean).length, 1);
});

test('formatage français', () => {
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatDuration(1_234, { tenths: true }), '00:01,23');
  assert.equal(formatBytes(512), '512 o');
  assert.match(formatBytes(1536), /^1,5 Ko$/);
  assert.equal(initials('Alice Martin'), 'AM');
  assert.equal(initials('+33 6 12'), '#');
  const now = new Date(2026, 4, 10, 12, 0).getTime();
  assert.equal(relativeTime(now - 10_000, now), "À l'instant");
  assert.equal(relativeTime(now - 5 * 60_000, now), 'Il y a 5 min');
  assert.equal(relativeTime(now - 26 * 3_600_000, now), 'Hier');
});

test('illustrations déterministes', () => {
  assert.equal(hashString('orion'), hashString('orion'));
  assert.equal(landscapeSVG(7), landscapeSVG(7));
  assert.notEqual(landscapeSVG(7), landscapeSVG(8));
  assert.match(landscapeSVG(1), /^<svg/);
});

test('SHA-256 de secours (page HTTP sans crypto.subtle) identique à la référence', () => {
  const encoder = new TextEncoder();
  for (const text of ['', 'abc', '1234', 'orion:'.repeat(40), 'é€😀']) {
    const bytes = encoder.encode(text);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'), text);
  }
});
