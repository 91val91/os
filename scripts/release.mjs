#!/usr/bin/env node
/**
 * Publie une version d'Orion OS : régénère version.json à partir de
 * src/kernel/version.js et des fichiers de l'interface (empreinte SHA-256 et
 * taille de chacun). Les téléphones s'en servent pour savoir qu'une mise à
 * jour existe, ne télécharger que les fichiers modifiés et vérifier leur
 * intégrité.  Usage : npm run release (après avoir changé la version).
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE } from '../src/kernel/version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Tout ce que le téléphone télécharge (le service worker sw.js est géré à part par le navigateur).
const SOURCES = ['index.html', 'manifest.webmanifest', 'assets', 'src'];

async function* files(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    yield path;
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) yield* files(join(path, entry.name));
}

/** Manifeste de la version : métadonnées et { './chemin': { hash, size } } pour chaque fichier. */
export async function buildManifest(root = ROOT) {
  const list = {};
  let size = 0;
  for (const source of SOURCES) {
    for await (const file of files(join(root, source))) {
      const content = await readFile(file);
      list[`./${relative(root, file).split('\\').join('/')}`] = { hash: createHash('sha256').update(content).digest('hex'), size: content.length };
      size += content.length;
    }
  }
  return { ...RELEASE, size, files: list };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const manifest = await buildManifest();
  await writeFile(join(ROOT, 'version.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`version.json : Orion OS ${manifest.version} (${manifest.build}), ${Object.keys(manifest.files).length} fichiers, ${(manifest.size / 1024).toFixed(0)} Ko`);
}
