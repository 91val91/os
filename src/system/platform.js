/**
 * Détection de la plateforme hôte (téléphone réel, mode installé).
 * Sert à adapter l'OS aux gestes et barres du système sous-jacent.
 */
const nav = globalThis.navigator ?? {};
const ua = nav.userAgent ?? '';

export const platform = {
  /** iPhone / iPad (y compris iPadOS qui se présente comme un Mac tactile). */
  ios: /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1),
  android: /Android/.test(ua),

  /** Lancé depuis l'icône de l'écran d'accueil (PWA installée). */
  get installed() {
    return nav.standalone === true || Boolean(globalThis.matchMedia?.('(display-mode: fullscreen), (display-mode: standalone)').matches);
  },

  /** Contexte sécurisé : requis pour la caméra, le micro, la position, le hors-ligne. */
  get secure() {
    return globalThis.isSecureContext !== false;
  },

  /** Classes CSS posées sur <html> pour les ajustements propres à chaque plateforme. */
  applyClasses(root = globalThis.document?.documentElement) {
    if (!root) return;
    root.classList.toggle('ios', this.ios);
    root.classList.toggle('android', this.android);
    root.classList.toggle('installed', this.installed);
    root.classList.toggle('ios-standalone', this.ios && this.installed);
  },
};
