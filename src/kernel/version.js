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
  version: '0.1',
  channel: 'alpha',
  sequence: 4,
  build: 'OR0A.261023.001',
  codename: 'Rigel',
  date: '2026-10-23',
  notes: Object.freeze([
    'Orion OS passe en 0.1 (alpha) : la numérotation repart de zéro jusqu\'à la première version stable. Vos données, comptes et réglages sont conservés.',
    'Programme développeur du Store : publiez vos propres apps, gratuites ou payantes, et suivez vos ventes dans la console développeur (Store → Compte).',
    'Le Store affiche les apps des développeurs, avec achat, reçus et remboursement (paiements fictifs pendant l\'alpha : solde de test) ; les apps publiées s\'exécutent isolées du système, sans accès à Internet.',
    'Nouveau : Protection de l\'appareil — bilan de sécurité, vérification de l\'intégrité du système, analyse des apps, protection contre la réinitialisation, effacement après trop d\'échecs du code et verrouillage en cas de vol.',
    'Les erreurs de code de verrouillage sont comptées même après un redémarrage ; achats et réglages sensibles demandent le code.',
    'Image installable : orion-server garde la protection contre la réinitialisation et vérifie les fichiers servis ; le mode sans échec démarre aussi Orion.',
  ]),
});

/** Numéro affiché d'une version (celle-ci ou une publiée) : « 0.1 (alpha) ». */
export function versionLabel(release) {
  return release?.channel ? `${release.version} (${release.channel})` : String(release?.version ?? '');
}
