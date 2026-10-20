#!/usr/bin/env node
/**
 * Test de bout en bout dans un vrai navigateur (Chromium via Playwright) :
 * démarrage, assistant de configuration, lancement de chaque application,
 * gestes système, verrouillage par code. Usage : npm run test:e2e
 * (Playwright doit être installé : npm install && npx playwright install chromium).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 8000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}/?nosw`;
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? '✔' : '✘'} ${message}`);
  if (!ok) failures.push(message);
};

let browser;
try {
  await new Promise((r) => setTimeout(r, 500));
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // Les API réseau externes (météo) peuvent être inaccessibles : ce n'est pas une erreur du système.
    if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errors.push(m.text());
  });
  const wait = (ms) => page.waitForTimeout(ms);

  await page.goto(url);
  await page.waitForSelector('.setup-next', { timeout: 10_000 });
  check(true, 'Démarrage du noyau et assistant de configuration');
  await wait(300);
  await page.click('.setup-next');
  await wait(400);
  await page.fill('.setup-input', 'Testeur');
  await page.click('.setup-next');
  for (let i = 0; i < 2; i++) {
    await wait(400);
    await page.click('.setup-next');
  }
  await wait(400);
  for (const d of '24682468') {
    await page.click(`.setup-keypad .pin-key:text-is("${d}")`);
    await wait(80);
  }
  await wait(500);
  await page.click('.setup-next');
  await page.waitForFunction(() => window.orion.ui.state === 'home', null, { timeout: 5000 });
  check(true, "Configuration terminée, écran d'accueil affiché");

  const ids = await page.evaluate(async () => {
    const k = window.orion.kernel;
    for (const pkg of k.packages.list({ installed: null })) await k.packages.install(pkg.id);
    return k.packages.list().map((p) => p.id);
  });
  check(ids.length >= 20, `${ids.length} applications installées`);

  for (const id of ids) {
    const before = errors.length;
    await page.evaluate((app) => window.orion.ui.launch(app), id);
    await wait(900);
    const permission = await page.$('.dialog.permission');
    if (permission) {
      await page.click('.dialog.permission .dialog-btn.default');
      await wait(500);
    }
    const crashed = await page.$('text=s\'est arrêtée');
    const current = await page.evaluate(() => window.orion.ui.wm.currentWindow?.appId);
    check(!crashed && current === id && errors.length === before, `Application « ${id} »${errors.length > before ? ` : ${errors.slice(before).join(' | ')}` : ''}`);
    await page.evaluate(() => window.orion.ui.goHome());
    await wait(400);
  }

  const screen = await page.$eval('#screen', (el) => el.getBoundingClientRect().toJSON());
  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(screen.x + x1 * screen.width, screen.y + y1 * screen.height);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(screen.x + (x1 + ((x2 - x1) * i) / 10) * screen.width, screen.y + (y1 + ((y2 - y1) * i) / 10) * screen.height);
      await wait(16);
    }
    await page.mouse.up();
    await wait(600);
  };
  await drag(0.25, 0.02, 0.25, 0.6);
  check(await page.evaluate(() => window.orion.ui.shade.isOpen), 'Volet de notifications ouvert par glissement');
  await page.keyboard.press('Escape');
  await wait(400);
  await drag(0.85, 0.02, 0.85, 0.6);
  check(await page.evaluate(() => window.orion.ui.controlCenter.isOpen), 'Centre de contrôle ouvert par glissement');
  await page.keyboard.press('Escape');
  await wait(400);

  await page.evaluate(() => window.orion.ui.launch('notes'));
  await wait(800);
  await drag(0.5, 0.985, 0.5, 0.5);
  check(await page.evaluate(() => window.orion.ui.state === 'home'), "Geste « accueil » depuis la barre du bas");

  await page.keyboard.press('Alt+L');
  await wait(300);
  await page.keyboard.press('Alt+L');
  await wait(500);
  check(await page.evaluate(() => window.orion.ui.state === 'locked'), 'Verrouillage avec le bouton latéral');
  await drag(0.5, 0.45, 0.5, 0.1);
  for (const d of '2468') {
    await page.click(`.pin-key:has(.pin-digit:text-is("${d}"))`);
    await wait(80);
  }
  await wait(800);
  check(await page.evaluate(() => window.orion.ui.state === 'home'), 'Déverrouillage avec le code');

  const shell = await page.evaluate(async () => {
    const { Shell } = await import('./src/kernel/shell.js');
    const sh = new Shell(window.orion.kernel);
    return (await sh.run('echo ok | wc -c')).output.trim();
  });
  check(shell === '3', 'Shell osh exécuté dans le navigateur');
  check(errors.length === 0, `Aucune erreur JavaScript${errors.length ? ` : ${errors.join(' | ')}` : ''}`);
} catch (error) {
  failures.push(error.message);
  console.error(error);
} finally {
  await browser?.close();
  server.kill();
}

console.log(failures.length ? `\n${failures.length} échec(s)` : '\nTous les tests de bout en bout sont passés.');
process.exit(failures.length ? 1 : 0);
