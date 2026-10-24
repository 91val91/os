/**
 * Version d'Orion OS. Elle est affichée dans les Réglages et comparée à celle
 * de version.json (la version publiée) pour proposer les mises à jour.
 * Après l'avoir changée : npm run release (régénère version.json).
 *
 * `sequence` est le numéro d'ordre de la publication : il augmente de 1 à
 * chaque version publiée et c'est lui qui dit laquelle est la plus récente,
 * même quand le numéro affiché repart de zéro (1.2.0 → 0.1 alpha) ou est
 * repris (0.1.1 n° 5 → 0.1 n° 6).
 */
export const RELEASE = Object.freeze({
  version: '0.1',
  channel: 'alpha',
  sequence: 6,
  build: 'OR0A.261024.001',
  codename: 'Rigel',
  date: '2026-10-24',
  notes: Object.freeze([
    'Compte en ligne obligatoire : votre profil est associé à un compte Google (Gmail), Microsoft (Outlook, Hotmail, Live), iCloud, Yahoo ou à une autre adresse e-mail. L\'assistant le demande ; un profil qui n\'en a pas encore le reçoit juste après le déverrouillage.',
    'L\'adresse est vérifiée par le fournisseur : « Continuer avec Google / Microsoft » quand cette copie d\'Orion l\'a activé, ou connexion à votre messagerie sur Orion installé. Sinon, elle est enregistrée « non vérifiée » (Réglages → Compte).',
    'Plus rapide : démarrage deux fois plus court, un seul réveil par seconde pour tout le système au lieu de cinq, Horloge et Courrier au repos quand ils sont en arrière-plan.',
    'Messagerie sur Orion installé : vos comptes e-mail dans Réglages → Comptes de messagerie, et l\'autorisation « E-mails » pour les apps qui les utilisent.',
    'Pour les développeurs : Courrier, une app d\'e-mail complète prête à publier (Store → console développeur → nouvelle app → Modèles).',
    'Corrections : les horloges (barre d\'état, écran verrouillé) changent à la minute pile, le chronomètre et le minuteur ne consomment plus rien en arrière-plan, et la fenêtre de connexion fermée trop tôt ne bloque plus le bouton.',
  ]),
});

/** Numéro affiché d'une version (celle-ci ou une publiée) : « 0.1 (alpha) ». */
export function versionLabel(release) {
  return release?.channel ? `${release.version} (${release.channel})` : String(release?.version ?? '');
}
