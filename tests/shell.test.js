import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootKernel } from '../src/kernel/kernel.js';
import { Shell, tokenize, parse, stripAnsi } from '../src/kernel/shell.js';

const MANIFESTS = [
  { id: 'terminal', name: 'Terminal', system: true },
  { id: 'notes', name: 'Notes', system: true, intents: [{ action: 'view', types: ['text/*'] }] },
  { id: 'snake', name: 'Snake' },
];

async function shell() {
  const kernel = await bootKernel({ manifests: MANIFESTS, env: {}, timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  const sh = new Shell(kernel, { user: 'test' });
  const run = async (line) => {
    const result = await sh.run(line);
    return { ...result, text: stripAnsi(result.output).trimEnd() };
  };
  return { kernel, sh, run };
}

test('analyse : guillemets, échappements, opérateurs', () => {
  const words = (line) => tokenize(line).map((t) => (t.type === 'op' ? t.value : t.parts.map((p) => p.text).join('')));
  assert.deepEqual(words(`echo "a b" 'c d' e\\ f`), ['echo', 'a b', 'c d', 'e f']);
  assert.deepEqual(words('ls|wc -l>out && x || y; z'), ['ls', '|', 'wc', '-l', '>', 'out', '&&', 'x', '||', 'y', ';', 'z']);
  assert.throws(() => tokenize('echo "oups'), /non fermé/);
  const chain = parse(tokenize('a | b > f && c'));
  assert.equal(chain.length, 2);
  assert.equal(chain[0].pipeline.length, 2);
  assert.equal(chain[0].next, '&&');
  assert.throws(() => parse(tokenize('| a')), /syntaxe/);
});

test('commandes de fichiers, tubes et redirections', async () => {
  const { run, kernel } = await shell();
  assert.equal((await run('pwd')).text, '/home');
  await run('mkdir -p projet/src && cd projet');
  assert.equal((await run('pwd')).text, '/home/projet');
  await run('echo "ligne 1" > notes.txt');
  await run('echo "ligne 2" >> notes.txt');
  assert.equal((await run('cat notes.txt')).text, 'ligne 1\nligne 2');
  assert.equal((await run('cat notes.txt | grep 2')).text, 'ligne 2');
  assert.equal((await run('cat notes.txt | wc -l')).text, '2');
  assert.equal((await run('seq 5 | sort -r | head -n 2')).text, '5\n4');
  assert.equal(kernel.fs.readFile('/home/projet/notes.txt'), 'ligne 1\nligne 2\n');
  await run('cp notes.txt copie.txt && mv copie.txt src/');
  assert.equal((await run('ls src')).text, 'copie.txt');
  assert.equal((await run('ls *.txt')).text, 'notes.txt');
  await run('rm -r src');
  assert.equal(kernel.fs.exists('/home/projet/src'), false);
  assert.equal((await run('cd -')).text, '/home');
});

test('statuts de sortie, && et ||', async () => {
  const { run } = await shell();
  assert.equal((await run('false || echo secours')).text, 'secours');
  assert.equal((await run('false && echo jamais')).text, '');
  const missing = await run('commande-inexistante');
  assert.equal(missing.status, 127);
  assert.match(missing.text, /introuvable/);
  const denied = await run('rm /system/version');
  assert.equal(denied.status, 1);
  assert.match(denied.text, /Permission refusée/);
  assert.equal((await run('echo $?')).text, '1');
});

test('variables et environnement', async () => {
  const { run } = await shell();
  await run('export NOM=Orion');
  assert.equal((await run('echo "Bonjour $NOM"')).text, 'Bonjour Orion');
  assert.equal((await run("echo '$NOM'")).text, '$NOM');
  assert.equal((await run('echo ~')).text, '/home');
});

test('commandes système : ps, pm, open, kill, calc, settings', async () => {
  const { run, kernel } = await shell();
  assert.match((await run('pm list -a')).text, /snake/);
  assert.match((await run('pm install snake')).text, /installé/);
  assert.equal(kernel.packages.isInstalled('snake'), true);
  await run('open snake');
  assert.match((await run('ps')).text, /snake\s+foreground/);
  const pid = kernel.processes.getByApp('snake').pid;
  await run(`kill ${pid}`);
  assert.equal(kernel.processes.getByApp('snake'), null);
  await run('open /home/Documents/Bienvenue.txt');
  assert.equal(kernel.processes.foreground().appId, 'notes');
  assert.equal((await run('calc 2^10 + 1')).text, '1025');
  assert.equal((await run('settings set theme dark')).text, 'theme = "dark"');
  assert.equal(kernel.settings.get('theme'), 'dark');
  assert.match((await run('pm uninstall terminal')).text, /système/);
});

test('signaux clear / exit et complétion', async () => {
  const { sh, run } = await shell();
  assert.equal((await run('clear')).clear, true);
  assert.equal((await run('exit')).exit, true);
  assert.deepEqual(sh.complete('neof').candidates, ['neofetch ']);
  assert.deepEqual(sh.complete('cat Doc').candidates, ['Documents/']);
  assert.deepEqual(sh.complete('ls Documents/Bie').candidates, ['Documents/Bienvenue.txt ']);
});
