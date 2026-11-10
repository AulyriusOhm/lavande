#!/usr/bin/env bash
# Entrée dev TLS : https://dev.int.lanro.eu:8443
#   /            -> portail listant les projets (deploy/www)
#   /lavande/    -> dev server Vite de Lavande (127.0.0.1:1420)
# Certificat wildcard *.int.lanro.eu déjà présent (/etc/nihyl-tls), monté par le daemon
# docker donc lisible malgré root:root 640 — aucun sudo requis.
set -eu

NAME=dev-proxy
PORT="${1:-8443}"
HERE="$(cd "$(dirname "$0")" && pwd)"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --network host \
  --restart unless-stopped \
  -v "$HERE/nginx:/etc/nginx/conf.d:ro" \
  -v "$HERE/www:/srv:ro" \
  -v /etc/nihyl-tls:/certs:ro \
  nginx:alpine

sleep 2
docker exec "$NAME" nginx -t 2>&1 | tail -1
