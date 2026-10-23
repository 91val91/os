#!/bin/bash
# Test de démarrage de l'image d'Orion OS dans QEMU, sans écran (utilisé par
# l'action GitHub « Installateur ») :
#   1. démarre l'ISO avec la console série (journal du système copié dessus) ;
#   2. attend le démarrage d'orion-server dans le journal. Il n'écoute que sur
#      127.0.0.1 dans la machine (par sécurité) : la redirection de port de
#      QEMU ne peut pas l'atteindre depuis l'hôte ; c'est l'interface, lancée
#      dans la machine, qui vérifie qu'il répond ;
#   3. attend le lancement de l'interface (cage + Chromium) et enregistre une
#      capture de l'écran ;
#   4. vérifie que l'écran n'est pas resté noir.
#
#   installer/boot-test.sh installer/out/orion-os-0.1-amd64.iso [dossier-de-sortie]
#
# BOOT_TEST_GPU=virtio (défaut, interface Wayland avec cage) ou std (carte
# standard de QEMU, refusée par cage : l'interface doit passer à X11).
#
# Sortie : serial.log (journal du démarrage), screen.png (capture), orion.log (lignes d'Orion).
set -euo pipefail

ISO="${1:?usage : $0 image.iso [dossier-de-sortie]}"
OUT="${2:-boot-test}"
DEADLINE="${BOOT_TEST_TIMEOUT:-1500}" # secondes (sans KVM, tout est émulé et lent)
GPU="${BOOT_TEST_GPU:-virtio}"
case "$GPU" in
	virtio) VGA=(-vga none -device virtio-vga) ;;
	std) VGA=(-vga std) ;;
	*) echo "Erreur : BOOT_TEST_GPU=virtio ou std" >&2; exit 2 ;;
esac

for tool in qemu-system-x86_64 xorriso convert; do
	command -v "$tool" >/dev/null 2>&1 || { echo "Erreur : $tool est introuvable" >&2; exit 2; }
done
mkdir -p "$OUT"
WORK="$(mktemp -d)"
QEMU_PID=""
cleanup() {
	if [ -n "$QEMU_PID" ]; then kill "$QEMU_PID" 2>/dev/null || true; fi
	rm -rf "$WORK"
}
trap cleanup EXIT

# Noyau, initrd et ligne de commande de la première entrée du menu (système live) ;
# la console série y est ajoutée.
xorriso -osirrox on -indev "$ISO" -extract /boot/grub/grub.cfg "$WORK/grub.cfg" >/dev/null 2>&1
# Entrée normale du système live : celle qui porte les paramètres d'Orion
# (username=orion…), pas le « mode sans échec » de live-build. Le paramètre
# findiso=${iso_path} de GRUB est retiré plus bas.
LINUX_LINE="$(grep -E '^\s*linux\s+\S*/live/\S+.*boot=live' "$WORK/grub.cfg" | grep -m1 'username=orion' || true)"
[ -n "$LINUX_LINE" ] || LINUX_LINE="$(grep -m1 -E '^\s*linux\s+\S*/live/\S+.*boot=live' "$WORK/grub.cfg")"
KERNEL="$(echo "$LINUX_LINE" | awk '{print $2}')"
INITRD="$(grep -m1 -E '^\s*initrd\s+\S*/live/' "$WORK/grub.cfg" | awk '{print $2}')"
case "$LINUX_LINE" in
	*username=orion*) ;;
	*) echo "::warning::Paramètres d'Orion absents de l'entrée de démarrage : $LINUX_LINE" ;;
esac
if [ -z "$KERNEL" ] || [ -z "$INITRD" ]; then
	echo "Erreur : entrée live introuvable dans grub.cfg" >&2
	cat "$WORK/grub.cfg" >&2
	exit 2
fi
xorriso -osirrox on -indev "$ISO" -extract "$KERNEL" "$WORK/vmlinuz" -extract "$INITRD" "$WORK/initrd.img" >/dev/null 2>&1
# Paramètres du menu, sans « quiet », « splash » ni variables de GRUB (${…}, findiso=…).
ARGS="$(echo "$LINUX_LINE" | awk '{ for (i = 3; i <= NF; i++) if ($i != "quiet" && $i != "splash" && $i !~ /^findiso=/ && $i !~ /\$\{/) printf "%s ", $i }')"
APPEND="$ARGS console=tty1 console=ttyS0,115200 systemd.journald.forward_to_console=1"
echo "==> Ligne de commande : $APPEND"

ACCEL="tcg"
if [ -w /dev/kvm ]; then ACCEL="kvm"; fi
echo "==> Accélération : $ACCEL · carte graphique : $GPU"

qemu-system-x86_64 \
	-machine "q35,accel=$ACCEL" -cpu max -m 3072 -smp 2 \
	-cdrom "$ISO" -kernel "$WORK/vmlinuz" -initrd "$WORK/initrd.img" -append "$APPEND" \
	-netdev "user,id=net0" -device virtio-net-pci,netdev=net0 \
	"${VGA[@]}" -display none \
	-serial "file:$OUT/serial.log" \
	-monitor "unix:$WORK/monitor.sock,server,nowait" &
QEMU_PID=$!

