# Environnement de construction de l'image d'Orion OS : Debian 12 et son live-build.
# Utilisé par installer/build-in-docker.sh (docker run --privileged).
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y live-build debootstrap python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /orion
ENTRYPOINT ["/orion/installer/build.sh"]
