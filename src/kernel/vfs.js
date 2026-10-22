/**
 * Système de fichiers virtuel (VFS) hiérarchique et persistant.
 *
 * L'arborescence est gardée en mémoire (lectures synchrones) et chaque
 * modification est écrite de manière asynchrone dans le stockage. Les
 * contenus sont des chaînes : texte brut ou URL "data:" pour les binaires.
 */

const MESSAGES = {
  ENOENT: 'Aucun fichier ou dossier de ce nom',
  EEXIST: 'Le fichier existe déjà',
  ENOTDIR: "N'est pas un dossier",
  EISDIR: 'Est un dossier',
  ENOTEMPTY: "Le dossier n'est pas vide",
  EACCES: 'Permission refusée',
  EINVAL: 'Argument invalide',
};

export class FsError extends Error {
  constructor(code, path) {
    super(`${MESSAGES[code] ?? code} : ${path}`);
    this.name = 'FsError';
    this.code = code;
    this.path = path;
  }
}

export function normalize(path) {
  const parts = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

/** Espace de l'utilisateur : ses dossiers et les fichiers temporaires. Le reste est réservé au système. */
export const USER_SPACE = ['/home', '/tmp'];

const within = (path, roots) => {
  const p = normalize(path);
  return roots.some((root) => p === root || p.startsWith(`${root}/`));
};

export const inUserSpace = (path) => within(path, USER_SPACE);

/** Méthodes dont les deux premiers arguments sont des chemins (les autres n'en ont qu'un). */
const TWO_PATHS = new Set(['rename', 'copy']);

/**
 * Vue du système de fichiers limitée à `roots` : c'est celle que reçoivent les
 * applications (espace de l'utilisateur et leurs propres données). Les
 * fichiers système (/system, /data des autres apps…) leur sont refusés.
 */
export function sandbox(fs, roots) {
  return new Proxy(fs, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function' || key === 'constructor') return value;
      return (...args) => {
        for (let i = 0; i < (TWO_PATHS.has(key) ? 2 : 1); i++) {
          const path = typeof args[i] === 'string' ? args[i] : '/';
          if (!within(path, roots)) throw new FsError('EACCES', normalize(path));
        }
        return value.apply(target, args);
      };
    },
  });
}

export function resolve(cwd, path) {
  return normalize(String(path).startsWith('/') ? path : `${cwd}/${path}`);
}

export function dirname(path) {
  const p = normalize(path);
  return p === '/' ? '/' : normalize(p.slice(0, p.lastIndexOf('/')));
}

export function basename(path) {
  const p = normalize(path);
  return p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1);
}

export function extname(path) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

const MIME = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  html: 'text/html', js: 'text/javascript', css: 'text/css', log: 'text/plain', sh: 'text/x-sh',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  weba: 'audio/webm', webm: 'video/webm', mp4: 'video/mp4', pdf: 'application/pdf',
};

export function mimeFromName(name) {
  return MIME[extname(name)] ?? 'application/octet-stream';
}

export function isTextMime(mime) {
  return /^text\/|json|javascript|x-sh/.test(mime ?? '');
}

/** Taille approximative en octets d'un contenu (décode les URL data:base64). */
export function byteLength(content) {
  if (typeof content !== 'string') return 0;
  const comma = content.indexOf(',');
  if (content.startsWith('data:') && comma > 0 && content.slice(0, comma).endsWith(';base64')) {
    const b64 = content.length - comma - 1;
    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
    return Math.floor((b64 * 3) / 4) - padding;
  }
  if (content.length > 200_000) return content.length;
  return new TextEncoder().encode(content).length;
}

const isUnder = (path, prefix) => prefix === '/' || path === prefix || path.startsWith(prefix + '/');

export class FileSystem {
  #nodes = new Map();
  #watchers = new Set();

  constructor({ store = null, events = null, now = Date.now, readonly = ['/system'] } = {}) {
    this.store = store;
    this.events = events;
    this.now = now;
    this.readonly = readonly;
  }

