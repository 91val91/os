/**
 * Calculatrice : saisie d'expressions avec aperçu du résultat (Android),
 * touches rondes (iOS), mode scientifique et historique.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { evaluate, clean, formatNumber } from '../../lib/expr.js';
import { iconButton, sheet, emptyState } from '../../lib/ui.js';
import { longPress } from '../../lib/gesture.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const OPERATORS = ['+', '−', '×', '÷', '^'];
const FUNCTIONS = ['sin(', 'cos(', 'tan(', 'ln(', 'log(', '√('];

/** Convertit un nombre en saisie : 1234.5 → "1234,5", -3 → "−3". */
function toInput(value) {
  return String(clean(value)).replace('.', ',').replace('-', '−').replace('e+', 'e');
}

export function mount(root, ctx) {
  let expr = '';
  let evaluated = false;
  let error = false;
  let scientific = ctx.storage.get('scientific', false);
  let degrees = ctx.storage.get('degrees', true);
  const history = ctx.storage.get('history', []);

  const exprEl = h('div.calc-expr');
  const resultEl = h('div.calc-result');
  const angleBtn = h('button.calc-angle', { type: 'button', onclick: () => { degrees = !degrees; ctx.storage.set('degrees', degrees); render(); } });
  const display = h('div.calc-display', h('div.calc-top', angleBtn, iconButton('history', () => showHistory(), { label: 'Historique' })), exprEl, resultEl);

  const lastChar = () => expr.slice(-1);
  const endsWithOperator = () => OPERATORS.includes(lastChar());
  const openParens = () => (expr.match(/\(/g) ?? []).length - (expr.match(/\)/g) ?? []).length;

  function compute(text) {
    return evaluate(text, { degrees });
  }

  function press(key) {
    ctx.device.vibrate(4);
    if (error) {
      expr = '';
      error = false;
    }
    if (/^[0-9]$/.test(key)) {
      if (evaluated) expr = '';
      if (lastChar() === ')' || lastChar() === '%' || lastChar() === 'π') expr += '×';
      expr += key;
    } else if (key === ',') {
      if (evaluated) expr = '0';
      const current = expr.split(/[+−×÷^(]/).pop();
      if (!current.includes(',')) expr += /[0-9]$/.test(expr) ? ',' : '0,';
    } else if (OPERATORS.includes(key)) {
      if (!expr && key === '−') expr = '−';
      else if (!expr) return;
      else if (endsWithOperator()) expr = expr.slice(0, -1) + key;
      else expr += key;
    } else if (key === '%') {
      if (expr && /[0-9)]$/.test(expr)) expr += '%';
    } else if (key === '()') {
      if (evaluated) evaluated = false;
      if (openParens() > 0 && /[0-9)%π]$/.test(expr)) expr += ')';
      else expr += /[0-9)%π]$/.test(expr) ? '×(' : '(';
    } else if (FUNCTIONS.includes(key) || key === 'π' || key === 'e') {
      if (evaluated) expr = '';
      if (/[0-9)%π]$/.test(expr)) expr += '×';
      expr += key;
    } else if (key === '!' || key === '²') {
      if (/[0-9)]$/.test(expr)) expr += key === '²' ? '^2' : '!';
    } else if (key === 'back') {
      if (evaluated) expr = '';
      else {
        const fn = FUNCTIONS.find((f) => expr.endsWith(f));
        expr = expr.slice(0, -(fn?.length ?? 1));
      }
    } else if (key === 'clear') {
      expr = '';
    } else if (key === '=') {
      return equals();
    }
    evaluated = false;
    render();
  }

  function equals() {
    if (!expr || evaluated) return;
    let text = expr;
    while (OPERATORS.includes(text.slice(-1))) text = text.slice(0, -1);
    try {
      const value = compute(text + ')'.repeat(Math.max(0, openParens())));
      history.unshift({ expr: text, result: value, time: Date.now() });
      history.length = Math.min(history.length, 50);
      ctx.storage.set('history', history);
      exprEl.classList.add('flash');
      setTimeout(() => exprEl.classList.remove('flash'), 300);
      resultEl.dataset.previous = text;
      expr = toInput(value);
      evaluated = true;
    } catch (err) {
      error = true;
      resultEl.textContent = err.message;
    }
    render();
  }

  function render() {
    exprEl.textContent = expr || '0';
    const length = (expr || '0').length;
    exprEl.style.fontSize = length > 16 ? '2.1rem' : length > 11 ? '2.8rem' : length > 8 ? '3.6rem' : '4.6rem';
    root.querySelector('.key-clear').textContent = expr && !evaluated ? '⌫' : 'AC';
    angleBtn.textContent = degrees ? 'DEG' : 'RAD';
    angleBtn.hidden = !scientific;
    if (error) {
      resultEl.classList.add('error');
      return;
    }
    resultEl.classList.remove('error');
    if (evaluated) {
      resultEl.textContent = `${resultEl.dataset.previous} =`;
      return;
    }
    let preview = '';
    if (/[+−×÷^%!(]|sin|cos|tan|ln|log|√/.test(expr)) {
      try {
        let text = expr;
        while (OPERATORS.includes(text.slice(-1))) text = text.slice(0, -1);
        preview = `= ${formatNumber(compute(text + ')'.repeat(Math.max(0, openParens()))))}`;
      } catch {
        preview = '';
      }
    }
    resultEl.textContent = preview;
  }

  function showHistory() {
    const list = history.length
      ? h(
          'div.list',
          history.map((item) =>
            h(
              'div.list-item.tappable',
              { onclick: () => { expr = toInput(item.result); evaluated = true; resultEl.dataset.previous = item.expr; panel.close(); render(); } },
              h('div.li-body', h('div.li-sub', item.expr), h('div.li-title', formatNumber(item.result))),
            ),
          ),
        )
      : emptyState({ icon: 'history', title: 'Aucun historique', message: 'Vos calculs apparaîtront ici.' });
    const panel = sheet(root, {
      title: 'Historique',
      content: [list, history.length ? h('button.btn.btn-plain.block.destructive', { type: 'button', onclick: () => { history.length = 0; ctx.storage.set('history', history); panel.close(); } }, "Effacer l'historique") : null],
      cancelLabel: 'Fermer',
    });
  }

  const key = (label, value, cls = '') => {
    const btn = h(`button.calc-key${cls}`, { type: 'button', onclick: () => press(value) }, label);
    return btn;
  };

  const sciPanel = h(
    'div.calc-sci',
    key('sin', 'sin(', '.fn'),
    key('cos', 'cos(', '.fn'),
    key('tan', 'tan(', '.fn'),
    key('√', '√(', '.fn'),
    key('ln', 'ln(', '.fn'),
    key('log', 'log(', '.fn'),
    key('π', 'π', '.fn'),
    key('e', 'e', '.fn'),
    key('x²', '²', '.fn'),
    key('xʸ', '^', '.fn'),
    key('x!', '!', '.fn'),
    key('( )', '()', '.fn'),
  );

  const clearKey = key('AC', 'back', '.fn.key-clear');
  clearKey.addEventListener('click', (e) => {
    if (clearKey.textContent === 'AC') {
      e.stopImmediatePropagation();
      press('clear');
    }
  }, true);
  longPress(clearKey, () => press('clear'));

  const sciToggle = h('button.calc-key.fn', { type: 'button', 'aria-label': 'Mode scientifique', onclick: () => { scientific = !scientific; ctx.storage.set('scientific', scientific); root.classList.toggle('scientific', scientific); render(); } }, icon('calculator', { size: 24 }));

  const pad = h(
    'div.calc-pad',
    clearKey,
    key('( )', '()', '.fn'),
    key('%', '%', '.fn'),
    key('÷', '÷', '.op'),
    key('7', '7'),
    key('8', '8'),
    key('9', '9'),
    key('×', '×', '.op'),
    key('4', '4'),
    key('5', '5'),
    key('6', '6'),
    key('−', '−', '.op'),
    key('1', '1'),
    key('2', '2'),
    key('3', '3'),
    key('+', '+', '.op'),
    sciToggle,
    key('0', '0'),
    key(',', ','),
    key('=', '=', '.op.equals'),
  );

  root.classList.add('calculator');
  root.classList.toggle('scientific', scientific);
  root.append(display, sciPanel, pad);

  const keyMap = { '*': '×', x: '×', '/': '÷', '-': '−', '+': '+', '.': ',', ',': ',', '%': '%', '^': '^', '(': '()', ')': '()', Enter: '=', '=': '=', Backspace: 'back', Delete: 'clear' };
  const onKey = (e) => {
    if (!ctx.foreground || e.altKey || e.ctrlKey || e.metaKey) return;
    const value = /^[0-9]$/.test(e.key) ? e.key : keyMap[e.key];
    if (value) {
      e.preventDefault();
      press(value);
    }
  };
  window.addEventListener('keydown', onKey);
  ctx.on('destroy', () => window.removeEventListener('keydown', onKey));
  render();
}
