#!/usr/bin/env node
/**
 * Génère les icônes PNG de la PWA à partir de assets/icon.svg
 * (nécessite Playwright : npm install).  Usage : npm run icons
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = await readFile(`${root}assets/icon.svg`, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();

const targets = [
  { file: 'icon-192.png', size: 192, padding: 0 },
  { file: 'icon-512.png', size: 512, padding: 0 },
  // Icône « maskable » : zone de sécurité de 80 % sur fond uni.
  { file: 'icon-maskable-512.png', size: 512, padding: 0.1 },
];

for (const { file, size, padding } of targets) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - padding * 2));
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${padding ? '#0b1020' : 'transparent'}">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await page.screenshot({ path: `${root}assets/${file}`, omitBackground: !padding });
  console.log(`assets/${file} (${size}×${size})`);
}
await browser.close();
