/**
 * Retour d'une connexion (src/auth.html) : Google ou Microsoft pour le compte
 * en ligne (jeton d'identité vérifié par kernel/identity.js), ou le service
 * d'une app (orion.net.authorize). Les paramètres sont renvoyés à Orion
 * (voir system/sign-in.js) et ne restent ni dans l'adresse ni dans l'historique.
 */
const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
const message = {
  type: 'orion-auth',
  state: params.get('state') ?? '',
  idToken: params.get('id_token') ?? '',
  error: params.get('error') ?? '',
  description: params.get('error_description') ?? '',
  // Tous les paramètres du retour, pour les apps qui se connectent à leur service (orion.net.authorize).
  params: Object.fromEntries([...params].slice(0, 30).map(([k, v]) => [k.slice(0, 64), v.slice(0, 4096)])),
};
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status');

if (message.state.startsWith('r')) {
  // Connexion dans la page même (fenêtre impossible) : Orion reprend au redémarrage.
  try {
    sessionStorage.setItem('orion-auth-result', JSON.stringify(message));
  } catch {
    /* stockage indisponible : la connexion sera à recommencer */
  }
  location.replace(new URL('../', location.href).href);
} else {
  try {
    new BroadcastChannel('orion-auth').postMessage(message);
  } catch {
    /* pas de BroadcastChannel */
  }
  try {
    window.opener?.postMessage(message, location.origin);
  } catch {
    /* fenêtre d'Orion fermée */
  }
  status.textContent = message.error ? 'Connexion annulée. Vous pouvez fermer cette fenêtre.' : 'Connexion réussie. Vous pouvez revenir à Orion.';
  setTimeout(() => window.close(), 400);
}
