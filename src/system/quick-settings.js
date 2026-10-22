/**
 * Réglages rapides partagés par le volet (Android) et le centre de contrôle (iOS).
 *
 * Wi‑Fi, données mobiles et Bluetooth reflètent l'état réel. Quand Orion ne
 * pilote pas la radio (navigateur d'un téléphone : c'est Android ou iOS qui
 * la gère), la tuile ouvre la page des Réglages qui explique l'état réel.
 */
import { unsupportedReason } from '../kernel/bluetooth.js';

const QUALITY = { '4g': 'Rapide', '3g': 'Moyenne', '2g': 'Lente', 'slow-2g': 'Très lente' };

export function quickTiles(ui) {
  const k = ui.kernel;
  const s = k.settings;
  const net = () => k.network.state;
  const tel = () => k.telephony.network;
  const bt = k.bluetooth;
  const toggle = (key, onLabel, offLabel) => () => {
    const value = s.toggle(key);
    ui.dialogs.toast(value ? onLabel : offLabel);
  };
  const openPage = (page) => {
    ui.shade?.close();
    ui.controlCenter?.close();
    ui.openIntent({ app: 'settings', action: 'view', data: { page } });
  };
  const failed = (error) => ui.dialogs.toast(error.message);
  return {
    wifi: {
      label: 'Wi‑Fi',
      icon: 'wifi',
      iconOff: 'wifi-off',
      active: () => (net().wifi.controllable ? net().wifi.enabled : net().type === 'wifi'),
      detail: () => {
        const { wifi, type, online } = net();
        if (wifi.controllable) return wifi.enabled ? wifi.connected?.ssid ?? 'Non connecté' : 'Désactivé';
        return type === 'wifi' ? 'Connecté' : online ? 'Non utilisé' : 'Hors ligne';
      },
      toggle: () => (net().wifi.controllable ? k.network.setWifiEnabled(!net().wifi.enabled).catch(failed) : openPage('wifi')),
      settings: 'wifi',
    },
    cellular: {
      label: 'Données mobiles',
      icon: 'antenna',
      active: () => {
        const t = tel();
        if (t.mode === 'modem') return t.data && !t.airplane;
        if (t.mode === 'simulated') return t.cellular;
        return net().type === 'cellular';
      },
      detail: () => {
        const t = tel();
        if (t.airplane) return 'Mode avion';
        if (t.mode === 'modem') return t.data ? t.operator : t.cellular ? 'Désactivées' : t.operator;
        if (t.mode === 'simulated') return t.cellular ? 'Orion Mobile' : 'Désactivées';
        return net().type === 'cellular' ? QUALITY[net().quality] ?? 'Connecté' : 'Gérées par le téléphone';
      },
      toggle: () => {
        const t = tel();
        if (t.mode === 'modem') return k.telephony.setMobileData(!t.data).catch(failed);
        if (t.mode === 'simulated') return s.toggle('cellular');
        return openPage('cellular');
      },
      settings: 'cellular',
    },
    bluetooth: {
      label: 'Bluetooth',
      icon: 'bluetooth',
      active: () => bt.enabled,
      detail: () => {
        if (!bt.available) return 'Indisponible';
        if (!bt.enabled) return 'Désactivé';
        const count = bt.connectedCount;
        return count ? `${count} connecté${count > 1 ? 's' : ''}` : 'Activé';
      },
      toggle: () => (bt.available ? bt.setPowered(!bt.enabled).catch(failed) : ui.dialogs.toast(unsupportedReason())),
      settings: 'bluetooth',
    },
    airplane: { label: 'Mode avion', icon: 'airplane', active: () => s.get('airplane'), toggle: () => s.toggle('airplane'), color: '#ff9f0a' },
    dnd: { label: 'Ne pas déranger', icon: 'moon-fill', active: () => s.get('dnd'), toggle: toggle('dnd', 'Ne pas déranger activé', 'Ne pas déranger désactivé'), color: '#5e5ce6' },
    flashlight: { label: 'Lampe torche', icon: 'flashlight', active: () => s.get('flashlight'), toggle: () => s.toggle('flashlight'), color: '#ffd60a' },
    rotation: { label: 'Rotation auto', icon: 'rotate-lock', active: () => !s.get('rotationLock'), toggle: () => s.toggle('rotationLock') },
    saver: { label: 'Économie', icon: 'leaf', active: () => s.get('batterySaver'), toggle: toggle('batterySaver', 'Économiseur de batterie activé', 'Économiseur de batterie désactivé'), color: '#ffd60a' },
    dark: { label: 'Mode sombre', icon: 'contrast', active: () => ui.theme.resolved === 'dark', toggle: () => s.set('theme', ui.theme.resolved === 'dark' ? 'light' : 'dark') },
    location: {
      label: 'Localisation',
      icon: 'location',
      active: () => s.get('location'),
      detail: () => (!s.get('location') ? 'Désactivée' : k.location.source === 'gps' ? 'GPS' : k.location.source ? 'Activée' : 'Indisponible'),
      toggle: () => s.toggle('location'),
      settings: 'location',
    },
    silent: { label: 'Silencieux', icon: 'bell-off', active: () => s.get('silent'), toggle: toggle('silent', 'Mode silencieux activé', 'Sonnerie activée'), color: '#ff453a' },
  };
}
