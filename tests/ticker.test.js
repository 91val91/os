import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { everySecond } from '../src/system/ticker.js';

test('battement partagé : une seule minuterie, calée sur la seconde, arrêtée sans abonné', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_400 });
  try {
    const calls = [];
    const stopA = everySecond(() => calls.push(['a', Date.now()]));
    const stopB = everySecond(() => calls.push(['b', Date.now()]));
    mock.timers.tick(598);
    assert.deepEqual(calls, [], 'pas avant la seconde suivante');
    mock.timers.tick(4);
    assert.deepEqual(calls, [['a', 11_002], ['b', 11_002]], 'calé sur le changement de seconde, les deux en un seul réveil');
    mock.timers.tick(1000);
    assert.equal(calls.length, 4);
    stopA();
    mock.timers.tick(1000);
    assert.deepEqual(calls.at(-1), ['b', 13_002]);
    assert.equal(calls.length, 5);
    stopB();
    mock.timers.tick(5000);
    assert.equal(calls.length, 5, 'plus rien une fois tous désabonnés');
    // Une erreur dans un abonné n'arrête pas les autres.
    const errors = mock.method(console, 'error', () => {});
    const seen = [];
    const stopC = everySecond(() => { throw new Error('boum'); });
    const stopD = everySecond(() => seen.push(Date.now()));
    mock.timers.tick(1000);
    assert.equal(seen.length, 1);
    assert.equal(errors.mock.callCount(), 1);
    stopC();
    stopD();
  } finally {
    mock.timers.reset();
    mock.restoreAll();
  }
});
