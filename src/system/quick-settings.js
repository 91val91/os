/**
 * Réglages rapides partagés par le volet (Android) et le centre de contrôle (iOS).
 */
export function quickTiles(ui) {
  const s = ui.kernel.settings;
  const toggle = (key, onLabel, offLabel) => () => {
    const value = s.toggle(key);
    ui.dialogs.toast(value ? onLabel : offLabel);
  };
  return {
    wifi: { label: 'Wi‑Fi', icon: 'wifi', iconOff: 'wifi-off', active: () => s.get('wifi') && !s.get('airplane'), detail: () => (s.get('wifi') && !s.get('airplane') ? s.get('wifiNetwork') : 'Désactivé'), toggle: () => s.toggle('wifi'), settings: 'wifi' },
    cellular: { label: 'Données mobiles', icon: 'antenna', active: () => s.get('cellular') && !s.get('airplane'), detail: () => (s.get('airplane') ? 'Mode avion' : s.get('cellular') ? 'Orion Mobile' : 'Désactivées'), toggle: () => s.toggle('cellular') },
    bluetooth: { label: 'Bluetooth', icon: 'bluetooth', active: () => s.get('bluetooth') && !s.get('airplane'), detail: () => (s.get('bluetooth') ? 'Activé' : 'Désactivé'), toggle: () => s.toggle('bluetooth'), settings: 'bluetooth' },
    airplane: { label: 'Mode avion', icon: 'airplane', active: () => s.get('airplane'), toggle: () => s.toggle('airplane'), color: '#ff9f0a' },
    dnd: { label: 'Ne pas déranger', icon: 'moon-fill', active: () => s.get('dnd'), toggle: toggle('dnd', 'Ne pas déranger activé', 'Ne pas déranger désactivé'), color: '#5e5ce6' },
    flashlight: { label: 'Lampe torche', icon: 'flashlight', active: () => s.get('flashlight'), toggle: () => s.toggle('flashlight'), color: '#ffd60a' },
    rotation: { label: 'Rotation auto', icon: 'rotate-lock', active: () => !s.get('rotationLock'), toggle: () => s.toggle('rotationLock') },
    saver: { label: 'Économie', icon: 'leaf', active: () => s.get('batterySaver'), toggle: toggle('batterySaver', 'Économiseur de batterie activé', 'Économiseur de batterie désactivé'), color: '#ffd60a' },
    dark: { label: 'Mode sombre', icon: 'contrast', active: () => ui.theme.resolved === 'dark', toggle: () => s.set('theme', ui.theme.resolved === 'dark' ? 'light' : 'dark') },
    location: { label: 'Localisation', icon: 'location', active: () => s.get('location'), toggle: () => s.toggle('location') },
    silent: { label: 'Silencieux', icon: 'bell-off', active: () => s.get('silent'), toggle: toggle('silent', 'Mode silencieux activé', 'Sonnerie activée'), color: '#ff453a' },
  };
}
