#!/bin/sh
# Build the Caddy config from BB_SITES ("host=upstream ...", one API per network) and run it.
set -eu
: "${BB_SITES:?set BB_SITES in api.env, e.g. api.example.org=api:8080}"
routes=""
for site in $BB_SITES; do
  host="${site%%=*}"
  upstream="${site#*=}"
  route=$(sed -e "s/__HOST__/${host}/g" -e "s/__UPSTREAM__/${upstream}/g" /etc/caddy/caddy-site.json.tmpl)
  routes="${routes:+$routes,}$route"
done
printf '%s' "$routes" > /tmp/routes.json
awk 'FNR==NR { r = r $0 "\n"; next } { sub(/__ROUTES__/, r) } 1' /tmp/routes.json /etc/caddy/caddy.json.tmpl > /tmp/caddy.json
exec caddy run --config /tmp/caddy.json
