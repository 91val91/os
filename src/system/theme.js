/**
 * Applique l'apparence (thème, couleur d'accent, fond d'écran, taille du
 * texte, luminosité, Night Shift, forme des icônes, vitesse d'animation).
 */
import { wallpaperCss } from './wallpapers.js';

const ICON_RADIUS = { squircle: '23%', rounded: '14%', circle: '50%' };

export class ThemeManager {
  constructor(ui) {
    this.ui = ui;
    this.media = window.matchMedia?.('(prefers-color-scheme: dark)');
    this.media?.addEventListener?.('change', () => this.apply());
  }

  get resolved() {
    const theme = this.ui.kernel?.settings.get('theme') ?? 'auto';
    if (theme === 'auto') return this.media?.matches ? 'dark' : 'light';
    return theme;
  }

  start() {
    const { settings } = this.ui.kernel;
    settings.watch('*', (_, key) => {
      if (['theme', 'accent', 'wallpaper', 'fontScale', 'brightness', 'nightShift', 'iconShape', 'animScale', 'batterySaver', 'showTouches'].includes(key)) this.apply();
    });
    this.apply();
  }

  apply() {
    const { settings, fs } = this.ui.kernel;
    const root = document.documentElement;
    const screen = this.ui.screen;
    const dark = this.resolved === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.setProperty('--accent', settings.get('accent'));
    root.style.setProperty('--font-scale', String(settings.get('fontScale')));
    root.style.setProperty('--icon-radius', ICON_RADIUS[settings.get('iconShape')] ?? ICON_RADIUS.squircle);
    const scale = settings.get('batterySaver') ? Math.min(settings.get('animScale'), 0.6) : settings.get('animScale');
    root.style.setProperty('--anim', String(scale));
    this.ui.animScale = scale;
    screen.style.setProperty('--wallpaper', wallpaperCss(settings.get('wallpaper'), fs));
    const brightness = Math.min(1, Math.max(0.15, settings.get('brightness')));
    this.ui.layers.filters.style.setProperty('--dim', String((1 - brightness) * 0.75));
    this.ui.layers.filters.classList.toggle('night', Boolean(settings.get('nightShift')));
    screen.classList.toggle('show-touches', Boolean(settings.get('showTouches')));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
    this.ui.statusbar?.refreshStyle();
  }
}
