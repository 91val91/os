/**
 * Version d'Orion OS. Elle est affichée dans les Réglages et comparée à celle
 * de version.json (la version publiée) pour proposer les mises à jour.
 * Après l'avoir changée : npm run release (régénère version.json).
 *
 * `sequence` est le numéro d'ordre de la publication : il augmente de 1 à
 * chaque version publiée et c'est lui qui dit laquelle est la plus récente,
 * même quand le numéro affiché repart de zéro (1.2.0 → 0.1 alpha).
 */
export const RELEASE = Object.freeze({
  version: '0.1.1',
  channel: 'alpha',
  sequence: 5,
  build: 'OR0A.261023.002',
  codename: 'Rigel',
  date: '2026-10-23',
  notes: Object.freeze([
    'Messagerie : sur Orion installé (ordinateur ou machine virtuelle), ajoutez vos comptes e-mail dans Réglages → Comptes de messagerie. Les serveurs sont trouvés d\'après l\'adresse, la connexion est chiffrée et orion-server relève et envoie le courrier.',
    'Nouvelle autorisation « E-mails » : une app ne lit et n\'envoie vos e-mails que si vous l\'acceptez, et ne voit jamais votre mot de passe (Réglages → Applications pour la retirer).',
    'Pour les développeurs : Courrier, une app d\'e-mail complète prête à publier (Store → Compte → console développeur → nouvelle app → Modèles). Elle utilise vos comptes, ou fonctionne sans compte.',
    'Image installable : Orion s\'affiche en plein écran et démarre plus vite sur les cartes graphiques sans accélération 3D.',
  ]),
});

/** Numéro affiché d'une version (celle-ci ou une publiée) : « 0.1 (alpha) ». */
export function versionLabel(release) {
  return release?.channel ? `${release.version} (${release.channel})` : String(release?.version ?? '');
}
