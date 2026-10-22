# shellcheck shell=bash
# ~/.bash_profile d'Orion OS.

# Réglages habituels (PATH, ~/.bashrc…).
if [ -f "$HOME/.profile" ]; then
	# shellcheck disable=SC1091
	. "$HOME/.profile"
fi

# Sur tty1 (connexion automatique au démarrage), l'interface d'Orion s'ouvre en
# plein écran. Les autres consoles (Ctrl+Alt+F2…) restent un shell de dépannage.
# Pour ne plus lancer l'interface : touch ~/.config/orion/sans-interface
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(tty)" = /dev/tty1 ] &&
	[ ! -e "$HOME/.config/orion/sans-interface" ] && [ -x /usr/local/bin/orion-kiosk ]; then
	exec /usr/local/bin/orion-kiosk
fi
