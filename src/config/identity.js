/**
 * « Continuer avec Google » et « Continuer avec Microsoft » (OpenID Connect).
 *
 * Orion n'a pas de serveur de comptes : c'est le fournisseur qui authentifie
 * la personne et renvoie un jeton d'identité signé, vérifié par Orion. Il faut
 * pour cela un identifiant client, enregistré par celui qui publie Orion :
 *
 *   Google     console.cloud.google.com → API et services → Identifiants →
 *              « ID client OAuth » de type « Application Web ».
 *   Microsoft  entra.microsoft.com → Inscriptions d'applications → Nouvelle
 *              inscription (« Comptes Microsoft personnels et professionnels »),
 *              plateforme « Web », cocher « Jetons d'ID ».
 *
 * URI de redirection autorisée, dans les deux cas : l'adresse d'Orion suivie
 * de src/auth.html (par exemple https://exemple.github.io/os/src/auth.html).
 *
 * Laissé vide, le bouton n'est pas proposé : l'adresse est vérifiée par son
 * serveur de messagerie (Orion installé), ou enregistrée « non vérifiée ».
 * Un identifiant client n'est pas un secret : il peut être publié.
 */
export const OIDC_CLIENTS = Object.freeze({
  google: '',
  microsoft: '',
});
