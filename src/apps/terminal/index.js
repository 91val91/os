/**
 * Terminal : émulateur de terminal pour le shell osh du noyau,
 * avec couleurs ANSI, historique, complétion et touches supplémentaires.
 */
import { h } from '../../lib/dom.js';
import { Shell } from '../../kernel/shell.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const COLORS = { 30: '#5c5c66', 31: '#ff6b68', 32: '#5af78e', 33: '#f3f99d', 34: '#57c7ff', 35: '#ff6ac1', 36: '#9aedfe', 37: '#f1f1f0', 90: '#8e8e93' };

/** Convertit du texte contenant des séquences ANSI SGR en nœuds DOM. */
export function ansiToNodes(text) {
  const nodes = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let style = {};
  let last = 0;
  const push = (chunk) => {
    if (!chunk) return;
    if (!style.color && !style.bold && !style.dim && !style.inverse) {
      nodes.push(document.createTextNode(chunk));
      return;
    }
    const span = document.createElement('span');
    span.textContent = chunk;
    if (style.color) span.style.color = style.color;
    if (style.bold) span.style.fontWeight = '700';
    if (style.dim) span.style.opacity = '.6';
    if (style.inverse) {
      span.style.background = style.color ?? '#f1f1f0';
      span.style.color = '#111';
    }
    nodes.push(span);
  };
  let match;
  while ((match = re.exec(text))) {
    push(text.slice(last, match.index));
    last = re.lastIndex;
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 7) style = { ...style, inverse: true };
      else if (COLORS[code]) style = { ...style, color: COLORS[code] };
    }
  }
  push(text.slice(last));
  return nodes;
}

export function mount(root, ctx) {
  const shell = new Shell(ctx.kernel, { user: (ctx.settings.get('userName') || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'user' });
  shell.history = ctx.storage.get('history', []);
  let historyIndex = shell.history.length;
  let busy = false;

  const output = h('div.term-output', { role: 'log', 'aria-live': 'polite' });
  const promptEl = h('span.term-prompt');
  const input = h('input.term-input', { type: 'text', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: false, enterkeyhint: 'send', 'aria-label': 'Commande' });
  const line = h('div.term-line', promptEl, input);
  const screen = h('div.term-screen', output, line);
  screen.addEventListener('click', () => {
    if (!getSelection()?.toString()) input.focus();
  });

  const print = (text) => {
    const block = h('div.term-block');
    block.append(...ansiToNodes(text.replace(/\n$/, '')));
    output.append(block);
    while (output.childElementCount > 500) output.firstElementChild.remove();
  };

  const renderPrompt = () => {
    promptEl.replaceChildren(...ansiToNodes(shell.prompt));
  };

  const scroll = () => requestAnimationFrame(() => (screen.scrollTop = screen.scrollHeight));

  async function submit() {
    if (busy) return;
    const command = input.value;
    const echo = h('div.term-block');
    echo.append(...ansiToNodes(shell.prompt), document.createTextNode(command));
    output.append(echo);
    input.value = '';
    busy = true;
    line.classList.add('busy');
    const result = await shell.run(command);
    busy = false;
    line.classList.remove('busy');
    ctx.storage.set('history', shell.history.slice(-100));
    historyIndex = shell.history.length;
    if (result.clear) output.replaceChildren();
    if (result.output) print(result.output);
    renderPrompt();
    scroll();
    if (result.exit) ctx.exit();
    else input.focus();
  }

  function complete() {
    const { start, candidates } = shell.complete(input.value);
    if (!candidates.length) return;
    if (candidates.length === 1) {
      input.value = input.value.slice(0, start) + candidates[0];
      return;
    }
    let prefix = candidates[0];
    for (const c of candidates) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.length > input.value.length - start) input.value = input.value.slice(0, start) + prefix;
    else {
      const echo = h('div.term-block');
      echo.append(...ansiToNodes(shell.prompt), document.createTextNode(input.value));
      output.append(echo);
      print(candidates.map((c) => c.trim()).join('  '));
      scroll();
    }
  }

  function historyStep(delta) {
    if (!shell.history.length) return;
    historyIndex = Math.max(0, Math.min(shell.history.length, historyIndex + delta));
    input.value = shell.history[historyIndex] ?? '';
    requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      historyStep(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      historyStep(1);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      output.replaceChildren();
    } else if (e.key === 'c' && e.ctrlKey && !input.selectionEnd) {
      print(`${input.value}^C`);
      input.value = '';
    }
  });

  const extra = (label, action) => h('button.term-key', { type: 'button', onpointerdown: (e) => e.preventDefault(), onclick: () => { action(); input.focus(); } }, label);
  const insert = (text) => () => {
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + text + input.value.slice(input.selectionEnd ?? pos);
    input.setSelectionRange(pos + text.length, pos + text.length);
  };
  const keys = h(
    'div.term-keys',
    extra('Tab', complete),
    extra('↑', () => historyStep(-1)),
    extra('↓', () => historyStep(1)),
    extra('|', insert(' | ')),
    extra('/', insert('/')),
    extra('-', insert('-')),
    extra('~', insert('~')),
    extra('>', insert(' > ')),
    extra('Effacer', () => output.replaceChildren()),
  );

  root.classList.add('terminal');
  root.append(screen, keys);
  print(`\x1b[1m${ctx.kernel.os.name} ${ctx.kernel.os.label}\x1b[0m — osh 1.0\nTapez \x1b[36mhelp\x1b[0m pour la liste des commandes, \x1b[36mneofetch\x1b[0m pour un résumé.\n`);
  renderPrompt();
  setTimeout(() => input.focus(), 400);
  return {
    onResume: () => input.focus(),
  };
}
