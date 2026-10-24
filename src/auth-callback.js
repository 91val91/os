/**
 * Retour de la connexion Google ou Microsoft (src/auth.html) : le jeton d'identité
 * est renvoyé à Orion, qui le vérifie (voir kernel/identity.js et
 * system/sign-in.js). Il ne reste ni dans l'adresse ni dans l'historique.
 */
const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
const message = {
  type: 'orion-auth',
  state: params.get('state') ?? '',
  idToken: params.get('id_token') ?? '',
  error: params.get('error') ?? '',
  description: params.get('error_description') ?? '',
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
