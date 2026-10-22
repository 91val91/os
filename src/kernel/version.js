/**
 * Version d'Orion OS. Elle est affichée dans les Réglages et comparée à celle
 * de version.json (la version publiée) pour proposer les mises à jour.
 * Après l'avoir changée : npm run release (régénère version.json).
 */
export const RELEASE = Object.freeze({
  version: '1.2.0',
  build: 'OR1B.261022.001',
  codename: 'Bételgeuse',
  date: '2026-10-22',
  notes: Object.freeze([
    'Wi‑Fi, Bluetooth et réseau mobile refaits : Orion affiche l\'état réel de la connexion. Installé sur un PC, une tablette ou une machine virtuelle, il pilote le vrai Wi‑Fi, le Bluetooth et un modem 4G (appels, SMS, données).',
    'Sur un téléphone, appels et SMS sont de vrais appels et de vrais SMS : Orion les confie aux apps Téléphone et Messages du système.',
    'Bluetooth sur Android (Chrome) : connexion aux montres, capteurs et autres appareils basse consommation, avec leur niveau de batterie.',
    'Nouveau : service de localisation (GPS) et app Plans — carte, position en direct, recherche de lieux, itinéraires et trajets enregistrés (GPX).',
    'Barre d\'état et réglages rapides fidèles à la réalité : force du Wi‑Fi, signal, localisation en cours.',
    'Mises à jour plus sûres : une version retirée n\'est plus installée, un téléchargement interrompu ne bloque plus, la copie hors ligne est protégée.',
    'Les applications n\'ont plus accès aux données internes du système.',
  ]),
});
