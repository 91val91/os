/**
 * Mini-bibliothèque DOM : `h()` crée des éléments de manière déclarative.
 *
 *   h('button.btn.primary', { onclick: save, disabled: false }, 'Enregistrer')
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(selector, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    if (props != null) children.unshift(props);
    props = {};
  }
  const [, tag = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(selector);
  const el = document.createElement(tag || 'div');
  for (const token of rest.match(/[.#][^.#]+/g) ?? []) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else el.id = token.slice(1);
  }
  applyProps(el, props);
  append(el, children);
  return el;
}

export function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      for (const c of String(value).split(/\s+/).filter(Boolean)) el.classList.add(c);
    } else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText += value;
      else for (const [prop, v] of Object.entries(value)) {
        if (v == null) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key === 'ref' && typeof value === 'function') {
      value(el);
    } else if (key in el && !key.includes('-') && key !== 'list' && key !== 'form') {
      el[key] = value === true ? true : value;
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) el.setAttribute(key, value);
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Remplace le contenu d'un élément. */
export function render(el, ...children) {
  clear(el);
  return append(el, children);
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Attend la fin d'une animation Web Animations (ou une durée). */
export function animate(el, keyframes, options) {
  if (!el?.animate || options.duration === 0) {
    const last = keyframes.at?.(-1);
    if (last && options.fill !== 'none') Object.assign(el.style, last);
    return Promise.resolve();
  }
  const animation = el.animate(keyframes, options);
  return animation.finished.then(
    () => animation,
    () => animation,
  );
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Charge une feuille de style une seule fois. */
const loadedStyles = new Map();
export function loadStyle(href) {
  const url = new URL(href, document.baseURI).href;
  if (loadedStyles.has(url)) return loadedStyles.get(url);
  const promise = new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: url });
    link.addEventListener('load', () => resolve(link));
    link.addEventListener('error', () => resolve(link));
    document.head.append(link);
  });
  loadedStyles.set(url, promise);
  return promise;
}
