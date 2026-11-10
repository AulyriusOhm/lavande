#!/usr/bin/env bash
# Maquette servie par le portail : Vite tourne dans un conteneur détaché pour
# survivre à la session et redémarrer au boot, comme le proxy nginx.
#
#   scripts/dev-web.sh start|stop|restart|logs|status
#
# Le portail sert l'app sous /lavande/ : Vite doit donc tourner avec
# VITE_BASE=/lavande/ (`npm run dev:portal`), sinon la page reste blanche.
set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly NAME="lavande-web"
readonly IMAGE="node:22-bookworm-slim"
readonly PORT=1420
readonly URL="http://127.0.0.1:${PORT}/lavande/"

running() {
    [[ "$(docker inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null)" == "true" ]]
}

start() {
    if running; then
        echo "$NAME tourne déjà"
        return 0
    fi
    if [[ ! -d "$ROOT/node_modules" ]]; then
        echo "node_modules manquant, lance d'abord : npm ci" >&2
        return 1
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --network host --restart unless-stopped \
        -v "$ROOT:/app" -w /app \
        -e VITE_BASE=/lavande/ \
        "$IMAGE" npm run dev >/dev/null
    for _ in $(seq 1 100); do
        if curl -fsS --max-time 1 "$URL" >/dev/null 2>&1; then
            echo "maquette : $URL (conteneur $NAME)"
            return 0
        fi
        sleep 0.3
    done
    echo "le serveur web n'a pas répondu" >&2
    docker logs --tail 30 "$NAME" >&2 || true
    return 1
}

stop() {
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "maquette arrêtée" || echo "maquette déjà arrêtée"
}

status() {
    if running; then
        echo "maquette lancée ($URL)"
    else
        echo "maquette arrêtée"
    fi
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop; start ;;
    logs) docker logs --tail "${2:-50}" "$NAME" ;;
    status) status ;;
    *) echo "usage: $(basename "$0") start|stop|restart|logs|status" >&2; exit 2 ;;
esac
