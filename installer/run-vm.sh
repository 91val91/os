#!/bin/bash
# Démarre l'image d'Orion OS dans une machine virtuelle QEMU.
#
#   installer/run-vm.sh                          # la dernière image de installer/out/
#   installer/run-vm.sh --iso orion.iso --bios   # démarrage BIOS au lieu d'UEFI
#   installer/run-vm.sh --disk orion.qcow2       # avec un disque (créé s'il manque) pour essayer l'installation
#   installer/run-vm.sh --disk orion.qcow2 --no-iso   # démarrer le système installé
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISO=""
DISK=""
DISK_SIZE="16G"
BOOT_ISO=1
FIRMWARE="auto"
MEMORY=3072
CPUS=2
GPU="virtio"

usage() {
	cat <<EOF
Usage : $0 [options]
  --iso FICHIER      image à démarrer (défaut : la plus récente de installer/out/)
  --disk FICHIER     disque virtuel qcow2, créé s'il n'existe pas (pour tester l'installation)
  --disk-size TAILLE taille d'un nouveau disque (défaut : $DISK_SIZE)
  --no-iso           démarrer sur le disque seulement (système installé)
  --uefi | --bios    micrologiciel (défaut : UEFI si OVMF est installé, sinon BIOS)
  --memory Mo        mémoire (défaut : $MEMORY, entre 2048 et 4096 conseillé)
  --cpus N           processeurs (défaut : $CPUS)
  --gpu virtio|std   carte graphique (défaut : virtio ; std si l'écran reste noir)
EOF
}

die() {
	echo "Erreur : $*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
		--iso) ISO="${2:?}"; shift 2 ;;
		--disk) DISK="${2:?}"; shift 2 ;;
		--disk-size) DISK_SIZE="${2:?}"; shift 2 ;;
		--no-iso) BOOT_ISO=0; shift ;;
		--uefi) FIRMWARE="uefi"; shift ;;
		--bios) FIRMWARE="bios"; shift ;;
		--memory | --mem) MEMORY="${2:?}"; shift 2 ;;
		--cpus) CPUS="${2:?}"; shift 2 ;;
		--gpu) GPU="${2:?}"; shift 2 ;;
		-h | --help) usage; exit 0 ;;
		*) usage >&2; die "option inconnue : $1" ;;
	esac
done

QEMU="qemu-system-x86_64"
command -v "$QEMU" >/dev/null 2>&1 || die "$QEMU est introuvable (Debian/Ubuntu : apt install qemu-system-x86 ovmf ; macOS : brew install qemu)."

if [ "$BOOT_ISO" = 1 ] && [ -z "$ISO" ]; then
	for candidate in "$HERE"/out/*.iso; do
		[ -e "$candidate" ] || continue
		if [ -z "$ISO" ] || [ "$candidate" -nt "$ISO" ]; then
			ISO="$candidate"
		fi
	done
	[ -n "$ISO" ] || die "aucune image dans $HERE/out/ : construisez-la (installer/build.sh) ou indiquez --iso."
fi
[ "$BOOT_ISO" = 0 ] || [ -f "$ISO" ] || die "image introuvable : $ISO"
[ "$BOOT_ISO" = 1 ] || [ -n "$DISK" ] || die "--no-iso demande --disk."

ARGS=(-name "Orion OS" -machine q35 -m "$MEMORY" -smp "$CPUS")

# Accélération : KVM (Linux), HVF (Mac Intel), sinon émulation (lente).
if [ -w /dev/kvm ]; then
	ARGS+=(-accel kvm -cpu host)
elif [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = x86_64 ]; then
	ARGS+=(-accel hvf -cpu host)
else
	echo "Attention : pas d'accélération matérielle (KVM), la machine virtuelle sera lente." >&2
	ARGS+=(-accel tcg -cpu max)
fi

# Micrologiciel UEFI (OVMF) si disponible.
OVMF_CODE=""
OVMF_VARS=""
if [ "$FIRMWARE" != bios ]; then
	for pair in \
		/usr/share/OVMF/OVMF_CODE_4M.fd:/usr/share/OVMF/OVMF_VARS_4M.fd \
		/usr/share/OVMF/OVMF_CODE.fd:/usr/share/OVMF/OVMF_VARS.fd \
		/usr/share/edk2/x64/OVMF_CODE.4m.fd:/usr/share/edk2/x64/OVMF_VARS.4m.fd \
		/usr/share/edk2/ovmf/OVMF_CODE.fd:/usr/share/edk2/ovmf/OVMF_VARS.fd \
		/usr/share/qemu/edk2-x86_64-code.fd:/usr/share/qemu/edk2-i386-vars.fd \
		/opt/homebrew/share/qemu/edk2-x86_64-code.fd:/opt/homebrew/share/qemu/edk2-i386-vars.fd \
		/usr/local/share/qemu/edk2-x86_64-code.fd:/usr/local/share/qemu/edk2-i386-vars.fd; do
		if [ -r "${pair%%:*}" ] && [ -r "${pair##*:}" ]; then
			OVMF_CODE="${pair%%:*}"
			OVMF_VARS="${pair##*:}"
			break
		fi
	done
	if [ -z "$OVMF_CODE" ]; then
		[ "$FIRMWARE" = auto ] || die "OVMF (UEFI) introuvable : apt install ovmf, ou utilisez --bios."
		FIRMWARE="bios"
	else
		FIRMWARE="uefi"
	fi
fi
if [ "$FIRMWARE" = uefi ]; then
	# Variables UEFI modifiables (entrées de démarrage), gardées à côté du disque.
	if [ -n "$DISK" ]; then
		VARS="$DISK.uefi-vars.fd"
	else
		mkdir -p "$HERE/out"
		VARS="$HERE/out/uefi-vars.fd"
	fi
	[ -f "$VARS" ] || cp "$OVMF_VARS" "$VARS"
	ARGS+=(-drive "if=pflash,format=raw,unit=0,readonly=on,file=$OVMF_CODE" -drive "if=pflash,format=raw,unit=1,file=$VARS")
fi

case "$GPU" in
	virtio) ARGS+=(-vga none -device virtio-vga) ;;
	std) ARGS+=(-vga std) ;;
	*) die "--gpu : virtio ou std" ;;
esac

# Tablette USB : pointeur absolu, comme un écran tactile.
ARGS+=(-device qemu-xhci -device usb-tablet)
ARGS+=(-netdev "user,id=net0" -device "virtio-net-pci,netdev=net0")

if [ -n "$DISK" ]; then
	if [ ! -e "$DISK" ]; then
		command -v qemu-img >/dev/null 2>&1 || die "qemu-img introuvable"
		qemu-img create -f qcow2 "$DISK" "$DISK_SIZE"
	fi
	ARGS+=(-drive "file=$DISK,if=none,id=hd0,format=qcow2" -device "virtio-blk-pci,drive=hd0,bootindex=1")
fi
if [ "$BOOT_ISO" = 1 ]; then
	ARGS+=(-drive "file=$ISO,if=none,id=cd0,media=cdrom,readonly=on" -device "ide-cd,drive=cd0,bootindex=0")
fi

echo "==> Orion OS dans QEMU ($FIRMWARE, $MEMORY Mo) : ${ISO:-$DISK}"
echo "    Ctrl+Alt+G libère la souris ; Ctrl+Alt+F2 dans la machine ouvre une console."
exec "$QEMU" "${ARGS[@]}"
