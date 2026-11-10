#!/usr/bin/env bash
# Démon mail local de Lavande (lavande-maild) : bâtit le binaire puis le lance
# détaché. L'app web parle à http://127.0.0.1:8790/api (proxy Vite et nginx).
#
#   scripts/mail-service.sh start|stop|restart|status
#
# Variables (toutes optionnelles) :
#   LAVANDE_MAIL_DATA_DIR    base SQLite + accounts.json  (défaut ~/.local/share/lavande)
#   LAVANDE_MAIL_BIND        adresse d'écoute             (défaut 127.0.0.1:8790)
#   LAVANDE_MAIL_EXTRA_ROOTS PEM ajouté aux racines TLS   (ex. certificat GreenMail de test)
set -euo pipefail

readonly NAME="lavande-maild"
readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly DATA_DIR="${LAVANDE_MAIL_DATA_DIR:-$HOME/.local/share/lavande}"
readonly BIND="${LAVANDE_MAIL_BIND:-127.0.0.1:8790}"
readonly CACHE="$HOME/.cache/lavande"
readonly LOG="$CACHE/mail-service.log"
readonly PID_FILE="$CACHE/mail-service.pid"
readonly BIN="$HOME/.cache/lavande-build/target/debug/$NAME"

# Cette machine n'a pas de compilateur C système : le crate rusqlite passe par
# le wrapper zig local quand il est présent.
if [[ -x /home/roman/.local/opt/lavande-cc/cc ]]; then
    export PATH="/home/roman/.local/opt/lavande-cc:$PATH"
    export CC=/home/roman/.local/opt/lavande-cc/cc
    export CXX=/home/roman/.local/opt/lavande-cc/c++
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/lavande-build/target}"

running_pid() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid="$(cat "$PID_FILE")"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

build() {
    (cd "$ROOT" && cargo build -p lavande-mail-api)
}

start() {
    if running_pid >/dev/null; then
        echo "$NAME tourne déjà (pid $(running_pid))"
        return 0
    fi
    build
    mkdir -p "$CACHE"
    LAVANDE_MAIL_DATA_DIR="$DATA_DIR" LAVANDE_MAIL_BIND="$BIND" \
        nohup "$BIN" >"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 100); do
        if curl -fsS --max-time 1 "http://$BIND/api/health" >/dev/null 2>&1; then
            echo "$NAME écoute sur http://$BIND/api (données : $DATA_DIR, log : $LOG)"
            return 0
        fi
        sleep 0.1
    done
    echo "$NAME n'a pas répondu, voir $LOG" >&2
    tail -n 20 "$LOG" >&2 || true
    return 1
}

stop() {
    local pid
    if pid="$(running_pid)"; then
        kill "$pid"
        for _ in $(seq 1 50); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
        echo "$NAME arrêté"
    else
        echo "$NAME ne tourne pas"
    fi
    rm -f "$PID_FILE"
}

status() {
    local pid
    if pid="$(running_pid)"; then
        echo "$NAME tourne (pid $pid, http://$BIND/api)"
        curl -fsS --max-time 2 "http://$BIND/api/health" && echo
    else
        echo "$NAME est arrêté"
    fi
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop && start ;;
    status) status ;;
    *) echo "usage: $(basename "$0") start|stop|restart|status" >&2; exit 2 ;;
esac
