/**
 * Contenu d'usine du système de fichiers (premier démarrage).
 */
import { landscapeSVG, svgToDataUrl } from '../lib/artwork.js';

export const HOME = '/home';

export const USER_DIRS = {
  Documents: 'Documents',
  Photos: 'Photos',
  Music: 'Musique',
  Downloads: 'Téléchargements',
  Recordings: 'Enregistrements',
};

const WELCOME = `Bienvenue sur Orion OS !

Quelques astuces pour bien démarrer :

• Balayez vers le haut depuis le bas de l'écran pour revenir à l'accueil.
• Balayez vers le haut et maintenez pour voir les applications récentes.
• Tirez la barre d'état vers le bas : à gauche les notifications,
  à droite le centre de contrôle.
• Balayez vers le haut sur l'accueil pour ouvrir le tiroir d'applications.
• Appuyez longuement sur une icône pour modifier l'écran d'accueil.
• Glissez depuis le bord gauche ou droit pour revenir en arrière.

Vous préférez les boutons Android ? Réglages → Personnalisation → Navigation.

En mode développeur (Réglages → Général → Informations : touchez 7 fois
le numéro de build), le Terminal vous donne accès au shell « osh » : essayez help, neofetch,
ls -l, ps ou pm list -a.
`;

const NOTES = [
  { title: 'Liste de courses', body: 'Liste de courses\n\n- Pain\n- Fromage\n- Tomates\n- Café\n- Chocolat noir' },
  { title: 'Idées de vacances', body: 'Idées de vacances\n\nBretagne en juin, randonnée sur le GR34.\nPorto pour un week-end prolongé.\nLes calanques de Marseille à vélo.' },
];

export function seedFilesystem(fs, now = Date.now()) {
  const sys = { system: true };
  fs.mkdir('/system', { recursive: true, ...sys });
  fs.mkdir('/system/bin', { recursive: true, ...sys });
  fs.mkdir('/data', { recursive: true });
  fs.mkdir('/tmp', { recursive: true });
  for (const dir of Object.keys(USER_DIRS)) fs.mkdir(`${HOME}/${dir}`, { recursive: true });
  fs.mkdir(`${HOME}/Documents/Notes`, { recursive: true });

  fs.writeFile(`${HOME}/Documents/Bienvenue.txt`, WELCOME);
  NOTES.forEach((note, i) => {
    fs.writeFile(`${HOME}/Documents/Notes/note-${now - (i + 1) * 3_600_000}.txt`, note.body);
  });

  const titles = ['Montagnes', 'Crépuscule', 'Aube', 'Nuit étoilée', 'Collines', 'Lavande'];
  titles.forEach((title, i) => {
    fs.writeFile(`${HOME}/Photos/${title}.svg`, svgToDataUrl(landscapeSVG(i * 7919 + 13)), { mime: 'image/svg+xml' });
  });
}

/** Fichiers système régénérés à chaque démarrage (lecture seule). */
export function writeSystemFiles(fs, os, commands) {
  const sys = { system: true };
  fs.mkdir('/system/bin', { recursive: true, ...sys });
  fs.writeFile('/system/version', `${os.name} ${os.version} (${os.build})\n`, sys);
  fs.writeFile(
    '/system/build.prop',
    [
      `ro.build.id=${os.build}`,
      `ro.build.version=${os.version}`,
      `ro.build.codename=${os.codename}`,
      `ro.product.name=${os.name}`,
      `ro.kernel=${os.kernel}`,
      'ro.locale=fr-FR',
    ].join('\n') + '\n',
    sys,
  );
  const existing = new Set(fs.readdir('/system/bin').map((e) => e.name));
  for (const name of commands) {
    if (!existing.has(name)) fs.writeFile(`/system/bin/${name}`, `#!osh builtin ${name}\n`, { mime: 'text/x-sh', ...sys });
  }
}
