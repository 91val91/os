#!/usr/bin/env node
/**
 * Publie une version d'Orion OS : régénère version.json à partir de
 * src/kernel/version.js et des fichiers de l'interface (empreinte SHA-256 et
 * taille de chacun). Les téléphones s'en servent pour savoir qu'une mise à
 * jour existe, ne télécharger que les fichiers modifiés et vérifier leur
 * intégrité.  Usage : npm run release (après avoir changé la version).
 *
 * Les fichiers et leur contenu sont pris dans l'index git (git add) : c'est
 * exactement ce que GitHub Pages publiera, sans fichier local non suivi
 * (.DS_Store…) ni fins de ligne Windows. Sans dépôt git, le dossier est lu
 * directement (fichiers cachés exclus).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE } from '../src/kernel/version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Tout ce que le téléphone télécharge (le service worker sw.js est géré à part par le navigateur).
const SOURCES = ['index.html', 'manifest.webmanifest', 'assets', 'src'];

const git = (root, args, input) => execFileSync('git', ['-C', root, ...args], { input, maxBuffer: 1 << 28, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });

/** Fichiers de l'index git : [chemin, contenu] (null hors d'un dépôt git). */
function indexedFiles(root) {
  let listing;
  try {
    listing = git(root, ['ls-files', '-s', '-z', '--', ...SOURCES]).toString('utf8');
  } catch {
    return null;
  }
  const entries = listing
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      return { blob: meta.split(' ')[1], path };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  // Un seul processus git pour lire tous les contenus.
  const out = git(root, ['cat-file', '--batch'], entries.map((e) => e.blob).join('\n') + '\n');
  const files = [];
  let offset = 0;
  for (const { path } of entries) {
    const header = out.subarray(offset, out.indexOf(10, offset)).toString();
    const size = Number(header.split(' ')[2]);
    const start = out.indexOf(10, offset) + 1;
    files.push([path, out.subarray(start, start + size)]);
    offset = start + size + 1;
  }
  return files;
}

async function* walk(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    yield path;
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) if (!entry.name.startsWith('.')) yield* walk(join(path, entry.name));
}

async function diskFiles(root) {
  const files = [];
  for (const source of SOURCES) for await (const file of walk(join(root, source))) files.push([relative(root, file).split('\\').join('/'), await readFile(file)]);
  return files;
}

/** Manifeste de la version : métadonnées et { './chemin': { hash, size } } pour chaque fichier. */
export async function buildManifest(root = ROOT) {
  const list = {};
  let size = 0;
  for (const [path, content] of indexedFiles(root) ?? (await diskFiles(root))) {
    list[`./${path}`] = { hash: createHash('sha256').update(content).digest('hex'), size: content.length };
    size += content.length;
  }
  return { ...RELEASE, size, files: list };
}

/** Changements des sources pas encore dans l'index : ils ne seraient pas publiés. */
export function unstaged(root = ROOT) {
  try {
    return git(root, ['status', '--porcelain', '--', ...SOURCES])
      .toString()
      .split('\n')
      .filter((line) => line && line[1] !== ' ')
      .map((line) => line.slice(3));
  } catch {
    return [];
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pending = unstaged();
  if (pending.length) {
    console.error(`Fichiers modifiés ou nouveaux non ajoutés à git (git add) : ils ne seraient pas publiés.\n  ${pending.join('\n  ')}`);
    process.exit(1);
  }
  const manifest = await buildManifest();
  await writeFile(join(ROOT, 'version.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`version.json : Orion OS ${manifest.version} (${manifest.build}), ${Object.keys(manifest.files).length} fichiers, ${(manifest.size / 1024).toFixed(0)} Ko`);
}
