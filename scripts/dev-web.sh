#!/usr/bin/env bash
# Serveur web de la maquette (Vite, base /lavande/) : c'est ce que sert le
# portail https://…:8443/lavande/. Détaché, avec un fichier de PID.
#
#   scripts/dev-web.sh start|stop|restart|status
#
# Le portail sert l'app sous /lavande/ : le serveur doit donc tourner avec
# VITE_BASE=/lavande/ (`npm run dev:portal`), sinon la page reste blanche.
set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly CACHE="$HOME/.cache/lavande"
readonly LOG="$CACHE/web.log"
readonly PID_FILE="$CACHE/web.pid"
readonly URL="http://127.0.0.1:1420/lavande/"

running_pid() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid="$(cat "$PID_FILE")"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

start() {
    if running_pid >/dev/null; then
        echo "web déjà lancé (pid $(running_pid))"
        return 0
    fi
    mkdir -p "$CACHE"
    (cd "$ROOT" && setsid nohup npm run dev:portal >"$LOG" 2>&1 </dev/null & echo $! >"$PID_FILE")
    for _ in $(seq 1 100); do
        if curl -fsS --max-time 1 "$URL" >/dev/null 2>&1; then
            echo "web écoute sur $URL (log : $LOG)"
            return 0
        fi
        sleep 0.2
    done
    echo "le serveur web n'a pas répondu, voir $LOG" >&2
    tail -n 20 "$LOG" >&2 || true
    return 1
}

stop() {
    local pid
    if pid="$(running_pid)"; then
        kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 -- "-$pid" 2>/dev/null || true
        echo "web arrêté"
    else
        echo "web ne tourne pas"
    fi
    rm -f "$PID_FILE"
}

status() {
    if pid="$(running_pid)"; then
        echo "web lancé (pid $pid, $URL)"
    else
        echo "web arrêté"
    fi
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop && start ;;
    status) status ;;
    *) echo "usage: $(basename "$0") start|stop|restart|status" >&2; exit 2 ;;
esac
