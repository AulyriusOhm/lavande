#!/usr/bin/env bash
# Construit l'APK Android de production (release, arm64, signé) dans dist/android/Lavande.apk.
#
#   bash scripts/build-android-release.sh
#
# Le build release n'est pas une préférence de style : en debug, la WebView active
# l'inspecteur V8 et le code non optimisé, et l'application devient inutilisable
# sur téléphone (mesuré : passable en release, saccadée en debug).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/android-env.sh

ALIAS="${LAVANDE_KEY_ALIAS:-lavande}"
PASSWORD="${LAVANDE_KEYSTORE_PASSWORD:-lavande}"
KEYSTORE="$HOME/.android/lavande-release.jks"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
OUT="dist/android/Lavande.apk"

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -v -keystore "$KEYSTORE" -storepass "$PASSWORD" -keypass "$PASSWORD" \
    -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Lavande, O=Lavande, C=FR"
fi

node scripts/patch-android.mjs
rm -rf src-tauri/gen/android/app/build/outputs/apk src-tauri/gen/android/app/build/intermediates/apk*
./node_modules/.bin/tauri android build --apk -t aarch64

mkdir -p dist/android
rm -f dist/android/*.idsig
"$BUILD_TOOLS/zipalign" -p -f 4 "$UNSIGNED" dist/android/.aligned.apk
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$PASSWORD" --key-pass "pass:$PASSWORD" \
  --ks-key-alias "$ALIAS" --out "$OUT" dist/android/.aligned.apk
rm -f dist/android/.aligned.apk dist/android/*.idsig
"$BUILD_TOOLS/apksigner" verify "$OUT"
ls -la "$OUT"
