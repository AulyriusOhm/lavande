#!/usr/bin/env bash
# Construit et signe l'APK Android (arm64, release) puis le copie dans
# `dist/apk/`. La clé vit hors du dépôt (~/.android), la signature est faite
# avec `apksigner` : rien à modifier dans le projet Gradle généré.
#
#   scripts/android-apk.sh            # release arm64 signé
#   scripts/android-apk.sh --debug    # APK debug universel (émulateur/téléphone)
set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
readonly JDK="${JAVA_HOME:-$HOME/jdk21}"
readonly NDK="${NDK_HOME:-$SDK/ndk/28.2.13676358}"
readonly BUILD_TOOLS="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
readonly KEYSTORE="$HOME/.android/lavande-release.jks"
readonly KEYPROPS="$HOME/.android/lavande-release.properties"
readonly OUT="$ROOT/dist/apk"

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export NDK_HOME="$NDK"
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$SDK/platform-tools:$BUILD_TOOLS:$PATH"

"$ROOT/scripts/android-prepare.sh" >/dev/null

mkdir -p "$OUT"

if [[ "${1:-}" == "--debug" ]]; then
    (cd "$ROOT" && npx tauri android build --debug --apk --target aarch64)
    apk="$(find "$ROOT/src-tauri/gen/android/app/build/outputs/apk" -name '*debug*.apk' -newermt '-10 minutes' | head -1)"
    [[ -n "$apk" ]] || { echo "APK debug introuvable" >&2; exit 1; }
    cp "$apk" "$OUT/lavande-debug.apk"
    echo "APK debug : $OUT/lavande-debug.apk"
    exit 0
fi

if [[ ! -f "$KEYSTORE" ]]; then
    password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
    keytool -genkeypair -v -keystore "$KEYSTORE" -alias lavande \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass "$password" -keypass "$password" \
        -dname "CN=Lavande, O=Lavande, C=FR" >/dev/null
    umask 077
    printf 'storePassword=%s\nkeyPassword=%s\nkeyAlias=lavande\n' "$password" "$password" >"$KEYPROPS"
    echo "clé de signature créée : $KEYSTORE (mots de passe dans $KEYPROPS)"
fi

# shellcheck disable=SC1090
source "$KEYPROPS"

(cd "$ROOT" && npx tauri android build --apk --target aarch64)

unsigned="$(find "$ROOT/src-tauri/gen/android/app/build/outputs/apk" -path '*release*' -name '*.apk' | head -1)"
[[ -n "$unsigned" ]] || { echo "APK release introuvable" >&2; exit 1; }

readonly version="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"
aligned="$OUT/lavande-$version-arm64-aligned.apk"
signed="$OUT/lavande-$version-arm64.apk"

zipalign -p -f 4 "$unsigned" "$aligned"
apksigner sign --ks "$KEYSTORE" --ks-key-alias lavande \
    --ks-pass "pass:$storePassword" --key-pass "pass:$keyPassword" \
    --out "$signed" "$aligned"
rm -f "$aligned"
apksigner verify --print-certs "$signed" | head -4

echo "APK signé : $signed ($(du -h "$signed" | cut -f1))"
