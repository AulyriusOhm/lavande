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

# Jeton Bearer du démon mail : nginx l'injecte dans /lavande/api/ sans jamais
# l'exposer au navigateur. Le fichier .inc n'est pas chargé automatiquement par
# nginx (seuls les *.conf de conf.d le sont) ; portal.conf l'inclut explicitement.
# Même résolution de répertoire que le démon et le proxy Vite.
DATA_DIR="${LAVANDE_MAIL_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/lavande}"
TOKEN_FILE="$DATA_DIR/daemon-token"
TOKEN_INC="$HERE/nginx/lavande-token.inc"
if [[ -r "$TOKEN_FILE" ]]; then
    printf 'proxy_set_header Authorization "Bearer %s";\n' "$(tr -d '[:space:]' < "$TOKEN_FILE")" > "$TOKEN_INC"
else
    : > "$TOKEN_INC"
    echo "dev-proxy : $TOKEN_FILE absent — /lavande/api/ répondra 401 tant que le démon n'aura pas créé son jeton (relancez dev-proxy.sh ensuite)." >&2
fi

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
