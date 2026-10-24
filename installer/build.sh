#!/bin/bash
# Construit l'image ISO d'Orion OS (amd64, démarrage BIOS et UEFI) avec
# live-build de Debian 12 « bookworm ». L'image démarre directement sur
# Orion en plein écran (clé USB, machine virtuelle) et peut l'installer sur
# le disque (entrée « Install » du menu de démarrage).
#
#   sudo installer/build.sh            # sur Debian 12 (ou Ubuntu avec le live-build de Debian)
#   installer/build-in-docker.sh       # depuis n'importe quel système avec Docker
#
# Résultat : installer/out/orion-os-<version>-amd64.iso (+ .sha256).
# Variables : ORION_BUILD_DIR (dossier de travail, défaut installer/build),
# ORION_OUT_DIR (défaut installer/out), ORION_MIRROR (défaut deb.debian.org),
# HOST_UID/HOST_GID (propriétaire des fichiers produits, pour Docker).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
WORK="${ORION_BUILD_DIR:-$HERE/build}"
OUT="${ORION_OUT_DIR:-$HERE/out}"
MIRROR="${ORION_MIRROR:-http://deb.debian.org/debian/}"

die() {
	echo "Erreur : $*" >&2
	exit 1
}
info() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "à lancer en root (sudo $0) : live-build crée un système complet dans un chroot."
[ -r /etc/debian_version ] || die "il faut Debian ou Ubuntu ; ailleurs, utilisez installer/build-in-docker.sh."
command -v lb >/dev/null 2>&1 || die "live-build est absent : apt install live-build"
command -v python3 >/dev/null 2>&1 || die "python3 est absent : apt install python3"
lb_version="$(dpkg-query -W -f='${Version}' live-build 2>/dev/null || true)"
case "$lb_version" in
	3.*) die "live-build $lb_version est la version d'Ubuntu, incompatible : utilisez installer/build-in-docker.sh (Debian 12)." ;;
	1:2023* | 1:2024* | 1:2025* | 1:2026*) ;;
	*) echo "Attention : live-build $lb_version non testé (version de Debian 12 : 1:20230502)." >&2 ;;
esac

VERSION="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$REPO/version.json")"
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]*$ ]] || die "version invalide dans version.json : $VERSION"
NAME="orion-os-$VERSION-amd64"
info "Orion OS $VERSION → $OUT/$NAME.iso"

# version.json doit décrire exactement les fichiers livrés : le service worker
# d'Orion vérifie chaque empreinte au premier démarrage.
python3 - "$REPO" <<'EOF' || die "version.json ne correspond pas aux fichiers : lancez « npm run release »."
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "version.json").read_text(encoding="utf-8"))
bad = []
for path, meta in manifest["files"].items():
    file = root / path
    if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != meta["hash"]:
        bad.append(path)
for path in bad[:20]:
    print(f"  différent ou absent : {path}", file=sys.stderr)
sys.exit(1 if bad else 0)
EOF

mkdir -p "$WORK" "$OUT"
cd "$WORK"
# Nouvelle configuration à chaque fois ; le cache des paquets (cache/) est gardé.
if [ -d chroot ] || [ -d binary ] || [ -d .build ]; then
	lb clean
fi
rm -rf config auto

info "Configuration de live-build"
# Paramètres du système live (y compris en mode sans échec) : sans username=orion,
# live-config créerait l'utilisateur « user » et orion-server ne démarrerait pas.
LIVE_OPTIONS="locales=fr_FR.UTF-8 keyboard-layouts=fr timezone=Europe/Paris hostname=orion username=orion user-fullname=Orion user-default-groups=audio,cdrom,dip,video,render,input,plugdev,netdev,bluetooth,dialout,systemd-journal"
lb config \
	--mode debian \
	--distribution bookworm \
	--architecture amd64 \
	--archive-areas "main contrib non-free-firmware" \
	--mirror-bootstrap "$MIRROR" \
	--mirror-chroot "$MIRROR" \
	--mirror-binary "$MIRROR" \
	--security true \
	--updates true \
	--apt-recommends true \
	--linux-flavours amd64 \
	--firmware-chroot false \
	--firmware-binary false \
	--binary-images iso-hybrid \
	--bootloaders "syslinux,grub-efi" \
	--uefi-secure-boot auto \
	--debian-installer live \
	--debian-installer-gui true \
	--debian-installer-distribution bookworm \
	--memtest none \
	--checksums sha256 \
	--zsync false \
	--image-name "orion-os-$VERSION" \
	--iso-application "Orion OS" \
	--iso-publisher "Orion OS" \
	--iso-volume "Orion OS $VERSION" \
	--bootappend-live "boot=live components quiet splash $LIVE_OPTIONS" \
	--bootappend-live-failsafe "boot=live components noapic noapm nodma nomce nolapic nosmp nomodeset vga=normal $LIVE_OPTIONS"

info "Ajout de la configuration d'Orion"
cp -a "$HERE/config/." "$WORK/config/"
chmod 0755 "$WORK"/config/hooks/normal/*.hook.chroot "$WORK/config/includes.chroot/usr/local/bin/orion-kiosk"

# Version initiale de l'interface, servie par orion-server depuis /var/lib/orion/current.
STATE="$WORK/config/includes.chroot/var/lib/orion"
mkdir -p "$STATE/releases/$VERSION"
for item in index.html sw.js version.json manifest.webmanifest assets src; do
	cp -a "$REPO/$item" "$STATE/releases/$VERSION/"
done
ln -sfn "releases/$VERSION" "$STATE/current"
install -D -m 0755 "$REPO/server/orion_server.py" "$WORK/config/includes.chroot/opt/orion-server/orion_server.py"
install -D -m 0644 "$REPO/server/orion_mail.py" "$WORK/config/includes.chroot/opt/orion-server/orion_mail.py"
install -D -m 0644 "$REPO/server/orion_net.py" "$WORK/config/includes.chroot/opt/orion-server/orion_net.py"
install -D -m 0644 "$REPO/server/API.md" "$WORK/config/includes.chroot/opt/orion-server/API.md"

info "Construction (30 à 60 min, environ 1,5 Go téléchargés au premier passage)"
if ! lb build 2>&1 | tee "$WORK/build.log"; then
	die "la construction a échoué : voir $WORK/build.log"
fi

shopt -s nullglob
isos=("$WORK"/*.iso)
[ "${#isos[@]}" -gt 0 ] || die "aucune image produite : voir $WORK/build.log"
mv -f "${isos[0]}" "$OUT/$NAME.iso"
(cd "$OUT" && sha256sum "$NAME.iso" >"$NAME.iso.sha256")
if [ -n "${HOST_UID:-}" ]; then
	chown "$HOST_UID:${HOST_GID:-$HOST_UID}" "$OUT" "$OUT/$NAME.iso" "$OUT/$NAME.iso.sha256"
fi
info "Image prête : $OUT/$NAME.iso ($(du -h "$OUT/$NAME.iso" | cut -f1))"
info "Essai : installer/run-vm.sh   ·   clé USB : voir installer/README.md"
