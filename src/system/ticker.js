/**
 * Battement d'une seconde partagé par l'interface (horloges, durée d'appel,
 * réveils, verrouillage automatique) : un seul réveil par seconde, calé sur
 * le changement de seconde (les horloges passent à la minute pile), au lieu
 * d'une minuterie par composant. Il s'arrête quand plus personne n'écoute.
 */
const listeners = new Set();
let timer = null;

const delay = () => 1000 - (Date.now() % 1000) + 2;

function beat() {
  timer = setTimeout(beat, delay());
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (error) {
      console.error(error);
    }
  }
}

/** Appelle `fn` à chaque seconde ; renvoie la fonction qui arrête. */
export function everySecond(fn) {
  listeners.add(fn);
  timer ??= setTimeout(beat, delay());
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
