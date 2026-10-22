import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Modules importés statiquement à partir de `file` (le graphe chargé au démarrage). */
function bootModules(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]/gm)) {
    bootModules(resolve(dirname(file), spec), seen);
  }
  return seen;
}

test('service worker : tout le démarrage est précaché (pas d\'écran noir hors ligne)', () => {
  const sw = readFileSync(resolve(root, 'sw.js'), 'utf8');
  const core = new Set([...sw.slice(sw.indexOf('const CORE = [')).split('];')[0].matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]));
  const missing = [...bootModules(resolve(root, 'src/main.js'))].map((file) => `./${relative(root, file)}`).filter((path) => !core.has(path));
  assert.deepEqual(missing, [], 'modules à ajouter à CORE dans sw.js (et changer CACHE)');
  for (const path of core) assert.ok(path === './' || existsSync(resolve(root, path)), `${path} n'existe pas`);
});
