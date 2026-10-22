import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem, normalize, resolve, dirname, basename, extname, byteLength, FsError, sandbox, inUserSpace } from '../src/kernel/vfs.js';
import { MemoryBackend, Namespace } from '../src/kernel/storage.js';

async function fresh(backend = new MemoryBackend()) {
  return new FileSystem({ store: new Namespace(backend, 'fs') }).mount();
}

test('normalisation et résolution des chemins', () => {
  assert.equal(normalize('/a//b/./c/../d/'), '/a/b/d');
  assert.equal(normalize('../..'), '/');
  assert.equal(resolve('/home/user', 'docs/../photo.jpg'), '/home/user/photo.jpg');
  assert.equal(resolve('/home', '/etc'), '/etc');
  assert.equal(dirname('/a/b/c.txt'), '/a/b');
  assert.equal(dirname('/a'), '/');
  assert.equal(basename('/a/b/c.txt'), 'c.txt');
  assert.equal(extname('/a/archive.TAR'), 'tar');
  assert.equal(extname('/a/.hidden'), '');
});

test('taille en octets (texte UTF-8 et data URL base64)', () => {
  assert.equal(byteLength('abc'), 3);
  assert.equal(byteLength('é'), 2);
  assert.equal(byteLength('data:text/plain;base64,aGVsbG8='), 5);
});

test('création, lecture, listing triés (dossiers d\'abord)', async () => {
  const fs = await fresh();
  fs.mkdir('/home/docs', { recursive: true });
  fs.writeFile('/home/b.txt', 'bonjour');
  fs.writeFile('/home/a.txt', 'salut');
  assert.equal(fs.readFile('/home/b.txt'), 'bonjour');
  assert.deepEqual(fs.readdir('/home').map((e) => e.name), ['docs', 'a.txt', 'b.txt']);
  assert.equal(fs.stat('/home/a.txt').mime, 'text/plain');
  assert.equal(fs.du('/home'), 12);
});

test('erreurs POSIX : ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY', async () => {
  const fs = await fresh();
  fs.mkdir('/d');
  fs.writeFile('/d/f', 'x');
  const code = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof FsError);
      return error.code;
    }
    return null;
  };
  assert.equal(code(() => fs.readFile('/nope')), 'ENOENT');
  assert.equal(code(() => fs.mkdir('/d')), 'EEXIST');
  assert.equal(code(() => fs.readdir('/d/f')), 'ENOTDIR');
  assert.equal(code(() => fs.readFile('/d')), 'EISDIR');
  assert.equal(code(() => fs.rm('/d')), 'ENOTEMPTY');
  assert.equal(code(() => fs.writeFile('/missing/parent.txt', '')), 'ENOENT');
  fs.rm('/d', { recursive: true });
  assert.equal(fs.exists('/d/f'), false);
});

test('les chemins système sont en lecture seule', async () => {
  const fs = await fresh();
  fs.mkdir('/system', { system: true });
  fs.writeFile('/system/version', '1.0', { system: true });
  assert.throws(() => fs.writeFile('/system/version', 'hack'), { code: 'EACCES' });
  assert.throws(() => fs.rm('/system/version'), { code: 'EACCES' });
  assert.equal(fs.stat('/system/version').readonly, true);
});

test('renommage et copie récursifs', async () => {
  const fs = await fresh();
  fs.writeFile('/src/a/b.txt', 'B', { parents: true });
  fs.copy('/src', '/copy');
  assert.equal(fs.readFile('/copy/a/b.txt'), 'B');
  fs.mkdir('/dest');
  fs.rename('/src', '/dest');
  assert.equal(fs.readFile('/dest/src/a/b.txt'), 'B');
  assert.equal(fs.exists('/src'), false);
  assert.throws(() => fs.rename('/dest', '/dest/src/inner'), { code: 'EINVAL' });
});

test('noms uniques', async () => {
  const fs = await fresh();
  fs.writeFile('/photo.jpg', '1');
  assert.equal(fs.uniquePath('/photo.jpg'), '/photo 2.jpg');
  fs.writeFile('/photo 2.jpg', '2');
  assert.equal(fs.uniquePath('/photo.jpg'), '/photo 3.jpg');
  assert.equal(fs.uniquePath('/nouveau.txt'), '/nouveau.txt');
});

test('persistance : un second montage relit le stockage', async () => {
  const backend = new MemoryBackend();
  const first = await fresh(backend);
  first.writeFile('/home/note.txt', 'persistant', { parents: true });
  await new Promise((r) => setTimeout(r, 0));
  const second = await fresh(backend);
  assert.equal(second.readFile('/home/note.txt'), 'persistant');
});

test('observateurs de modifications', async () => {
  const fs = await fresh();
  const changes = [];
  const off = fs.watch('/home', (change) => changes.push(change));
  fs.writeFile('/home/a', '1', { parents: true });
  fs.writeFile('/tmp/x', '1', { parents: true });
  off();
  fs.writeFile('/home/b', '2');
  assert.deepEqual(
    changes.map((c) => c.path),
    ['/home', '/home/a'],
  );
});

test('bac à sable des applications : pas d\'accès aux fichiers système', async () => {
  const fs = await new FileSystem({ store: new Namespace(new MemoryBackend(), 'fs') }).mount();
  fs.mkdir('/home/Documents', { recursive: true });
  fs.mkdir('/system', { recursive: true, system: true });
  fs.writeFile('/system/version', 'Orion', { system: true });
  fs.mkdir('/data/notes', { recursive: true });
  fs.mkdir('/data/messages', { recursive: true });
  fs.writeFile('/data/messages/storage.json', '{}');
  const app = sandbox(fs, ['/home', '/tmp', '/data/notes']);

  app.writeFile('/home/Documents/a.txt', '/system/version');
  assert.equal(app.readFile('/home/Documents/a.txt'), '/system/version', 'un contenu qui ressemble à un chemin est permis');
  app.writeJSON('/data/notes/storage.json', { ok: true });
  assert.deepEqual(app.readdir('/home').map((e) => e.name), ['Documents']);
  for (const attempt of [
    () => app.readFile('/system/version'),
    () => app.readdir('/'),
    () => app.exists('/data/messages/storage.json'),
    () => app.readFile('/home/../system/version'),
    () => app.rename('/home/Documents/a.txt', '/system/a.txt'),
    () => app.copy('/system/version', '/home/v.txt'),
    () => [...app.walk('/data')],
    () => app.du(),
  ]) {
    assert.throws(attempt, (e) => e instanceof FsError && e.code === 'EACCES');
  }
  assert.equal(inUserSpace('/home/Photos/a.jpg'), true);
  assert.equal(inUserSpace('/homework'), false);
  assert.equal(inUserSpace('/tmp/x'), true);
  assert.equal(inUserSpace('/data/notes/x'), false);
});
