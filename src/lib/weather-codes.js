/**
 * Codes météo WMO (utilisés par l'API Open-Meteo) → libellé et icône.
 */
const CODES = [
  [[0], 'Ciel dégagé', 'sun', 'moon'],
  [[1], 'Peu nuageux', 'cloud-sun', 'moon'],
  [[2], 'Partiellement nuageux', 'cloud-sun', 'cloud'],
  [[3], 'Couvert', 'cloud', 'cloud'],
  [[45, 48], 'Brouillard', 'fog', 'fog'],
  [[51, 53, 55, 56, 57], 'Bruine', 'rain', 'rain'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'Pluie', 'rain', 'rain'],
  [[71, 73, 75, 77, 85, 86], 'Neige', 'snow', 'snow'],
  [[95, 96, 99], 'Orage', 'storm', 'storm'],
];

export function describeWeather(code, isDay = true) {
  const entry = CODES.find(([codes]) => codes.includes(code)) ?? CODES[3];
  return { label: entry[1], icon: isDay ? entry[2] : entry[3] };
}

/** Dégradé d'arrière-plan selon le temps et l'heure. */
export function weatherGradient(code, isDay = true) {
  if (!isDay) return 'linear-gradient(180deg, #0b1026 0%, #1d2b5a 60%, #3b4a7a 100%)';
  if ([0, 1].includes(code)) return 'linear-gradient(180deg, #2f80ed 0%, #56ccf2 100%)';
  if ([2, 3, 45, 48].includes(code)) return 'linear-gradient(180deg, #5c7088 0%, #9aaabb 100%)';
  if ([95, 96, 99].includes(code)) return 'linear-gradient(180deg, #2c2f48 0%, #5a5f80 100%)';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'linear-gradient(180deg, #8ea9c4 0%, #d8e4ee 100%)';
  return 'linear-gradient(180deg, #45607d 0%, #7d93ab 100%)';
}