monitor() {
	python3 - "$WORK/monitor.sock" "$1" <<'PY'
import socket, sys, time
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
s.recv(4096)
s.sendall((sys.argv[2] + "\n").encode())
time.sleep(1)
s.close()
PY
}

start=$(date +%s)
elapsed() { echo $(( $(date +%s) - start )); }

# Aperçu réduit d'une capture dans le journal de l'action (les artefacts ne sont pas toujours
# accessibles) : en caractères (lisible tel quel), puis en JPEG base64.
preview() {
	echo "----- ÉCRAN EN CARACTÈRES (clair = « @ », noir = « ␠ ») -----"
	convert "$OUT/screen.png" -resize '96x32!' -colorspace Gray -depth 8 txt:- |
		awk -F'[ ,:]+' 'NR > 1 {
			v = $0; sub(/.*gray\(/, "", v); sub(/[%)].*/, "", v); if ($0 ~ /%\)/) v = v * 2.55
			c = substr(" .:-=+*#%@", int(v / 25.6) + 1, 1)
			row[$2] = row[$2] c
		} END { for (y = 0; y in row; y++) print "|" row[y] "|" }'
	echo "----- APERÇU -----"
	convert "$OUT/screen.png" -resize 320x -quality 70 jpg:- | base64 -w 0
	echo
	echo "----- FIN APERÇU -----"
}

failed() {
	echo "Erreur : $1" >&2
	tail -80 "$OUT/serial.log" >&2
	# Ce que montre l'écran de la machine (console tty1, message d'erreur…).
	if kill -0 "$QEMU_PID" 2>/dev/null; then
		monitor "screendump $WORK/screen.ppm"
		sleep 1
		if convert "$WORK/screen.ppm" "$OUT/screen.png" 2>/dev/null; then
			echo "==> Écran au moment de l'échec :"
			preview
		fi
	fi
	exit 1
}

# Attend une ligne du journal (expression régulière étendue), en surveillant les échecs ;
# $3 : délai maximal en secondes (DEADLINE par défaut).
wait_for() {
	local limit=$(( $(elapsed) + ${3:-$DEADLINE} ))
	until grep -qE "$1" "$OUT/serial.log" 2>/dev/null; do
		kill -0 "$QEMU_PID" 2>/dev/null || failed "QEMU s'est arrêté"
		if grep -qE "BOOT FAILED|Kernel panic|emergency mode|orion-server.service: Failed at step" "$OUT/serial.log" 2>/dev/null; then
			failed "le démarrage a échoué"
		fi
		[ "$(elapsed)" -lt "$limit" ] || failed "$2 (au bout de $(elapsed) s)"
		sleep 5
	done
}

# 2. orion-server démarré (journal copié sur la console série).
wait_for "Orion OS servi sur http://127\.0\.0\.1" "orion-server n'a pas démarré"
echo "==> orion-server démarré après $(elapsed) s"

# 3. L'interface : Chromium dans cage, sur tty1. Avant, orion-kiosk vérifie qu'orion-server
#    répond dans la machine (il l'écrit dans le journal sinon).
wait_for "Lancement de l'interface" "l'interface ne s'est pas lancée" "${BOOT_TEST_UI_TIMEOUT:-300}"
echo "==> Interface lancée après $(elapsed) s"
if grep -q "orion-server ne répond pas" "$OUT/serial.log"; then
	failed "orion-server ne répond pas dans la machine"
fi
# Chromium charge Orion puis l'assistant de configuration s'affiche : captures successives
# jusqu'à un écran clair (l'assistant), BOOT_TEST_SETTLE secondes au plus.
settle_until=$(( $(elapsed) + ${BOOT_TEST_SETTLE:-180} ))
lit=0
while :; do
	sleep 10
	monitor "screendump $WORK/screen.ppm"
	sleep 1
	convert "$WORK/screen.ppm" "$OUT/screen.png"
	# 4. Écran : part des pixels non noirs.
	lit="$(convert "$OUT/screen.png" -colorspace Gray -threshold 8% -format '%[fx:mean]' info:)"
	if awk "BEGIN { exit !($lit >= 0.3) }" || [ "$(elapsed)" -ge "$settle_until" ]; then break; fi
done
# Encore un peu de temps : l'écran affiché a pu être une transition (fondu du démarrage).
sleep 10
monitor "screendump $WORK/screen.ppm"
sleep 1
convert "$WORK/screen.ppm" "$OUT/screen.png"
lit="$(convert "$OUT/screen.png" -colorspace Gray -threshold 8% -format '%[fx:mean]' info:)"
echo "==> Part de l'écran allumée : $lit (après $(elapsed) s)"
grep -E "orion-kiosk|orion-server|orion_server" "$OUT/serial.log" | tee "$OUT/orion.log" | tail -20 || true
echo "==> Aperçu (JPEG 320 px, base64) :"
preview
mode="$(grep -o "Lancement de l'interface ([^)]*)" "$OUT/serial.log" | tail -n 1)"
echo "==> Affichage : ${mode:-inconnu}"
if awk "BEGIN { exit !($lit < 0.02) }"; then
	echo "Erreur : l'écran est resté noir, l'interface ne s'affiche pas (carte $GPU)" >&2
	exit 1
fi
echo "==> Démarrage vérifié en $(elapsed) s"
