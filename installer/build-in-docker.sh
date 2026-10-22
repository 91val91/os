#!/bin/bash
# Construit l'image d'Orion OS depuis n'importe quel système (Linux, macOS,
# Windows avec WSL) grâce à Docker : la construction a lieu dans un conteneur
# Debian 12 privilégié (live-build monte /proc et /dev dans un chroot).
#
#   installer/build-in-docker.sh
#
# Le dossier de travail reste dans un volume Docker (orion-os-build) : les
# paquets téléchargés servent aux constructions suivantes. Résultat dans
# installer/out/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
IMAGE="orion-os-builder"

command -v docker >/dev/null 2>&1 || {
	echo "Erreur : Docker est introuvable (https://docs.docker.com/get-docker/)." >&2
	exit 1
}

echo "==> Préparation de l'environnement de construction (Debian 12)"
docker build --platform linux/amd64 -t "$IMAGE" "$HERE"

echo "==> Construction de l'image d'Orion OS"
docker run --rm --privileged --platform linux/amd64 \
	-v "$REPO:/orion" \
	-v orion-os-build:/build \
	-e ORION_BUILD_DIR=/build \
	-e HOST_UID="$(id -u)" \
	-e HOST_GID="$(id -g)" \
	"$IMAGE" "$@"
