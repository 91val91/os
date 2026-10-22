/**
 * osh — l'interpréteur de commandes d'Orion OS.
 *
 * Gère les guillemets, variables ($VAR, ~), jokers (*, ?), tubes (|),
 * redirections (>, >>) et enchaînements (;, &&, ||). Les commandes
 * agissent directement sur les services du noyau.
 */
import { resolve, isTextMime, mimeFromName, inUserSpace } from './vfs.js';
import { evaluate, clean } from '../lib/expr.js';
import { displayName } from './contacts.js';

export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '');

const paint = (color, text) => `${ansi[color]}${text}${ansi.reset}`;

export class ShellError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.name = 'ShellError';
    this.status = status;
  }
}

// ───────────────────────── Analyse ─────────────────────────

const SPECIAL = ' \t|;>&\'"\\';

export function tokenize(line) {
  const tokens = [];
  let current = null;
  const push = () => {
    if (current) tokens.push(current);
    current = null;
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      push();
      i++;
      continue;
    }
    if (ch === '#' && !current) break;
    const op = ['&&', '||', '>>'].find((o) => line.startsWith(o, i)) ?? ('|;>'.includes(ch) ? ch : null);
    if (op) {
      push();
      tokens.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }
    current ??= { type: 'word', parts: [] };
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new ShellError('guillemet simple non fermé', 2);
      current.parts.push({ text: line.slice(i + 1, end), quote: "'" });
      i = end + 1;
    } else if (ch === '"') {
      let text = '';
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && '"\\$'.includes(line[j + 1] ?? '')) j++;
        text += line[j++];
      }
      if (j >= line.length) throw new ShellError('guillemet double non fermé', 2);
      current.parts.push({ text, quote: '"' });
      i = j + 1;
    } else if (ch === '\\') {
      current.parts.push({ text: line[i + 1] ?? '', quote: "'" });
      i += 2;
    } else if (ch === '&') {
      current.parts.push({ text: '&', quote: null });
      i++;
    } else {
      let j = i;
      while (j < line.length && !SPECIAL.includes(line[j])) j++;
      current.parts.push({ text: line.slice(i, j), quote: null });
      i = j;
    }
  }
  push();
  return tokens;
}

/** Transforme les jetons en une liste de pipelines enchaînés. */
export function parse(tokens) {
  const chain = [];
  let pipeline = [];
  let command = { words: [], redirect: null };
  const endCommand = () => {
    if (!command.words.length) {
      if (command.redirect) throw new ShellError('redirection sans commande', 2);
      return false;
    }
    pipeline.push(command);
    command = { words: [], redirect: null };
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'word') {
      command.words.push(t);
    } else if (t.value === '>' || t.value === '>>') {
      const target = tokens[++i];
      if (target?.type !== 'word') throw new ShellError('fichier de redirection manquant', 2);
      command.redirect = { append: t.value === '>>', target };
    } else if (t.value === '|') {
      if (!endCommand()) throw new ShellError('erreur de syntaxe près de « | »', 2);
    } else {
      if (!endCommand() && !pipeline.length) {
        if (t.value !== ';') throw new ShellError(`erreur de syntaxe près de « ${t.value} »`, 2);
        continue;
      }
      chain.push({ pipeline, next: t.value });
      pipeline = [];
    }
  }
  endCommand();
  if (pipeline.length) chain.push({ pipeline, next: null });
  return chain;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// ───────────────────────── Utilitaires ─────────────────────────

function parseFlags(args, known) {
  const flags = {};
  const rest = [];
  let options = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (/^-[a-zA-Z]+$/.test(a) && [...a.slice(1)].every((c) => known.includes(c))) {
      for (const c of a.slice(1)) flags[c] = true;
    } else if (/^-n$/.test(a) && known.includes('N')) {
      options.n = Number(args[++i]);
    } else if (/^-\d+$/.test(a) && known.includes('N')) {
      options.n = Number(a.slice(1));
    } else {
      rest.push(a);
    }
  }
  return { flags, rest, options };
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0).replace('.', ',')} ${units[unit]}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

function columns(items, width = 40) {
  const plain = items.map(stripAnsi);
  const longest = Math.max(...plain.map((s) => s.length), 1) + 2;
  const perLine = Math.max(1, Math.floor(width / longest));
  const lines = [];
  for (let i = 0; i < items.length; i += perLine) {
    lines.push(
      items
        .slice(i, i + perLine)
        .map((s, j) => (j === perLine - 1 || i + j === items.length - 1 ? s : s + ' '.repeat(longest - plain[i + j].length)))
        .join(''),
    );
  }
  return lines.join('\n');
}

function table(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => stripAnsi(String(r[col])).length)));
  return rows
    .map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : String(cell) + ' '.repeat(widths[col] - stripAnsi(String(cell)).length))).join('  '))
    .join('\n');
}

