#!/usr/bin/env node
/**
 * Test de bout en bout dans un vrai navigateur (Chromium via Playwright) :
 * démarrage, assistant de configuration, lancement de chaque application,
 * gestes système, verrouillage par code, comptes. Usage : npm run test:e2e
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

  /** Assistant : compte, thème, navigation, code (ou aucun). */
  const runSetup = async (name, code) => {
    // Après un changement de compte, le système redémarre : marge pour une machine chargée.
    await page.waitForSelector('.setup-next', { timeout: 30_000 });
    await wait(300);
    await page.click('.setup-next');
    await wait(400);
    await page.fill('.setup-input[type="text"]', name);
    await page.click('.setup-next');
    for (let i = 0; i < 2; i++) {
      await wait(400);
      await page.click('.setup-next');
    }
    await wait(400);
    if (code) {
      for (const d of code + code) {
        await page.click(`.setup-keypad .pin-key:text-is("${d}")`);
        await wait(80);
      }
    } else {
      await page.click('text=Ne pas définir de code');
    }
    await wait(500);
    await page.click('.setup-next');
    await page.waitForFunction(() => window.orion.ui.state === 'home', null, { timeout: 5000 });
  };

  await page.goto(url);
  await page.waitForSelector('.setup-next', { timeout: 10_000 });
  check(true, 'Démarrage du noyau et assistant de configuration');
  await runSetup('Testeur', '2468');
  check(await page.evaluate(() => window.orion.kernel.account?.name === 'Testeur' && window.orion.kernel.account.owner), "Configuration terminée, compte du propriétaire créé, écran d'accueil affiché");

  const ids = await page.evaluate(async () => {
    const k = window.orion.kernel;
    for (const pkg of k.packages.list({ installed: null })) await k.packages.install(pkg.id);
    return k.packages.list().map((p) => p.id);
  });
  check(ids.length >= 20, `${ids.length} applications installées`);

  const developerApps = await page.evaluate(() => window.orion.kernel.packages.list().filter((p) => p.developer).map((p) => p.id));
  for (const id of ids) {
    const before = errors.length;
    await page.evaluate((app) => window.orion.ui.launch(app), id);
    await wait(900);
    if (developerApps.includes(id)) {
      const blocked = await page.evaluate((app) => window.orion.ui.wm.currentWindow?.appId !== app && !document.querySelector(`.layer-drawer [data-app="${app}"], .layer-home [data-app="${app}"]`), id);
      check(blocked, `« ${id} » caché et réservé au mode développeur`);
      continue;
    }
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

  // Comptes : un second utilisateur dispose d'un espace séparé.
  await page.evaluate(() => window.orion.kernel.accounts.create({ name: 'Invité' }));
  await Promise.all([page.waitForEvent('load'), page.evaluate(() => window.orion.ui.switchAccount(window.orion.kernel.accounts.list().find((a) => !a.owner).id))]);
  await runSetup('Invité', null);
  const guest = await page.evaluate(() => ({ account: window.orion.kernel.account, apps: window.orion.kernel.packages.list().length }));
  check(guest.account.name === 'Invité' && !guest.account.owner && guest.apps < ids.length, 'Second compte : session et données séparées');
  await Promise.all([page.waitForEvent('load'), page.evaluate(() => window.orion.ui.switchAccount(window.orion.kernel.accounts.owner.id))]);
  await page.waitForFunction(() => window.orion?.ui.state === 'locked', null, { timeout: 10_000 });
  await wait(1300);
  await drag(0.5, 0.45, 0.5, 0.1);
  for (const d of '2468') {
    await page.click(`.pin-key:has(.pin-digit:text-is("${d}"))`);
    await wait(80);
  }
  await page.waitForFunction(() => window.orion.ui.state === 'home', null, { timeout: 5000 });
  check(await page.evaluate((n) => window.orion.kernel.account.owner && window.orion.kernel.packages.list().length === n, ids.length), 'Retour au propriétaire avec son code, ses apps intactes');

  // Mode développeur : mot de passe de l'appareil choisi par le propriétaire, redemandé après chaque verrouillage.
  const openDeveloper = async () => {
    await page.evaluate(() => window.orion.ui.openIntent({ app: 'settings', action: 'view', data: { page: 'developer' } }));
    await wait(900);
  };
  await openDeveloper();
  const fields = await page.$$('.dev-input');
  await fields[0].fill('orion2026');
  await fields[1].fill('orion2026');
  await page.click('.dev-form .btn:has-text("Valider")');
  await wait(600);
  check(await page.evaluate(() => window.orion.ui.developer.configured && window.orion.ui.developerUnlocked), 'Mode développeur : mot de passe de l\'appareil créé, options déverrouillées');
  await page.click('.list-item:has-text("Shell osh")');
  await wait(1200);
  check(await page.evaluate(() => window.orion.ui.wm.currentWindow?.appId === 'terminal'), 'Terminal ouvert depuis le mode développeur');
  await page.keyboard.press('Alt+L');
  await wait(300);
  await page.keyboard.press('Alt+L');
  await wait(600);
  check(await page.evaluate(() => !window.orion.ui.developerUnlocked && !window.orion.kernel.processes.getByApp('terminal') && ['off', 'locked'].includes(window.orion.ui.state)), 'Verrouillage : Terminal fermé, mode développeur reverrouillé');
  await drag(0.5, 0.45, 0.5, 0.1);
  for (const d of '2468') {
    await page.click(`.pin-key:has(.pin-digit:text-is("${d}"))`);
    await wait(80);
  }
  await page.waitForFunction(() => ['home', 'app'].includes(window.orion.ui.state), null, { timeout: 5000 });
  // « Réinitialiser tous les réglages » n'efface pas le mot de passe de l'appareil.
  await page.evaluate(() => {
    const s = window.orion.kernel.settings;
    for (const key of Object.keys(s.all())) if (!['setupDone', 'userName', 'passcode', 'demoDataRemoved'].includes(key)) s.reset(key);
  });
  await openDeveloper();
  await page.fill('.dev-input', 'mauvais1');
  await page.press('.dev-input', 'Enter');
  await wait(500);
  check((await page.textContent('.dev-error')).includes('incorrect') && !(await page.evaluate(() => window.orion.ui.developerUnlocked)), 'Mot de passe toujours exigé (même après réinitialisation des réglages), mauvais mot de passe refusé');
  await page.fill('.dev-input', 'orion2026');
  await page.click('.dev-form .btn:has-text("Déverrouiller")');
  await wait(600);
  check(await page.evaluate(() => window.orion.ui.developerUnlocked) && (await page.isVisible('text=Shell osh')), 'Bon mot de passe : options pour les développeurs ouvertes');
  await page.evaluate(() => window.orion.ui.goHome());
  await wait(500);

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
