/**
 * Évaluateur d'expressions mathématiques sûr (sans eval) :
 * descente récursive avec priorités, multiplication implicite, fonctions,
 * constantes, pourcentages et factorielle.
 * Utilisé par la Calculatrice, le terminal (`calc`) et la recherche.
 */
export class ExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExprError';
  }
}

const FUNCTIONS = {
  sin: (x, deg) => Math.sin(deg ? (x * Math.PI) / 180 : x),
  cos: (x, deg) => Math.cos(deg ? (x * Math.PI) / 180 : x),
  tan: (x, deg) => Math.tan(deg ? (x * Math.PI) / 180 : x),
  asin: (x, deg) => (deg ? (Math.asin(x) * 180) / Math.PI : Math.asin(x)),
  acos: (x, deg) => (deg ? (Math.acos(x) * 180) / Math.PI : Math.acos(x)),
  atan: (x, deg) => (deg ? (Math.atan(x) * 180) / Math.PI : Math.atan(x)),
  sqrt: (x) => Math.sqrt(x),
  cbrt: (x) => Math.cbrt(x),
  ln: (x) => Math.log(x),
  log: (x) => Math.log10(x),
  exp: (x) => Math.exp(x),
  abs: (x) => Math.abs(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  round: (x) => Math.round(x),
};

const CONSTANTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: Math.PI * 2 };

const OPERATORS = { '×': '*', '÷': '/', '−': '-', '–': '-', '·': '*', '**': '^' };

export function tokenize(input) {
  const tokens = [];
  const src = String(input);
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === ' ' || ch === ' ') {
      i++;
      continue;
    }
    if (/[0-9.,]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.,]/.test(src[j])) j++;
      let raw = src.slice(i, j).replace(',', '.');
      if ((raw.match(/\./g) ?? []).length > 1) throw new ExprError(`Nombre invalide : ${src.slice(i, j)}`);
      // Notation scientifique : 1e5, 2.5E-3
      if (/[eE]/.test(src[j] ?? '') && /[0-9+-]/.test(src[j + 1] ?? '') && !/[a-z]/i.test(src[j + 2] ?? '')) {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        while (k < src.length && /[0-9]/.test(src[k])) k++;
        raw += src.slice(j, k);
        j = k;
      }
      if (raw === '.') throw new ExprError('Nombre invalide');
      tokens.push({ type: 'num', value: Number(raw) });
      i = j;
      continue;
    }
    if (src.startsWith('**', i)) {
      tokens.push({ type: 'op', value: '^' });
      i += 2;
      continue;
    }
    if (/[a-zπ]/i.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zπ]/i.test(src[j])) j++;
      tokens.push({ type: 'id', value: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (ch === '√') {
      tokens.push({ type: 'id', value: 'sqrt' });
      i++;
      continue;
    }
    const op = OPERATORS[ch] ?? ch;
    if ('+-*/^%!()'.includes(op)) {
      tokens.push({ type: op === '(' || op === ')' ? op : 'op', value: op });
      i++;
      continue;
    }
    throw new ExprError(`Caractère inattendu : ${ch}`);
  }
  return tokens;
}

function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) throw new ExprError('Factorielle définie pour les entiers positifs');
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/**
 * @param {string} input
 * @param {{ degrees?: boolean, variables?: Record<string, number> }} [options]
 */
export function evaluate(input, { degrees = false, variables = {} } = {}) {
  const tokens = tokenize(input);
  if (!tokens.length) throw new ExprError('Expression vide');
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (value) => peek()?.type === 'op' && peek().value === value;

  // Un facteur peut-il commencer ici ? (pour la multiplication implicite)
  const startsFactor = () => {
    const t = peek();
    return t && (t.type === 'num' || t.type === 'id' || t.type === '(');
  };

  function parseExpression() {
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = next().value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = next().value;
        const right = parseUnary();
        if (op === '/' && right === 0) throw new ExprError('Division par zéro');
        left = op === '*' ? left * right : left / right;
      } else if (isOp('%') && tokens[pos + 1] && ['num', 'id', '('].includes(tokens[pos + 1].type)) {
        next();
        const right = parseUnary();
        if (right === 0) throw new ExprError('Division par zéro');
        left %= right;
      } else if (startsFactor()) {
        left *= parseUnary();
      } else {
        return left;
      }
    }
  }

  function parseUnary() {
    if (isOp('-')) {
      next();
      return -parseUnary();
    }
    if (isOp('+')) {
      next();
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    if (isOp('^')) {
      next();
      return base ** parseUnary();
    }
    return base;
  }

  function parsePostfix() {
    let value = parsePrimary();
    for (;;) {
      if (isOp('!')) {
        next();
        value = factorial(value);
      } else if (isOp('%') && !(tokens[pos + 1] && ['num', 'id', '('].includes(tokens[pos + 1].type))) {
        next();
        value /= 100;
      } else {
        return value;
      }
    }
  }

  function parsePrimary() {
    const t = next();
    if (!t) throw new ExprError('Expression incomplète');
    if (t.type === 'num') return t.value;
    if (t.type === '(') {
      const value = parseExpression();
      if (peek()?.type === ')') next();
      // Parenthèse fermante facultative en fin d'expression (comme les calculatrices).
      else if (peek()) throw new ExprError('Parenthèse manquante');
      return value;
    }
    if (t.type === 'id') {
      if (t.value in variables) return variables[t.value];
      if (t.value in CONSTANTS) return CONSTANTS[t.value];
      const fn = FUNCTIONS[t.value];
      if (fn) {
        const arg = peek()?.type === '(' ? parsePrimary() : parseUnary();
        return fn(arg, degrees);
      }
      throw new ExprError(`Inconnu : ${t.value}`);
    }
    throw new ExprError(`Symbole inattendu : ${t.value}`);
  }

  const result = parseExpression();
  if (pos < tokens.length) throw new ExprError(`Symbole inattendu : ${tokens[pos].value}`);
  if (Number.isNaN(result)) throw new ExprError('Résultat indéfini');
  return result;
}

/** Arrondit les erreurs de virgule flottante (0.1 + 0.2 → 0.3). */
export function clean(value) {
  if (!Number.isFinite(value)) return value;
  return Number.parseFloat(value.toPrecision(12));
}

/** Format d'affichage localisé (virgule décimale en français). */
export function formatNumber(value, { locale = 'fr-FR', maxDigits = 10 } = {}) {
  if (value === Infinity || value === -Infinity) return value > 0 ? '∞' : '−∞';
  if (Number.isNaN(value)) return 'Erreur';
  const v = clean(value);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) {
    return v.toExponential(6).replace('.', ',').replace(/\.?0+e/, 'e');
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: maxDigits }).format(v);
}

/** Vrai si la chaîne ressemble à un calcul (pour la recherche rapide). */
export function looksLikeMath(text) {
  const s = String(text).trim();
  if (!/[0-9π]/.test(s) || !/[-+*/×÷^%!√()]|\b(sqrt|sin|cos|tan|ln|log)\b/.test(s)) return false;
  try {
    evaluate(s);
    return true;
  } catch {
    return false;
  }
}
