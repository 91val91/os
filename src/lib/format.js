/**
 * Formatage localisé (français) : heures, dates, durées, tailles.
 */
export const LOCALE = 'fr-FR';

export const pad2 = (n) => String(n).padStart(2, '0');

export function formatTime(date, use24h = true) {
  const d = new Date(date);
  if (use24h) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad2(d.getMinutes())}`;
}

export function formatDate(date, options = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const text = new Date(date).toLocaleDateString(LOCALE, options);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function isSameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** « À l'instant », « 14:32 », « Hier », « lundi », « 12/03/2026 ». */
export function relativeTime(timestamp, now = Date.now()) {
  const diff = now - timestamp;
  if (diff < 60_000) return "À l'instant";
  if (diff < 3_600_000 && diff > 0) return `Il y a ${Math.floor(diff / 60_000)} min`;
  if (isSameDay(timestamp, now)) return formatTime(timestamp);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(timestamp, yesterday)) return 'Hier';
  if (diff < 6 * 86_400_000) return new Date(timestamp).toLocaleDateString(LOCALE, { weekday: 'long' });
  return new Date(timestamp).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Durée en mm:ss ou h:mm:ss. */
export function formatDuration(ms, { tenths = false } = {}) {
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const base = h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
  return tenths ? `${base},${pad2(Math.floor((total % 1000) / 10))}` : base;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[i]}`;
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '#';
  if (/^\+?\d/.test(parts[0])) return '#';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

const PALETTE = ['#ff6b6b', '#f59f00', '#37b24d', '#1c7ed6', '#7048e8', '#e64980', '#0ca678', '#f76707', '#4263eb'];

export function colorFor(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
