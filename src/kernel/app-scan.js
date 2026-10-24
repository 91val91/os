/**
 * Analyse du code des apps publiées sur le Store (examen avant publication,
 * vérification avant installation et analyse de la Protection de l'appareil).
 *
 * C'est une analyse heuristique du code source (motifs connus), pas une
 * preuve d'innocuité : la vraie barrière reste l'exécution isolée des apps
 * publiées (iframe sans origine, sans réseau, voir system/app-runtime.js).
 */
const RULES = [
  // Danger : l'app essaie de sortir de son bac à sable ou cache un mineur de cryptomonnaie.
  { level: 'danger', id: 'escape', pattern: /\b(?:top|parent|opener)\s*\.\s*(?:location|document|frames)\b|document\s*\.\s*domain\s*=/, message: 'Tente de sortir de son environnement isolé (accès à la page d\'Orion)' },
  { level: 'danger', id: 'miner', pattern: /coinhive|cryptonight|coinimp|webminepool|crypto-?loot|monero[\s\S]{0,40}min(?:er|ing)/i, message: 'Contient un mineur de cryptomonnaie' },
  { level: 'danger', id: 'impersonation', pattern: /(?:code de verrouillage|mot de passe (?:d'|de l'|du )?(?:orion|compte|appareil|développeur)|identifiants? (?:d')?orion|compte orion)[\s\S]{0,160}<input/i, message: 'Imite une demande d\'identifiants d\'Orion (hameçonnage)' },
  // Avertissement : comportements suspects ou interdits (bloqués à l'exécution).
  { level: 'warning', id: 'network', pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\//i, message: 'Essaie de contacter Internet directement (bloqué : une app passe par orion.net, avec l\'autorisation « Internet »)' },
  { level: 'warning', id: 'dynamic', pattern: /\beval\s*\(|\bnew\s+Function\s*\(|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]/, message: 'Exécute du code construit à la volée (eval)' },
  { level: 'warning', id: 'obfuscated', test: obfuscated, message: 'Code illisible ou masqué (obfuscation)' },
  { level: 'warning', id: 'credentials', pattern: /<input[^>]*type\s*=\s*["']?password|num[ée]ro de (?:carte|cb)|card number|\b(?:cvv|cvc|iban)\b/i, message: 'Demande un mot de passe ou des coordonnées bancaires' },
  { level: 'warning', id: 'storage', pattern: /\b(?:localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie)\b/, message: 'Utilise un stockage du navigateur (indisponible : utilisez orion.storage)' },
];

/** Longues chaînes d'échappements, de base64 ou d'hexadécimal : signe d'un code masqué. */
function obfuscated(code) {
  if (/(?:\\x[0-9a-f]{2}){40,}|(?:\\u[0-9a-f]{4}){30,}/i.test(code)) return true;
  if (/[A-Za-z0-9+/=]{1500,}/.test(code.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/gi, ''))) return true;
  return code.split('\n').some((line) => line.length > 5000);
}

/**
 * @param {string} code code de l'app (HTML, CSS et JavaScript)
 * @returns {{ level: 'safe' | 'warning' | 'danger', findings: { level: string, id: string, message: string }[] }}
 */
export function scanApp(code) {
  const source = String(code ?? '');
  const findings = RULES.filter((rule) => (rule.test ? rule.test(source) : rule.pattern.test(source))).map(({ level, id, message }) => ({ level, id, message }));
  const level = findings.some((f) => f.level === 'danger') ? 'danger' : findings.length ? 'warning' : 'safe';
  return { level, findings };
}
