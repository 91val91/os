/**
 * Point d'entrée : allume le téléphone virtuel et enregistre le service
 * worker (fonctionnement hors ligne, installation en plein écran).
 */
import { SystemUI } from './system/system-ui.js';

const ui = new SystemUI(document.getElementById('stage'));
ui.powerOn().catch((error) => {
  console.error(error);
  document.getElementById('stage').innerHTML = `<pre class="panic">Kernel panic — ${String(error?.stack ?? error).replace(/</g, '&lt;')}</pre>`;
});

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        // Les fichiers chargés avant l'activation du service worker sont mis en cache tout de suite.
        const urls = [location.href, ...performance.getEntriesByType('resource').map((entry) => entry.name)];
        registration.active?.postMessage({ type: 'cache', urls });
      })
      .catch((error) => console.warn('Service worker indisponible', error));
  });
}