  async mount() {
    if (this.store) {
      for (const [path, node] of await this.store.entries()) {
        if (node && (node.type === 'file' || node.type === 'dir')) this.#nodes.set(path, node);
      }
    }
    if (!this.#nodes.has('/')) this.#write('/', this.#dirNode());
    // Répare les dossiers parents manquants (stockage partiellement écrit).
    for (const path of [...this.#nodes.keys()]) {
      let parent = dirname(path);
      while (parent !== '/' && !this.#nodes.has(parent)) {
        this.#write(parent, this.#dirNode());
        parent = dirname(parent);
      }
    }
    return this;
  }

  #dirNode() {
    const t = this.now();
    return { type: 'dir', ctime: t, mtime: t };
  }

  #write(path, node) {
    this.#nodes.set(path, node);
    this.store?.put(path, node);
  }

  #remove(path) {
    this.#nodes.delete(path);
    this.store?.delete(path);
  }

  #notify(type, path) {
    const change = { type, path };
    for (const w of this.#watchers) {
      if (isUnder(path, w.prefix)) {
        try {
          w.fn(change);
        } catch (error) {
          console.error('[vfs] watcher', error);
        }
      }
    }
    this.events?.emit('fs:change', change);
  }

  #node(path) {
    const node = this.#nodes.get(path);
    if (!node) throw new FsError('ENOENT', path);
    return node;
  }

  #assertWritable(path, opts) {
    if (opts?.system) return;
    if (this.readonly.some((prefix) => isUnder(path, prefix))) throw new FsError('EACCES', path);
  }

  #assertParentDir(path) {
    const parent = dirname(path);
    const node = this.#nodes.get(parent);
    if (!node) throw new FsError('ENOENT', parent);
    if (node.type !== 'dir') throw new FsError('ENOTDIR', parent);
  }

  exists(path) {
    return this.#nodes.has(normalize(path));
  }

  isDir(path) {
    return this.#nodes.get(normalize(path))?.type === 'dir';
  }

  stat(path) {
    const p = normalize(path);
    const node = this.#node(p);
    return {
      path: p,
      name: basename(p),
      type: node.type,
      size: node.type === 'file' ? node.size ?? 0 : this.du(p),
      mime: node.type === 'file' ? node.mime : 'inode/directory',
      ctime: node.ctime,
      mtime: node.mtime,
      readonly: this.readonly.some((prefix) => isUnder(p, prefix)),
    };
  }

  readdir(path, { hidden = true } = {}) {
    const p = normalize(path);
    const node = this.#node(p);
    if (node.type !== 'dir') throw new FsError('ENOTDIR', p);
    const prefix = p === '/' ? '/' : p + '/';
    const out = [];
    for (const key of this.#nodes.keys()) {
      if (key === p || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      if (!hidden && rest.startsWith('.')) continue;
      out.push(this.stat(key));
    }
    return out.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, 'fr', { numeric: true }) : a.type === 'dir' ? -1 : 1,
    );
  }

  mkdir(path, { recursive = false, ...opts } = {}) {
    const p = normalize(path);
    if (this.#nodes.has(p)) {
      if (recursive && this.#nodes.get(p).type === 'dir') return;
      throw new FsError('EEXIST', p);
    }
    this.#assertWritable(p, opts);
    if (recursive) {
      const parent = dirname(p);
      if (parent !== p && !this.#nodes.has(parent)) this.mkdir(parent, { recursive, ...opts });
    }
    this.#assertParentDir(p);
    this.#write(p, this.#dirNode());
    this.#notify('mkdir', p);
  }

  writeFile(path, content, { mime, parents = false, ...opts } = {}) {
    const p = normalize(path);
    if (p === '/') throw new FsError('EISDIR', p);
    this.#assertWritable(p, opts);
    if (parents) this.mkdir(dirname(p), { recursive: true, ...opts });
    this.#assertParentDir(p);
    const existing = this.#nodes.get(p);
    if (existing?.type === 'dir') throw new FsError('EISDIR', p);
    const text = String(content ?? '');
    const t = this.now();
    this.#write(p, {
      type: 'file',
      content: text,
      mime: mime ?? existing?.mime ?? mimeFromName(p),
      size: byteLength(text),
      ctime: existing?.ctime ?? t,
      mtime: t,
    });
    this.#notify('write', p);
  }

  appendFile(path, content, opts) {
    const p = normalize(path);
    const previous = this.exists(p) ? this.readFile(p) : '';
    this.writeFile(p, previous + content, opts);
  }

  readFile(path) {
    const p = normalize(path);
    const node = this.#node(p);
    if (node.type === 'dir') throw new FsError('EISDIR', p);
    return node.content;
  }

  readJSON(path, fallback) {
    try {
      return JSON.parse(this.readFile(path));
    } catch (error) {
      if (fallback !== undefined) return fallback;
      throw error;
    }
  }

  writeJSON(path, value, opts = {}) {
    this.writeFile(path, JSON.stringify(value), { parents: true, mime: 'application/json', ...opts });
  }

  rm(path, { recursive = false, force = false, ...opts } = {}) {
    const p = normalize(path);
    if (!this.#nodes.has(p)) {
      if (force) return;
      throw new FsError('ENOENT', p);
    }
    if (p === '/') throw new FsError('EACCES', p);
    this.#assertWritable(p, opts);
    const node = this.#nodes.get(p);
    if (node.type === 'dir') {
      const children = [...this.#nodes.keys()].filter((k) => k.startsWith(p + '/'));
      if (children.length && !recursive) throw new FsError('ENOTEMPTY', p);
      children.forEach((k) => this.#remove(k));
    }
    this.#remove(p);
    this.#notify('delete', p);
  }

  rename(from, to, opts = {}) {
    const src = normalize(from);
    let dest = normalize(to);
    this.#node(src);
    if (this.isDir(dest)) dest = normalize(`${dest}/${basename(src)}`);
    if (src === dest) return dest;
    if (isUnder(dest, src)) throw new FsError('EINVAL', dest);
    if (this.#nodes.has(dest)) throw new FsError('EEXIST', dest);
    this.#assertWritable(src, opts);
    this.#assertWritable(dest, opts);
    this.#assertParentDir(dest);
    const moved = [...this.#nodes.entries()].filter(([k]) => isUnder(k, src));
    for (const [k] of moved) this.#remove(k);
    for (const [k, node] of moved) this.#write(dest + k.slice(src.length), node);
    this.#notify('delete', src);
    this.#notify('write', dest);
    return dest;
  }

  copy(from, to, opts = {}) {
    const src = normalize(from);
    let dest = normalize(to);
    const node = this.#node(src);
    if (this.isDir(dest)) dest = normalize(`${dest}/${basename(src)}`);
    if (isUnder(dest, src)) throw new FsError('EINVAL', dest);
    if (node.type === 'dir') {
      this.mkdir(dest, { recursive: true, ...opts });
      for (const child of this.readdir(src)) this.copy(child.path, `${dest}/${child.name}`, opts);
    } else {
      this.writeFile(dest, node.content, { mime: node.mime, ...opts });
    }
    return dest;
  }

  /** Parcourt récursivement un dossier (le dossier lui-même exclu). */
  *walk(path) {
    const p = normalize(path);
    for (const key of [...this.#nodes.keys()].sort()) {
      if (key !== p && isUnder(key, p)) yield this.stat(key);
    }
  }

  du(path = '/') {
    const p = normalize(path);
    let total = 0;
    for (const [key, node] of this.#nodes) {
      if (node.type === 'file' && isUnder(key, p)) total += node.size ?? 0;
    }
    return total;
  }

  /** Génère un nom libre : "photo.jpg" → "photo 2.jpg" si nécessaire. */
  uniquePath(path) {
    const p = normalize(path);
    if (!this.exists(p)) return p;
    const dir = dirname(p);
    const ext = extname(p);
    const stem = basename(p).slice(0, ext ? -(ext.length + 1) : undefined);
    for (let i = 2; ; i++) {
      const candidate = normalize(`${dir}/${stem} ${i}${ext ? '.' + ext : ''}`);
      if (!this.exists(candidate)) return candidate;
    }
  }

  watch(prefix, fn) {
    const watcher = { prefix: normalize(prefix), fn };
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }
}
