#!/usr/bin/env node
/**
 * Régénère les captures du README (docs/screenshots/*.jpg) : quatre écrans
 * du téléphone côte à côte par image (nécessite Playwright : npm install).
 * Usage : npm run screenshots
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 8900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const browser = await chromium.launch();

try {
  await new Promise((r) => setTimeout(r, 600));
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const wait = (ms) => page.waitForTimeout(ms);
  const run = (fn, arg) => page.evaluate(fn, arg);
  const shot = async () => `data:image/png;base64,${(await page.locator('.screen-wrap').screenshot({ animations: 'disabled' })).toString('base64')}`;

  await page.goto(`http://127.0.0.1:${port}/?nosw`);
  await page.waitForSelector('.setup-next', { timeout: 15_000 });
  await wait(300);
  await page.click('.setup-next');
  await wait(400);
  await page.click('.setup-provider[data-provider="google"]');
  await wait(400);
  await page.fill('.setup-input[type="email"]', 'camille.durand@gmail.com');
  await page.click('.setup-next');
  await wait(400);
  await page.fill('.setup-input[type="text"]', 'Camille Durand');
  await page.click('.setup-next');
  for (let i = 0; i < 2; i++) {
    await wait(400);
    await page.click('.setup-next');
  }
  await wait(400);
  await page.click('text=Ne pas définir de code');
  await wait(500);
  await page.click('.setup-next');
  await page.waitForFunction(() => window.orion.ui.state === 'home');
  await run(async () => {
    const k = window.orion.kernel;
    for (const pkg of k.packages.list({ installed: null })) await k.packages.install(pkg.id);
    const lea = k.accounts.create({ name: 'Léa Martin' });
    k.accounts.update(lea.id, { identity: { provider: 'apple', email: 'lea.martin@icloud.com' } });
  });
  await wait(2500);

  const images = {};

  // Écran verrouillé, accueil, centre de contrôle, compte.
  await run(() => window.orion.ui.lockNow());
  await wait(900);
  const lock = await shot();
  await run(() => window.orion.ui.lock.unlock());
  await wait(900);
  const home = await shot();
  await run(() => window.orion.ui.controlCenter.open());
  await wait(800);
  const control = await shot();
  await run(() => window.orion.ui.controlCenter.close());
  await run(() => window.orion.ui.openIntent({ app: 'settings', action: 'view', data: { page: 'account' } }));
  await wait(1200);
  images.apercu = [lock, home, control, await shot()];
  await run(() => window.orion.ui.goHome());
  await wait(600);

  // Volet, récentes, appel entrant, mode édition.
  await run(() => window.orion.ui.shade.open());
  await wait(800);
  const shade = await shot();
  await run(() => window.orion.ui.shade.close());
  for (const id of ['notes', 'settings']) {
    await run((app) => window.orion.ui.launch(app), id);
    await wait(900);
  }
  await run(() => window.orion.ui.showRecents());
  await wait(1000);
  const recents = await shot();
  await run(() => window.orion.ui.goHome());
  await wait(700);
  await run(() => {
    const contact = window.orion.kernel.contacts.add({ firstName: 'Léa', lastName: 'Martin', phone: '+33 6 12 34 56 78' });
    window.orion.kernel.telephony.incoming(contact.phone);
  });
  await wait(900);
  const call = await shot();
  await run(() => window.orion.kernel.telephony.hangup());
  await wait(900);
  await run(() => window.orion.ui.home.enterEditMode());
  await wait(800);
  images.systeme = [shade, recents, call, await shot()];
  await run(() => window.orion.ui.home.exitEditMode());
  await wait(500);

  // Terminal (mode développeur), Musique, Météo, Store.
  await run(async () => {
    await window.orion.ui.developer.create('orion2026');
    await window.orion.ui.launch('terminal');
  });
  await wait(900);
  for (const command of ['neofetch', 'users']) {
    await page.fill('.term-input', command);
    await page.press('.term-input', 'Enter');
    await wait(500);
  }
  const terminal = await shot();
  await run(() => window.orion.ui.launch('music'));
  await wait(900);
  await page.click('.music-hero-play');
  await wait(1500);
  const music = await shot();
  await run(() => window.orion.ui.launch('weather'));
  await wait(2500);
  const weather = await shot();
  await run(() => window.orion.ui.launch('store'));
  await wait(900);
  await page.click('.store-feature-app >> nth=0').catch(() => {});
  await wait(900);
  images.applications = [terminal, music, weather, await shot()];

  // Assemblage : 4 écrans sur fond blanc, 1242 × 642.
  for (const [name, list] of Object.entries(images)) {
    await page.setViewportSize({ width: 1242, height: 642 });
    await page.setContent(`<body style="margin:0;background:#fff;display:flex;gap:18px;justify-content:center;align-items:flex-start;height:642px;overflow:hidden">${list.map((src) => `<img src="${src}" style="height:640px;margin-top:1px">`).join('')}</body>`);
    await page.locator('body').screenshot({ path: `${root}docs/screenshots/${name}.jpg`, type: 'jpeg', quality: 82, scale: 'css' });
    console.log(`docs/screenshots/${name}.jpg`);
  }
} finally {
  await browser.close();
  server.kill();
}
