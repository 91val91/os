import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../scripts/release.mjs';
import { RELEASE } from '../src/kernel/version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const published = JSON.parse(readFileSync(resolve(root, 'version.json'), 'utf8'));

/** Modules importés statiquement à partir de `file` (le graphe chargé au démarrage). */
function bootModules(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]/gm)) bootModules(resolve(dirname(file), spec), seen);
  return seen;
}

test('version.json décrit exactement la version du dépôt (sinon : npm run release)', async () => {
  const manifest = await buildManifest(root);
  for (const key of ['version', 'channel', 'sequence', 'build', 'codename', 'date']) assert.equal(published[key], RELEASE[key], key);
  assert.deepEqual(published.notes, [...RELEASE.notes]);
  assert.deepEqual(published.files, manifest.files, 'version.json périmé : lancez npm run release');
  assert.equal(published.size, manifest.size);
});

test('la version publiée contient tout le démarrage (pas d\'écran noir hors ligne)', () => {
  const missing = [...bootModules(resolve(root, 'src/main.js'))].map((file) => `./${relative(root, file)}`).filter((path) => !published.files[path]);
  assert.deepEqual(missing, []);
  for (const path of ['./index.html', './manifest.webmanifest', './assets/icon-192.png']) assert.ok(published.files[path], path);
});
