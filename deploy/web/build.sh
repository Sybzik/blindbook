#!/bin/sh
# Build the app twice from one commit: for the static host (every request through the mixnet)
# and for the .onion mirror (plain requests to its own origin, carried by Tor). Both pin the
# deployment's own M and seal key; the build refuses to run without them.
#
#   BB_API_ORIGIN=https://api.example.org BB_APP_ORIGIN=https://example.org BB_M=02… BB_SEAL_PK=… \
#     [BB_NETWORK=testnet] [BB_IPR=…] sh deploy/web/build.sh
#
# BB_APP_ORIGIN: every origin the static host serves the app from (space-separated, e.g. also
# https://www.example.org). The tunnel frames' CSP names them, which Safari needs to start the
# mixnet worker.
#
# Output: deploy/web/site (upload to the static host) and deploy/api/onion-site (served by Caddy
# for the onion). Each has SHA256SUMS; publish the static host's next to the release.
set -eu
: "${BB_API_ORIGIN:?the API origin, https://…}"
: "${BB_APP_ORIGIN:?the origin(s) the static host serves the app from, https://…}"
: "${BB_M:?M from blindbook-signer keygen}"
: "${BB_SEAL_PK:?the seal public key from blindbook-signer init}"
BB_NETWORK="${BB_NETWORK:-testnet}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root/web"
pnpm install --frozen-lockfile

VITE_BB_MIXNET=1 VITE_BB_API="$BB_API_ORIGIN" VITE_BB_APP_ORIGIN="$BB_APP_ORIGIN" VITE_BB_M="$BB_M" VITE_BB_SEAL_PK="$BB_SEAL_PK" \
  VITE_BB_NETWORK="$BB_NETWORK" VITE_BB_IPR="${BB_IPR:-}" pnpm build
rm -rf "$root/deploy/web/site" && cp -r dist "$root/deploy/web/site"

VITE_BB_ONION=1 VITE_BB_M="$BB_M" VITE_BB_SEAL_PK="$BB_SEAL_PK" VITE_BB_NETWORK="$BB_NETWORK" pnpm build
rm -rf "$root/deploy/api/onion-site" && cp -r dist "$root/deploy/api/onion-site"

echo "static host: deploy/web/site   (SHA256SUMS inside)"
echo "onion:       deploy/api/onion-site"