function parseValue(raw) {
  if (raw === 'null') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const FORTUNES = [
  '« Le code le plus rapide est celui qui ne s\'exécute jamais. »',
  '« La simplicité est la sophistication suprême. » — Léonard de Vinci',
  '« Il faut toujours viser la lune, car même en cas d\'échec, on atterrit dans les étoiles. » — Oscar Wilde',
  '« Un problème sans solution est un problème mal posé. » — Albert Einstein',
  '« La perfection est atteinte, non pas lorsqu\'il n\'y a plus rien à ajouter, mais lorsqu\'il n\'y a plus rien à retirer. » — Saint-Exupéry',
  '« Rien ne se perd, rien ne se crée, tout se transforme. » — Lavoisier',
];

const LOGO = [
  '        .-""""""-.     ',
  '      .\'  .----.  \'.   ',
  '     /   /  ()  \\   \\  ',
  '    |   |  ()()  |   | ',
  '     \\   \\  ()  /   /  ',
  '      \'.  \'----\'  .\'   ',
  '        \'-......-\'     ',
];

// ───────────────────────── Interpréteur ─────────────────────────

export class Shell {
  constructor(kernel, { cwd = '/home', user = 'user' } = {}) {
    this.k = kernel;
    this.cwd = cwd;
    this.history = [];
    this.lastStatus = 0;
    this.env = {
      HOME: '/home',
      USER: user,
      SHELL: '/system/bin/osh',
      PATH: '/system/bin',
      HOSTNAME: (kernel.settings?.get('deviceName') ?? 'orion').toLowerCase().replace(/\s+/g, '-'),
      LANG: 'fr_FR.UTF-8',
      OLDPWD: cwd,
    };
  }

  get prompt() {
    const home = this.env.HOME;
    const where = this.cwd === home ? '~' : this.cwd.startsWith(home + '/') ? '~' + this.cwd.slice(home.length) : this.cwd;
    return `${paint('green', `${this.env.USER}@${this.env.HOSTNAME}`)}:${paint('blue', where)}$ `;
  }

  path(p) {
    if (p === '~' || p?.startsWith('~/')) p = this.env.HOME + p.slice(1);
    return resolve(this.cwd, p ?? '.');
  }

  #expandWord(word) {
    let text = '';
    let globbable = false;
    word.parts.forEach((part, index) => {
      let value = part.text;
      if (part.quote !== "'") {
        value = value.replace(/\$(\?|\{(\w+)\}|\w+)/g, (_, name, braced) => {
          if (name === '?') return String(this.lastStatus);
          return this.env[braced ?? name] ?? '';
        });
      }
      if (!part.quote) {
        if (index === 0 && (value === '~' || value.startsWith('~/'))) value = this.env.HOME + value.slice(1);
        if (/[*?]/.test(value)) globbable = true;
      }
      text += value;
    });
    if (!globbable) return [text];
    const dir = text.includes('/') ? text.slice(0, text.lastIndexOf('/')) || '/' : '.';
    const pattern = text.slice(text.lastIndexOf('/') + 1);
    try {
      const re = globToRegExp(pattern);
      const matches = this.k.fs
        .readdir(this.path(dir))
        .filter((e) => re.test(e.name) && (pattern.startsWith('.') || !e.name.startsWith('.')))
        .map((e) => (dir === '.' ? e.name : `${dir.replace(/\/$/, '')}/${e.name}`));
      return matches.length ? matches : [text];
    } catch {
      return [text];
    }
  }

  expand(words) {
    return words.flatMap((w) => this.#expandWord(w));
  }

  /**
   * Exécute une ligne de commande.
   * @returns {Promise<{ output: string, status: number, clear: boolean, exit: boolean }>}
   */
  async run(line) {
    const flags = { clear: false, exit: false };
    const trimmed = String(line).trim();
    if (!trimmed) return { output: '', status: this.lastStatus, ...flags };
    if (this.history.at(-1) !== trimmed) this.history.push(trimmed);
    if (this.history.length > 200) this.history.shift();

    let chain;
    try {
      chain = parse(tokenize(trimmed));
    } catch (error) {
      this.lastStatus = error.status ?? 2;
      return { output: paint('red', `osh: ${error.message}`) + '\n', status: this.lastStatus, ...flags };
    }

    let output = '';
    let previous = null;
    for (const { pipeline, next } of chain) {
      const skip = (previous === '&&' && this.lastStatus !== 0) || (previous === '||' && this.lastStatus === 0);
      if (!skip) {
        const result = await this.#runPipeline(pipeline, flags);
        output += result.output;
        this.lastStatus = result.status;
        if (flags.exit) break;
      }
      previous = next;
    }
    return { output, status: this.lastStatus, ...flags };
  }

  async #runPipeline(pipeline, flags) {
    let stdin = '';
    let output = '';
    let status = 0;
    for (let i = 0; i < pipeline.length; i++) {
      const { words, redirect } = pipeline[i];
      const argv = this.expand(words);
      let result = '';
      try {
        result = await this.exec(argv, stdin, flags);
        status = 0;
      } catch (error) {
        status = error.status ?? 1;
        if (error.message) output += paint('red', `${argv[0]}: ${error.message}`) + '\n';
      }
      if (result && !result.endsWith('\n')) result += '\n';
      if (redirect) {
        try {
          const [target] = this.expand([redirect.target]);
          const path = this.path(target);
          const text = stripAnsi(result);
          if (redirect.append) this.k.fs.appendFile(path, text);
          else this.k.fs.writeFile(path, text);
        } catch (error) {
          output += paint('red', `osh: ${error.message}`) + '\n';
          status = 1;
        }
        result = '';
      }
      if (i < pipeline.length - 1) stdin = stripAnsi(result);
      else output += result;
    }
    return { output, status };
  }

  async exec(argv, stdin = '', flags = {}) {
    const [name, ...args] = argv;
    const command = COMMANDS[name] ?? COMMANDS[ALIASES[name]];
    if (!command) throw new ShellError('commande introuvable (tapez « help »)', 127);
    return (await command.run.call(this, { args, stdin, flags, k: this.k })) ?? '';
  }

  /** Complétion : renvoie les candidats pour le dernier mot de la ligne. */
  complete(line) {
    const match = /(\S*)$/.exec(line);
    const partial = match[1];
    const start = line.length - partial.length;
    const isCommand = !line.slice(0, start).trim() || /[|;&]\s*$/.test(line.slice(0, start));
    if (isCommand) {
      const names = [...Object.keys(COMMANDS), ...Object.keys(ALIASES)].filter((c) => c.startsWith(partial)).sort();
      return { start, candidates: names.map((n) => n + ' ') };
    }
    const slash = partial.lastIndexOf('/');
    const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
    const prefix = partial.slice(slash + 1);
    try {
      const entries = this.k.fs.readdir(this.path(dirPart || '.'));
      const candidates = entries
        .filter((e) => e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
        .map((e) => dirPart + e.name + (e.type === 'dir' ? '/' : ' '));
      return { start, candidates };
    } catch {
      return { start, candidates: [] };
    }
  }

  readInputs(files, stdin) {
    if (!files.length) return [{ name: '-', text: stdin }];
    return files.map((f) => {
      const path = this.path(f);
      const content = this.k.fs.readFile(path);
      return { name: f, text: content };
    });
  }
}

const ALIASES = { ll: 'ls', dir: 'ls', bc: 'calc', logcat: 'dmesg', cls: 'clear', am: 'open', quit: 'exit', '?': 'help' };

function lines(text) {
  const parts = String(text).split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function requireArgs(args, count, usage) {
  if (args.length < count) throw new ShellError(`usage : ${usage}`, 2);
}

/** @type {Record<string, { desc: string, usage?: string, run: (ctx: any) => any }>} */
const COMMANDS = {
  help: {
    desc: 'Liste les commandes disponibles',
    run() {
      const names = Object.keys(COMMANDS).sort();
      const width = Math.max(...names.map((n) => n.length)) + 2;
      return [
        paint('bold', 'Orion OS — osh, commandes disponibles :'),
        ...names.map((n) => `  ${paint('cyan', n.padEnd(width))}${COMMANDS[n].desc}`),
        '',
        paint('gray', 'Opérateurs : | > >> ; && ||   Variables : $HOME $USER $?   Jokers : * ?'),
      ].join('\n');
    },
  },
  man: {
    desc: 'Affiche l\'aide d\'une commande',
    usage: 'man <commande>',
    run({ args }) {
      requireArgs(args, 1, 'man <commande>');
      const cmd = COMMANDS[args[0]] ?? COMMANDS[ALIASES[args[0]]];
      if (!cmd) throw new ShellError(`aucune page de manuel pour ${args[0]}`);
      return `${paint('bold', args[0])} — ${cmd.desc}\n\nUsage : ${cmd.usage ?? args[0]}`;
    },
  },
  echo: {
    desc: 'Affiche du texte',
    usage: 'echo [-n] texte…',
    run({ args }) {
      if (args[0] === '-n') return args.slice(1).join(' ');
      return args.join(' ') + '\n';
    },
  },
  pwd: { desc: 'Affiche le dossier courant', run() { return this.cwd; } },
  true: { desc: 'Ne fait rien, avec succès', run() {} },
  false: {
    desc: 'Ne fait rien, en échec',
    run() {
      throw new ShellError('', 1);
    },
  },
  cd: {
    desc: 'Change de dossier',
    usage: 'cd [dossier | - | ~]',
    run({ args, k }) {
      const target = args[0] === '-' ? this.env.OLDPWD : args[0] ?? this.env.HOME;
      const path = this.path(target);
      if (!k.fs.exists(path)) throw new ShellError(`${target} : aucun fichier ou dossier de ce nom`);
      if (!k.fs.isDir(path)) throw new ShellError(`${target} : n'est pas un dossier`);
      this.env.OLDPWD = this.cwd;
      this.cwd = path;
      this.env.PWD = path;
      return args[0] === '-' ? path : '';
    },
  },
  ls: {
    desc: 'Liste le contenu d\'un dossier',
    usage: 'ls [-l] [-a] [-1] [chemin…]',
    run({ args, k }) {
      const { flags, rest } = parseFlags(args, 'la1h');
      const targets = rest.length ? rest : ['.'];
      const blocks = targets.map((target) => {
        const path = this.path(target);
        const stat = k.fs.stat(path);
        const entries = stat.type === 'dir' ? k.fs.readdir(path).filter((e) => flags.a || !e.name.startsWith('.')) : [stat];
        const name = (e) => (e.type === 'dir' ? paint('blue', paint('bold', e.name + '/')) : e.mime?.startsWith('image/') ? paint('magenta', e.name) : e.name);
        let body;
        if (flags.l) {
          body = entries.length
            ? table(
                entries.map((e) => [
                  paint('gray', (e.type === 'dir' ? 'd' : '-') + (e.readonly ? 'r--r--r--' : e.type === 'dir' ? 'rwxr-xr-x' : 'rw-r--r--')),
                  formatSize(e.size).padStart(8),
                  new Date(e.mtime).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
                  name(e),
                ]),
              )
            : '';
        } else if (flags['1']) {
          body = entries.map(name).join('\n');
        } else {
          body = columns(entries.map(name));
        }
        return targets.length > 1 ? `${target}:\n${body}` : body;
      });
      return blocks.join('\n\n');
    },
  },
  cat: {
    desc: 'Affiche le contenu de fichiers',
    usage: 'cat [fichier…]',
    run({ args, stdin, k }) {
      return this.readInputs(args, stdin)
        .map(({ name, text }) => {
          if (name !== '-' && !isTextMime(k.fs.stat(this.path(name)).mime) && text.startsWith('data:')) {
            const st = k.fs.stat(this.path(name));
            return paint('gray', `[fichier binaire : ${st.mime}, ${formatSize(st.size)}]`);
          }
          return text;
        })
        .join('');
    },
  },
  touch: {
    desc: 'Crée un fichier vide ou met à jour sa date',
    usage: 'touch fichier…',
    run({ args, k }) {
      requireArgs(args, 1, 'touch fichier…');
      for (const f of args) {
        const path = this.path(f);
        k.fs.writeFile(path, k.fs.exists(path) ? k.fs.readFile(path) : '');
      }
    },
  },
  mkdir: {
    desc: 'Crée des dossiers',
    usage: 'mkdir [-p] dossier…',
    run({ args, k }) {
      const { flags, rest } = parseFlags(args, 'p');
      requireArgs(rest, 1, 'mkdir [-p] dossier…');
      rest.forEach((d) => k.fs.mkdir(this.path(d), { recursive: Boolean(flags.p) }));
    },
  },
  rm: {
    desc: 'Supprime des fichiers ou dossiers',
    usage: 'rm [-r] [-f] chemin…',
    run({ args, k }) {
      const { flags, rest } = parseFlags(args, 'rfRv');
      requireArgs(rest, 1, 'rm [-r] [-f] chemin…');
      for (const target of rest) {
        const path = this.path(target);
        if (k.fs.isDir(path) && !(flags.r || flags.R)) throw new ShellError(`${target} : est un dossier (utilisez -r)`);
        k.fs.rm(path, { recursive: Boolean(flags.r || flags.R), force: Boolean(flags.f) });
      }
    },
  },
  rmdir: {
    desc: 'Supprime un dossier vide',
    usage: 'rmdir dossier',
    run({ args, k }) {
      requireArgs(args, 1, 'rmdir dossier');
      const path = this.path(args[0]);
      if (!k.fs.isDir(path)) throw new ShellError(`${args[0]} : n'est pas un dossier`);
      k.fs.rm(path);
    },
  },
  mv: {
    desc: 'Déplace ou renomme',
    usage: 'mv source… destination',
    run({ args, k }) {
      requireArgs(args, 2, 'mv source… destination');
      const dest = this.path(args.at(-1));
      args.slice(0, -1).forEach((src) => k.fs.rename(this.path(src), dest));
    },
  },
  cp: {
    desc: 'Copie des fichiers',
    usage: 'cp [-r] source… destination',
    run({ args, k }) {
      const { flags, rest } = parseFlags(args, 'rR');
      requireArgs(rest, 2, 'cp [-r] source… destination');
      const dest = this.path(rest.at(-1));
      for (const src of rest.slice(0, -1)) {
        if (k.fs.isDir(this.path(src)) && !(flags.r || flags.R)) throw new ShellError(`${src} : est un dossier (utilisez -r)`);
        k.fs.copy(this.path(src), dest);
      }
    },
  },
  head: {
    desc: 'Affiche le début d\'un texte',
    usage: 'head [-n N] [fichier]',
    run({ args, stdin }) {
      const { rest, options } = parseFlags(args, 'N');
      return this.readInputs(rest, stdin).map(({ text }) => lines(text).slice(0, options.n ?? 10).join('\n')).join('\n');
    },
  },
  tail: {
    desc: 'Affiche la fin d\'un texte',
    usage: 'tail [-n N] [fichier]',
    run({ args, stdin }) {
      const { rest, options } = parseFlags(args, 'N');
      return this.readInputs(rest, stdin).map(({ text }) => lines(text).slice(-(options.n ?? 10)).join('\n')).join('\n');
    },
  },
  wc: {
    desc: 'Compte lignes, mots et caractères',
    usage: 'wc [-l|-w|-c] [fichier…]',
    run({ args, stdin }) {
      const { flags, rest } = parseFlags(args, 'lwc');
      return this.readInputs(rest, stdin)
        .map(({ name, text }) => {
          const counts = { l: lines(text).length, w: text.split(/\s+/).filter(Boolean).length, c: text.length };
          const chosen = ['l', 'w', 'c'].filter((f) => flags[f]);
          const values = (chosen.length ? chosen : ['l', 'w', 'c']).map((f) => String(counts[f]).padStart(chosen.length === 1 ? 0 : 6));
          return values.join(' ') + (name !== '-' ? ` ${name}` : '');
        })
        .join('\n');
    },
  },
  grep: {
    desc: 'Recherche un motif dans du texte',
    usage: 'grep [-i] [-v] [-n] [-c] motif [fichier…]',
    run({ args, stdin }) {
      const { flags, rest } = parseFlags(args, 'ivnc');
      requireArgs(rest, 1, 'grep [-i] [-v] [-n] motif [fichier…]');
      const [pattern, ...files] = rest;
      let re;
      try {
        re = new RegExp(pattern, flags.i ? 'i' : '');
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.i ? 'i' : '');
      }
      const highlight = new RegExp(re.source, flags.i ? 'gi' : 'g');
      const out = [];
      let count = 0;
      for (const { name, text } of this.readInputs(files, stdin)) {
        lines(text).forEach((line, index) => {
          if (re.test(line) === Boolean(flags.v)) return;
          count++;
          const shown = flags.v ? line : line.replace(highlight, (m) => paint('red', paint('bold', m)));
          out.push(`${files.length > 1 ? paint('magenta', name) + ':' : ''}${flags.n ? paint('green', index + 1) + ':' : ''}${shown}`);
        });
      }
      if (flags.c) return String(count);
      if (!count) throw new ShellError('', 1);
      return out.join('\n');
    },
  },
  sort: {
    desc: 'Trie des lignes',
    usage: 'sort [-r] [-n] [fichier]',
    run({ args, stdin }) {
      const { flags, rest } = parseFlags(args, 'rnu');
      let all = this.readInputs(rest, stdin).flatMap(({ text }) => lines(text));
      all.sort(flags.n ? (a, b) => parseFloat(a) - parseFloat(b) : (a, b) => a.localeCompare(b, 'fr'));
      if (flags.u) all = [...new Set(all)];
      if (flags.r) all.reverse();
      return all.join('\n');
    },
  },
  uniq: {
    desc: 'Supprime les lignes consécutives en double',
    usage: 'uniq [-c] [fichier]',
    run({ args, stdin }) {
      const { flags, rest } = parseFlags(args, 'c');
      const out = [];
      for (const line of this.readInputs(rest, stdin).flatMap(({ text }) => lines(text))) {
        if (out.length && out.at(-1).line === line) out.at(-1).n++;
        else out.push({ line, n: 1 });
      }
      return out.map(({ line, n }) => (flags.c ? `${String(n).padStart(4)} ${line}` : line)).join('\n');
    },
  },
  seq: {
    desc: 'Affiche une suite de nombres',
    usage: 'seq [début] fin',
    run({ args }) {
      requireArgs(args, 1, 'seq [début] fin');
      const [from, to] = args.length > 1 ? [Number(args[0]), Number(args[1])] : [1, Number(args[0])];
      if (!Number.isFinite(from) || !Number.isFinite(to) || Math.abs(to - from) > 10_000) throw new ShellError('bornes invalides');
      const step = from <= to ? 1 : -1;
      const out = [];
      for (let i = from; step > 0 ? i <= to : i >= to; i += step) out.push(i);
      return out.join('\n');
    },
  },
  tree: {
    desc: 'Affiche l\'arborescence d\'un dossier',
    usage: 'tree [dossier]',
    run({ args, k }) {
      const root = this.path(args[0] ?? '.');
      if (!k.fs.isDir(root)) throw new ShellError(`${args[0]} : n'est pas un dossier`);
      const out = [paint('blue', paint('bold', args[0] ?? '.'))];
      let dirs = 0;
      let files = 0;
      const walk = (path, indent) => {
        const entries = k.fs.readdir(path).filter((e) => !e.name.startsWith('.'));
        entries.forEach((e, i) => {
          const last = i === entries.length - 1;
          out.push(`${indent}${last ? '└── ' : '├── '}${e.type === 'dir' ? paint('blue', paint('bold', e.name)) : e.name}`);
          if (e.type === 'dir') {
            dirs++;
            walk(e.path, indent + (last ? '    ' : '│   '));
          } else files++;
        });
      };
      walk(root, '');
      out.push('', `${dirs} dossier(s), ${files} fichier(s)`);
      return out.join('\n');
    },
  },
  find: {
    desc: 'Recherche des fichiers',
    usage: 'find [chemin] [-name motif] [-type f|d]',
    run({ args, k }) {
      let start = '.';
      let name = null;
      let type = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-name') name = globToRegExp(args[++i] ?? '*');
        else if (args[i] === '-type') type = args[++i] === 'd' ? 'dir' : 'file';
        else start = args[i];
      }
      const root = this.path(start);
      const out = [];
      for (const entry of k.fs.walk(root)) {
        if (name && !name.test(entry.name)) continue;
        if (type && entry.type !== type) continue;
        const rel = start === '.' ? '.' + entry.path.slice(root === '/' ? 0 : root.length) : entry.path;
        out.push(rel);
      }
      return out.join('\n');
    },
  },
  stat: {
    desc: 'Informations détaillées sur un fichier',
    usage: 'stat fichier',
    run({ args, k }) {
      requireArgs(args, 1, 'stat fichier');
      const st = k.fs.stat(this.path(args[0]));
      return [
        `  Fichier : ${st.path}`,
        `   Taille : ${formatSize(st.size)} (${st.size} octets)`,
        `     Type : ${st.type === 'dir' ? 'dossier' : 'fichier'} — ${st.mime}`,
        `    Accès : ${st.readonly ? 'lecture seule' : 'lecture/écriture'}`,
        ` Création : ${new Date(st.ctime).toLocaleString('fr-FR')}`,
        `   Modif. : ${new Date(st.mtime).toLocaleString('fr-FR')}`,
      ].join('\n');
    },
  },
  du: {
    desc: 'Espace utilisé par un dossier',
    usage: 'du [chemin…]',
    run({ args, k }) {
      const targets = args.length ? args : ['.'];
      return targets.map((t) => `${formatSize(k.fs.du(this.path(t))).padEnd(10)}${t}`).join('\n');
    },
  },
  df: {
    desc: 'Espace de stockage de l\'appareil',
    async run({ k }) {
      const used = k.fs.du('/');
      let quota = null;
      try {
        quota = (await globalThis.navigator?.storage?.estimate?.())?.quota ?? null;
      } catch {
        /* inconnu */
      }
      const rows = [['Système de fichiers', 'Utilisé', 'Disponible', 'Monté sur']];
      rows.push([`orionfs (${k.backend})`, formatSize(used), quota ? formatSize(Math.max(0, quota - used)) : '—', '/']);
      return table(rows);
    },
  },
  date: {
    desc: 'Affiche la date et l\'heure',
    run({ k }) {
      return new Date(k.now()).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
    },
  },
  cal: {
    desc: 'Affiche le calendrier du mois',
    run({ k }) {
      const now = new Date(k.now());
      const year = now.getFullYear();
      const month = now.getMonth();
      const title = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      const out = [title.padStart(Math.floor((20 + title.length) / 2)), 'lu ma me je ve sa di'];
      const first = (new Date(year, month, 1).getDay() + 6) % 7;
      const days = new Date(year, month + 1, 0).getDate();
      let line = '   '.repeat(first);
      for (let d = 1; d <= days; d++) {
        const cell = String(d).padStart(2);
        line += (d === now.getDate() ? paint('bold', `\x1b[7m${cell}`) : cell) + ' ';
        if ((first + d) % 7 === 0) {
          out.push(line.trimEnd());
          line = '';
        }
      }
      if (line) out.push(line.trimEnd());
      return out.join('\n');
    },
  },
  uptime: {
    desc: 'Durée depuis le démarrage',
    run({ k }) {
      const procs = k.processes.list().length;
      return `actif depuis ${formatUptime(k.device.uptime())}, ${procs} processus`;
    },
  },
  uname: {
    desc: 'Informations sur le système',
    usage: 'uname [-a]',
    run({ args, k }) {
      if (args.includes('-a')) return `OrionOS ${this.env.HOSTNAME} ${k.os.version} ${k.os.build} ${k.os.kernel} web`;
      return 'OrionOS';
    },
  },
  whoami: { desc: 'Nom de l\'utilisateur courant', run() { return this.env.USER; } },
  users: {
    desc: 'Comptes de l\'appareil',
    run({ k }) {
      if (!k.accounts) return this.env.USER;
      // Une entrée sur deux lignes : lisible sur un écran de téléphone étroit.
      const current = k.account?.id;
      return k.accounts
        .list()
        .map((a) => `${a.id === current ? '*' : ' '} ${a.name || '—'}${a.owner ? ' (propriétaire)' : ''}${a.email ? `\n    ${a.email}` : ''}`)
        .join('\n');
    },
  },
  hostname: { desc: 'Nom de l\'appareil', run() { return this.env.HOSTNAME; } },
  env: {
    desc: 'Variables d\'environnement',
    run() {
      return Object.entries({ ...this.env, PWD: this.cwd }).map(([key, value]) => `${key}=${value}`).join('\n');
    },
  },
  export: {
    desc: 'Définit une variable',
    usage: 'export NOM=valeur',
    run({ args }) {
      for (const a of args) {
        const i = a.indexOf('=');
        if (i <= 0) throw new ShellError(`affectation invalide : ${a}`);
        this.env[a.slice(0, i)] = a.slice(i + 1);
      }
    },
  },
  unset: {
    desc: 'Supprime une variable',
    run({ args }) {
      args.forEach((a) => delete this.env[a]);
    },
  },
  history: {
    desc: 'Historique des commandes',
    run() {
      return this.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n');
    },
  },
  clear: {
    desc: 'Efface l\'écran',
    run({ flags }) {
      flags.clear = true;
    },
  },
  exit: {
    desc: 'Ferme le terminal',
    run({ flags }) {
      flags.exit = true;
    },
  },
  which: {
    desc: 'Emplacement d\'une commande',
    run({ args }) {
      return args.map((a) => (COMMANDS[a] || ALIASES[a] ? `/system/bin/${a}` : `${a} : introuvable`)).join('\n');
    },
  },
  sleep: {
    desc: 'Attend N secondes',
    usage: 'sleep secondes',
    async run({ args }) {
      const seconds = Math.min(Number(args[0]) || 0, 30);
      await new Promise((r) => setTimeout(r, seconds * 1000));
    },
  },
  ps: {
    desc: 'Liste les processus',
    run({ k }) {
      const rows = [['PID', 'APPLICATION', 'ÉTAT', 'DURÉE']];
      rows.push(['1', 'kernel', paint('green', 'running'), formatUptime(k.device.uptime())]);
      rows.push(['2', 'systemui', paint('green', 'running'), formatUptime(k.device.uptime())]);
      for (const p of k.processes.list()) {
        const color = p.state === 'foreground' ? 'green' : 'yellow';
        rows.push([String(p.pid), p.appId, paint(color, p.state), formatUptime(k.now() - p.startedAt)]);
      }
      return table(rows);
    },
  },
  kill: {
    desc: 'Arrête un processus',
    usage: 'kill [-9] pid…',
    run({ args, k }) {
      const pids = args.filter((a) => !a.startsWith('-'));
      requireArgs(pids, 1, 'kill [-9] pid…');
      for (const raw of pids) {
        const pid = Number(raw);
        if (pid === 1 || pid === 2) throw new ShellError(`(${pid}) - Opération non permise`);
        if (!k.processes.kill(pid, 'kill')) throw new ShellError(`(${raw}) - Aucun processus de ce type`);
      }
    },
  },
  killall: {
    desc: 'Arrête une application par son nom',
    usage: 'killall application',
    run({ args, k }) {
      requireArgs(args, 1, 'killall application');
      if (!k.processes.killApp(args[0], 'kill')) throw new ShellError(`${args[0]} : aucun processus trouvé`);
    },
  },
  open: {
    desc: 'Ouvre une application, un fichier ou une URL',
    usage: 'open <application | fichier | url>',
    async run({ args, k }) {
      requireArgs(args, 1, 'open <application | fichier | url>');
      const target = args.join(' ');
      if (/^https?:\/\//.test(target)) {
        await k.am.start({ action: 'view', type: 'text/uri-list', data: { url: target } });
        return;
      }
      const lower = target.toLowerCase();
      const pkg = k.packages.list().find((p) => p.id === lower || p.name.toLowerCase() === lower);
      if (pkg) {
        await k.am.start({ app: pkg.id, action: 'main' });
        return;
      }
      const path = this.path(target);
      if (k.fs.exists(path) && !inUserSpace(path)) throw new ShellError(`${target} : les applications n'ont pas accès aux fichiers système (lisez-le avec cat)`);
      if (k.fs.exists(path) && !k.fs.isDir(path)) {
        await k.am.start({ action: 'view', type: k.fs.stat(path).mime ?? mimeFromName(path), data: { path } });
        return;
      }
      if (k.fs.isDir(path)) {
        await k.am.start({ app: 'files', action: 'view', data: { path } });
        return;
      }
      throw new ShellError(`${target} : application ou fichier introuvable`);
    },
  },
  apps: {
    desc: 'Liste les applications installées',
    run({ k }) {
      return table([['ID', 'NOM', 'VERSION'], ...k.packages.list().map((p) => [paint('cyan', p.id), p.name, p.version])]);
    },
  },
  pm: {
    desc: 'Gestionnaire de paquets',
    usage: 'pm list [-a] | install <id> | uninstall <id> | info <id>',
    async run({ args, k }) {
      const [sub, id] = args;
      switch (sub) {
        case 'list': {
          const all = args.includes('-a');
          return k.packages
            .list({ installed: all ? null : true })
            .map((p) => `${k.packages.isInstalled(p.id) ? paint('green', '●') : paint('gray', '○')} ${p.id.padEnd(12)} ${p.name}${p.system ? paint('gray', ' (système)') : ''}`)
            .join('\n');
        }
        case 'install': {
          requireArgs(args, 2, 'pm install <id>');
          const pkg = await k.packages.install(id);
          return `${paint('green', '✔')} ${pkg.name} ${pkg.version} installé`;
        }
        case 'uninstall':
        case 'remove': {
          requireArgs(args, 2, 'pm uninstall <id>');
          await k.packages.uninstall(id);
          return `${paint('green', '✔')} ${id} désinstallé`;
        }
        case 'info': {
          requireArgs(args, 2, 'pm info <id>');
          const pkg = k.packages.get(id);
          if (!pkg) throw new ShellError(`paquet introuvable : ${id}`);
          return [
            `${paint('bold', pkg.name)} (${pkg.id}) ${pkg.version}`,
            `Catégorie : ${pkg.category}`,
            `Installé : ${k.packages.isInstalled(id) ? 'oui' : 'non'}${pkg.system ? ' — application système' : ''}`,
            `Permissions : ${pkg.permissions.join(', ') || 'aucune'}`,
            `Intents : ${pkg.intents.map((f) => `${f.action}${f.types ? ` (${f.types.join(', ')})` : ''}`).join(', ') || 'aucun'}`,
            pkg.description,
          ].join('\n');
        }
        default:
          throw new ShellError('usage : pm list [-a] | install <id> | uninstall <id> | info <id>', 2);
      }
    },
  },
  notify: {
    desc: 'Publie une notification',
    usage: 'notify titre [texte]',
    run({ args, k }) {
      requireArgs(args, 1, 'notify titre [texte]');
      k.notifications.post({ appId: 'terminal', title: args[0], body: args.slice(1).join(' ') });
    },
  },
  settings: {
    desc: 'Lit ou modifie les réglages',
    usage: 'settings list | get <clé> | set <clé> <valeur>',
    run({ args, k }) {
      const [sub, key, ...value] = args;
      if (sub === 'list' || !sub) {
        return Object.entries(k.settings.all())
          .filter(([key]) => key !== 'passcode' && key !== 'homeLayout' && !key.includes('.'))
          .map(([key, v]) => `${paint('cyan', key)} = ${JSON.stringify(v)}`)
          .join('\n');
      }
      if (sub === 'get') {
        requireArgs(args, 2, 'settings get <clé>');
        if (!k.settings.has(key)) throw new ShellError(`réglage inconnu : ${key}`);
        return JSON.stringify(key === 'passcode' ? (k.settings.get(key) ? '••••' : null) : k.settings.get(key));
      }
      if (sub === 'set') {
        requireArgs(args, 3, 'settings set <clé> <valeur>');
        if (key === 'passcode') throw new ShellError('utilisez l\'application Réglages pour le code');
        if (!k.settings.has(key)) throw new ShellError(`réglage inconnu : ${key}`);
        k.settings.set(key, parseValue(value.join(' ')));
        return `${key} = ${JSON.stringify(k.settings.get(key))}`;
      }
      throw new ShellError('usage : settings list | get <clé> | set <clé> <valeur>', 2);
    },
  },
  dmesg: {
    desc: 'Journal du système (aussi : logcat)',
    usage: 'dmesg [-c] [-t tag]',
    run({ args, k }) {
      if (args.includes('-c')) {
        k.log.clear();
        return '';
      }
      const tagIndex = args.indexOf('-t');
      const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
      const colors = { error: 'red', warn: 'yellow', debug: 'gray' };
      return k.log
        .list({ tag })
        .map((e) => (colors[e.level] ? paint(colors[e.level], k.log.format(e)) : k.log.format(e)))
        .join('\n');
    },
  },
  battery: {
    desc: 'État de la batterie',
    run({ k }) {
      const b = k.device.battery;
      const pct = Math.round(b.level * 100);
      const bar = '█'.repeat(Math.round(pct / 10)).padEnd(10, '░');
      return `${paint(pct <= 20 ? 'red' : 'green', bar)} ${pct} %${b.charging ? ' ⚡ en charge' : ''}${b.simulated ? paint('gray', ' (simulée)') : ''}`;
    },
  },
  calc: {
    desc: 'Calculatrice (aussi : bc)',
    usage: 'calc expression',
    run({ args, stdin }) {
      const exprs = args.length ? [args.join(' ')] : lines(stdin);
      return exprs
        .filter((e) => e.trim())
        .map((e) => {
          try {
            return String(clean(evaluate(e)));
          } catch (error) {
            throw new ShellError(error.message);
          }
        })
        .join('\n');
    },
  },
  alarms: {
    desc: 'Liste les alarmes planifiées',
    run({ k }) {
      const list = k.alarms.list();
      if (!list.length) return 'Aucune alarme.';
      return table([
        ['ID', 'TYPE', 'APP', 'DÉCLENCHEMENT', 'ACTIVE'],
        ...list.map((a) => [String(a.id), a.kind, a.appId, new Date(a.at).toLocaleString('fr-FR'), a.enabled ? 'oui' : 'non']),
      ]);
    },
  },
  contacts: {
    desc: 'Liste les contacts',
    run({ k }) {
      return table([['NOM', 'TÉLÉPHONE'], ...k.contacts.list().map((c) => [displayName(c), c.phone])]);
    },
  },
  sms: {
    desc: 'Envoie un SMS',
    usage: 'sms numéro texte…',
    run({ args, k }) {
      requireArgs(args, 2, 'sms numéro texte…');
      const m = k.telephony.sendSms(args[0], { text: args.slice(1).join(' ') });
      return m.status === 'failed' ? paint('red', 'Échec de l\'envoi (pas de réseau)') : 'Message envoyé.';
    },
  },
  call: {
    desc: 'Appelle un numéro',
    usage: 'call numéro',
    run({ args, k }) {
      requireArgs(args, 1, 'call numéro');
      k.telephony.dial(args.join(' '));
      return `Appel de ${args.join(' ')}…`;
    },
  },
  sim: {
    desc: 'Simule un événement du modem',
    usage: 'sim call <numéro> | sim sms <numéro> <texte>',
    run({ args, k }) {
      const [what, number, ...text] = args;
      if (what === 'call' && number) {
        k.telephony.incoming(number);
        return 'Appel entrant simulé.';
      }
      if (what === 'sms' && number) {
        k.telephony.receiveSms(number, text.join(' ') || 'Coucou 👋');
        return 'SMS entrant simulé.';
      }
      throw new ShellError('usage : sim call <numéro> | sim sms <numéro> <texte>', 2);
    },
  },
  net: {
    desc: 'État du réseau (connexion, Wi‑Fi, modem, pont matériel)',
    run({ k }) {
      const n = k.network.state;
      const t = k.telephony.network;
      const rows = [
        ['Connexion', `${n.online ? paint('green', 'en ligne') : paint('red', 'hors ligne')} · ${n.type}${n.airplane ? ' · mode avion' : ''}`],
        ['Pont matériel', k.bridge.available ? `orion-server ${k.bridge.info?.version ?? ''}${k.bridge.simulated ? ' (simulé)' : ''} : ${Object.keys(k.bridge.capabilities).filter((c) => k.bridge.capabilities[c]).join(', ')}` : 'absent (API du navigateur)'],
        ['Wi‑Fi', n.wifi.controllable ? (n.wifi.enabled ? n.wifi.connected ? `${n.wifi.connected.ssid} (${n.wifi.connected.signal} %)` : 'non connecté' : 'désactivé') : 'géré par le système du téléphone'],
        ['Téléphonie', `${t.mode} · ${t.operator}${t.type ? ` · ${t.type}` : ''}`],
        n.ip ? ['Adresse IP', n.ip] : null,
        n.quality ? ['Qualité estimée', `${n.quality}${n.downlink ? ` · ${n.downlink} Mb/s` : ''}${n.rtt ? ` · ${n.rtt} ms` : ''}`] : null,
      ].filter(Boolean);
      return rows.map(([key, value]) => `${paint('cyan', key.padEnd(16))}${value}`).join('\n');
    },
  },
  wifi: {
    desc: 'Wi‑Fi (avec orion-server)',
    usage: 'wifi [scan | connect <réseau> [mot de passe] | disconnect | on | off]',
    async run({ args, k }) {
      const net = k.network;
      if (!net.controllable) throw new ShellError('Le Wi‑Fi est géré par le système de cet appareil (pas de pont orion-server).');
      const [what, ssid, password] = args;
      if (what === 'on' || what === 'off') await net.setWifiEnabled(what === 'on');
      else if (what === 'connect') {
        requireArgs(args, 2, 'wifi connect <réseau> [mot de passe]');
        await net.connect(ssid, password);
        return `Connecté à ${ssid}.`;
      } else if (what === 'disconnect') await net.disconnect();
      else if (what && what !== 'scan') throw new ShellError(`usage : ${COMMANDS.wifi.usage}`, 2);
      const st = await net.refresh({ rescan: what === 'scan' });
      if (!st.wifi.enabled) return 'Wi‑Fi désactivé.';
      return table([['', 'RÉSEAU', 'SIGNAL', 'SÉCURITÉ'], ...st.wifi.networks.map((w) => [w.active ? '*' : '', w.ssid, `${w.signal} %`, w.security || 'ouvert'])]);
    },
  },
  bt: {
    desc: 'Bluetooth',
    usage: 'bt [scan | connect <id> | disconnect <id> | on | off]',
    async run({ args, k }) {
      const bt = k.bluetooth;
      if (!bt.available) throw new ShellError('Bluetooth indisponible sur cet appareil.');
      const [what, id] = args;
      if (what === 'on' || what === 'off') await bt.setPowered(what === 'on');
      else if (what === 'scan') {
        await bt.scan(8);
        return 'Recherche pendant 8 s… (relancez « bt » ensuite)';
      } else if (what === 'connect' || what === 'disconnect') {
        requireArgs(args, 2, `bt ${what} <id>`);
        await bt[what](id);
      } else if (what) throw new ShellError(`usage : ${COMMANDS.bt.usage}`, 2);
      if (!bt.enabled) return 'Bluetooth désactivé.';
      const devices = bt.devices();
      if (!devices.length) return 'Aucun appareil.';
      return table([['ID', 'NOM', 'ÉTAT', 'BATTERIE'], ...devices.map((d) => [d.id, d.name, d.connected ? 'connecté' : d.paired ? 'appairé' : 'découvert', d.battery != null ? `${d.battery} %` : ''])]);
    },
  },
  gps: {
    desc: 'Position actuelle (GPS ou navigateur)',
    async run({ k }) {
      const p = await k.location.current({ timeout: 15_000, maxAge: 5000 });
      return [
        `${paint('cyan', 'Position'.padEnd(12))}${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`,
        p.accuracy != null ? `${paint('cyan', 'Précision'.padEnd(12))}± ${Math.round(p.accuracy)} m` : null,
        p.alt != null ? `${paint('cyan', 'Altitude'.padEnd(12))}${Math.round(p.alt)} m` : null,
        p.speed != null ? `${paint('cyan', 'Vitesse'.padEnd(12))}${(p.speed * 3.6).toFixed(1)} km/h` : null,
        p.satellites != null ? `${paint('cyan', 'Satellites'.padEnd(12))}${p.satellites}` : null,
        `${paint('cyan', 'Source'.padEnd(12))}${p.source === 'gps' ? 'récepteur GPS (gpsd)' : 'navigateur'}`,
      ].filter(Boolean).join('\n');
    },
  },
  vibrate: {
    desc: 'Fait vibrer l\'appareil',
    run({ args, k }) {
      k.device.vibrate(Number(args[0]) || 200);
    },
  },
  lock: {
    desc: 'Verrouille l\'écran',
    run({ k }) {
      k.device.requestPower('lock');
    },
  },
  reboot: {
    desc: 'Redémarre le système',
    run({ k }) {
      k.device.requestPower('reboot');
      return 'Redémarrage…';
    },
  },
  poweroff: {
    desc: 'Éteint le système',
    run({ k }) {
      k.device.requestPower('shutdown');
      return 'Arrêt…';
    },
  },
  curl: {
    desc: 'Télécharge une URL (CORS requis)',
    usage: 'curl url',
    async run({ args }) {
      requireArgs(args, 1, 'curl url');
      try {
        const response = await fetch(args[0]);
        const text = await response.text();
        return text.length > 20_000 ? text.slice(0, 20_000) + '\n…' : text;
      } catch (error) {
        throw new ShellError(`échec : ${error.message}`);
      }
    },
  },
  fortune: {
    desc: 'Une citation au hasard',
    run() {
      return FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
    },
  },
  neofetch: {
    desc: 'Résumé du système',
    run({ k }) {
      const b = k.device.battery;
      const info = [
        `${paint('cyan', paint('bold', this.env.USER))}@${paint('cyan', paint('bold', this.env.HOSTNAME))}`,
        '─'.repeat(20),
        `${paint('cyan', 'OS')}: ${k.os.name} ${k.os.version} « ${k.os.codename} »`,
        `${paint('cyan', 'Noyau')}: ${k.os.kernel}`,
        `${paint('cyan', 'Uptime')}: ${formatUptime(k.device.uptime())}`,
        `${paint('cyan', 'Paquets')}: ${k.packages.list().length} (pm)`,
        `${paint('cyan', 'Shell')}: osh 1.0`,
        `${paint('cyan', 'Thème')}: ${k.settings.get('theme')}`,
        `${paint('cyan', 'Stockage')}: ${formatSize(k.fs.du('/'))} (${k.backend})`,
        `${paint('cyan', 'Batterie')}: ${Math.round(b.level * 100)} %${b.charging ? ' ⚡' : ''}`,
      ];
      const rows = Math.max(LOGO.length, info.length);
      const out = [];
      for (let i = 0; i < rows; i++) out.push(paint('blue', LOGO[i] ?? ' '.repeat(LOGO[0].length)) + (info[i] ?? ''));
      return out.join('\n');
    },
  },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);
