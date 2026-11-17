#!/usr/bin/env bash
# Throw-away GreenMail server for the live IMAP/SMTP tests.
set -euo pipefail

readonly CONTAINER="lavande-mail-test"
readonly IMAGE="greenmail/standalone:latest"
readonly DIR="${LAVANDE_MAIL_TEST_DIR:-$HOME/.cache/lavande/mail-test}"

readonly SMTP_PORT="${LAVANDE_MAIL_TEST_SMTP_PORT:-3025}"
readonly IMAP_PORT="${LAVANDE_MAIL_TEST_IMAP_PORT:-3143}"
readonly IMAPS_PORT="${LAVANDE_MAIL_TEST_IMAPS_PORT:-3993}"
readonly SMTPS_PORT="${LAVANDE_MAIL_TEST_SMTPS_PORT:-3465}"

readonly MAIL_USER="${LAVANDE_MAIL_TEST_USER:-roman@lavande.test}"
readonly MAIL_PASSWORD="${LAVANDE_MAIL_TEST_PASSWORD:-secret}"
readonly MAIL_USER2="${LAVANDE_MAIL_TEST_USER2:-}"
readonly MAIL_PASSWORD2="${LAVANDE_MAIL_TEST_PASSWORD2:-secret}"
readonly KEYSTORE_PASSWORD="changeit"

# GreenMail prend les comptes en liste séparée par des virgules, chacun rattaché
# au domaine de son adresse : le second compte est optionnel.
users_option() {
    local users="${MAIL_USER}:${MAIL_PASSWORD}@localhost"
    if [[ -n "$MAIL_USER2" ]]; then
        local domain="${MAIL_USER2#*@}"
        [[ "$domain" == "$MAIL_USER2" ]] && domain="localhost"
        users="${users},${MAIL_USER2}:${MAIL_PASSWORD2}@${domain}"
    fi
    echo "-Dgreenmail.users=${users}"
}

readonly GREENMAIL_OPTS=(
    "$(users_option)"
    "-Dgreenmail.hostname=0.0.0.0"
    "-Dgreenmail.setup.test.all"
    "-Dgreenmail.tls.keystore.file=/tls/greenmail.p12"
    "-Dgreenmail.tls.keystore.password=${KEYSTORE_PASSWORD}"
    "-Dgreenmail.tls.key.password=${KEYSTORE_PASSWORD}"
)

usage() {
    echo "usage: $(basename "$0") start|stop|reset|status" >&2
    exit 2
}

container_exists() {
    docker container inspect "$CONTAINER" >/dev/null 2>&1
}

container_running() {
    [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]]
}

port_open() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

wait_for_port() {
    local port=$1 deadline=$((SECONDS + 30))
    while ((SECONDS < deadline)); do
        if port_open "$port"; then
            return 0
        fi
        sleep 0.2
    done
    echo "timed out waiting for port ${port}" >&2
    docker logs --tail 40 "$CONTAINER" >&2 || true
    return 1
}

wait_for_tls() {
    local port=$1 deadline=$((SECONDS + 30))
    while ((SECONDS < deadline)); do
        if openssl s_client -connect "127.0.0.1:${port}" -servername localhost \
            -CAfile "$DIR/cert.pem" -verify_return_error -brief </dev/null 2>&1 \
            | grep -q "Peer certificate"; then
            return 0
        fi
        sleep 0.2
    done
    echo "timed out waiting for TLS on port ${port}" >&2
    docker logs --tail 40 "$CONTAINER" >&2 || true
    return 1
}

tls_material() {
    local dir=$1
    if [[ -f "$dir/cert.pem" && -f "$dir/key.pem" && -f "$dir/greenmail.p12" ]]; then
        return 0
    fi
    mkdir -p "$dir"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj "/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
        -addext "basicConstraints=critical,CA:FALSE" \
        -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
        -addext "extendedKeyUsage=serverAuth" \
        -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
    openssl pkcs12 -export -in "$dir/cert.pem" -inkey "$dir/key.pem" \
        -out "$dir/greenmail.p12" -name greenmail \
        -passout "pass:${KEYSTORE_PASSWORD}" 2>/dev/null
    chmod 644 "$dir/cert.pem" "$dir/key.pem" "$dir/greenmail.p12"
}

summary() {
    cat <<EOF
greenmail ready (container ${CONTAINER}, state ${DIR})
  imap     127.0.0.1:${IMAP_PORT}   plaintext, no STARTTLS advertised
  imaps    127.0.0.1:${IMAPS_PORT}
  smtp     127.0.0.1:${SMTP_PORT}   plaintext
  smtps    127.0.0.1:${SMTPS_PORT}
  user     ${MAIL_USER}
  password ${MAIL_PASSWORD}
EOF
    if [[ -n "$MAIL_USER2" ]]; then
        printf '  user2    %s\n  password2 %s\n' "$MAIL_USER2" "$MAIL_PASSWORD2"
    fi
    cat <<EOF
  ca cert  ${DIR}/cert.pem
EOF
}

start() {
    mkdir -p "$DIR"
    tls_material "$DIR"
    if container_running; then
        echo "greenmail already running"
    else
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
        docker run --detach --name "$CONTAINER" \
            --mount "type=bind,source=${DIR},target=/tls,readonly" \
            --env "GREENMAIL_OPTS=${GREENMAIL_OPTS[*]}" \
            --publish "127.0.0.1:${SMTP_PORT}:3025" \
            --publish "127.0.0.1:${IMAP_PORT}:3143" \
            --publish "127.0.0.1:${IMAPS_PORT}:3993" \
            --publish "127.0.0.1:${SMTPS_PORT}:3465" \
            "$IMAGE" >/dev/null
    fi
    wait_for_port "$IMAP_PORT"
    wait_for_tls "$IMAPS_PORT"
    wait_for_tls "$SMTPS_PORT"
    summary
}

stop() {
    if container_exists; then
        docker rm --force "$CONTAINER" >/dev/null
        echo "greenmail stopped"
    else
        echo "greenmail not running"
    fi
}

status() {
    if container_running; then
        echo "greenmail running (container ${CONTAINER})"
        summary
    elif container_exists; then
        echo "greenmail stopped (container ${CONTAINER} still exists)"
    else
        echo "greenmail absent"
    fi
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    reset) stop && start ;;
    status) status ;;
    *) usage ;;
esac
