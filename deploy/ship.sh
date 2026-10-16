#!/bin/sh
# Ship the server image and one server's Compose files to a VPS over SSH, from the machine that
# holds the repository: no Rust build on the server (slow on 2 vCPUs, and 2 GB of memory can run
# out) and no repository access there (it can stay private).
#
#   sh deploy/ship.sh <user@host> api|signer
#
# Builds blindbook:latest here from the checked-out commit (cached layers make it quick when
# nothing changed, and an older image is never shipped by mistake), streams it to the server's Docker
# (docker save | gzip | ssh … docker load), and copies deploy/<role> to ~/blindbook/deploy/<role>
# there: Compose files, Caddy and Tor configuration, examples and, for the API, onion-site/ once
# deploy/web/build.sh has made it. Env files, keys, config and data are never sent: those are
# made on the server. SSH_OPTS overrides the key (default: -i ~/.ssh/blindbook_vps).
set -eu
[ $# -eq 2 ] || { echo "usage: sh deploy/ship.sh <user@host> api|signer"; exit 2; }
host="$1"
role="$2"
case "$role" in api | signer) ;; *) echo "the role is api or signer"; exit 2 ;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
ssh_opts="${SSH_OPTS:--i $HOME/.ssh/blindbook_vps}"

[ -z "$(git -C "$root" status --porcelain 2>/dev/null)" ] || echo "warning: uncommitted changes go into the image"
docker build -q -f "$root/deploy/Dockerfile" -t blindbook:latest "$root" > /dev/null
echo "image $(docker image inspect blindbook:latest --format '{{.Id}}') of $(git -C "$root" rev-parse --short HEAD 2>/dev/null) → $host"
# shellcheck disable=SC2086
docker save blindbook:latest | gzip | ssh $ssh_opts "$host" 'gunzip | docker load'

# shellcheck disable=SC2086
tar -C "$root/deploy" \
  --exclude="$role/*.env" --exclude="$role/data*" --exclude="$role/config*" --exclude="$role/secrets*" \
  -cf - "$role" | ssh $ssh_opts "$host" 'mkdir -p blindbook/deploy && tar -C blindbook/deploy -xf -'
echo "shipped: ~/blindbook/deploy/$role on $host"
