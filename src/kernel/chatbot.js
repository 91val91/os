/**
 * Correspondants simulés : génère une réponse plausible à un SMS.
 * Déterministe si on fournit `random`.
 */

/** Mots entiers, accents compris (\b ne gère pas les lettres accentuées). */
const words = (alternatives) => new RegExp(`(?:^|[^\\p{L}])(?:${alternatives})(?![\\p{L}])`, 'iu');

const RULES = [
  { test: words('salut|bonjour|coucou|hello|hey|yo'), replies: ['Salut ! 😊', 'Coucou ! Ça va ?', 'Hello ! Quoi de neuf ?'] },
  { test: words('ça va|ca va|comment vas|tu vas bien'), replies: ['Très bien et toi ?', 'Ça va super, merci ! Et toi ?', 'Bof, un peu fatigué(e)… et toi ?'] },
  { test: words('merci|thanks'), replies: ['Avec plaisir !', 'De rien 😉', 'Pas de souci !'] },
  { test: words('ce soir|demain|week-end|weekend|samedi|dimanche'), replies: ['Ça marche, je suis dispo !', 'Je regarde mon agenda et je te redis.', 'Carrément, on se cale ça 👍'] },
  { test: words('manger|resto|dîner|diner|déjeuner|dejeuner|café|cafe'), replies: ['Bonne idée ! Tu proposes où ?', 'Je connais un super endroit 🍝', 'Oui ! J\'ai trop faim 😄'] },
  { test: words('photo|image'), replies: ['Trop belle la photo !', 'Envoie-la moi !', 'Waouh 😍'] },
  { test: words('oui|ok|d\'accord|dac|ouais'), replies: ['Parfait !', 'Top 👌', 'Super, à plus tard alors.'] },
  { test: words('non|pas possible|désolé|desole'), replies: ['Pas grave, une autre fois !', 'Ok, je comprends.', 'Dommage 😕'] },
  { test: words('bisou|bises|je t\'aime|tkt'), replies: ['Bisous ❤️', 'Gros bisous !', '😘'] },
  { test: /\?\s*$/, replies: ['Bonne question… je te dis ça vite.', 'Hmm, je ne sais pas trop 🤔', 'Oui, je pense !'] },
];

const FALLBACK = ['D\'accord !', 'Je vois 🙂', 'Ah oui ?', 'Haha 😂', 'Ok, ça marche.', 'Intéressant, raconte !'];

export function replyTo(text, random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  const rule = RULES.find((r) => r.test.test(String(text ?? '')));
  if (!rule && !String(text ?? '').trim()) return pick(['📷', 'Jolie !', 'Merci pour la photo !']);
  return pick(rule ? rule.replies : FALLBACK);
}
