/**
 * Version d'Orion OS. Elle est affichée dans les Réglages et comparée à celle
 * de version.json (la version publiée) pour proposer les mises à jour.
 * Après l'avoir changée : npm run release (régénère version.json).
 */
export const RELEASE = Object.freeze({
  version: '1.1.0',
  build: 'OR1A.261022.001',
  codename: 'Andromède',
  date: '2026-10-22',
  notes: Object.freeze([
    'Mises à jour du système : vérification, téléchargement des seuls fichiers modifiés et installation au redémarrage, automatiques si vous le souhaitez.',
    'Comptes utilisateurs : chacun ses apps, fichiers, réglages et code, changement d\'utilisateur depuis l\'écran verrouillé.',
    'Nouvelles icônes des applications, dessinées pour Orion.',
    'Réglages de l\'appareil photo : format, qualité, retardateur, grille, miroir.',
    'Mode développeur protégé par un mot de passe d\'appareil ; le Terminal n\'est plus visible ailleurs.',
    'Les applications n\'ont plus accès aux fichiers système.',
    'Plus de contacts, d\'événements ni de conversations de démonstration.',
  ]),
});
