#!/usr/bin/env bash
# Construit l'APK Android de production (release, arm64, signé) dans artifacts/apk/Lavande.apk.
#
# `dist/` est la sortie du build front, que `npm run build` efface : l'APK vit donc
# dans `artifacts/`, hors de sa portée.
#
#   bash scripts/build-android-release.sh
#
# Le build release n'est pas une préférence de style : en debug, la WebView active
# l'inspecteur V8 et le code non optimisé, et l'application devient inutilisable
# sur téléphone (mesuré : passable en release, saccadée en debug).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/android-env.sh

# Verrou distribution : mode api forcé et fixtures de maquette absentes du bundle.
export VITE_DISTRIBUTION=1
# Plateforme : les modules MCP sont aliasés vers des stubs, donc absents du bundle.
export VITE_PLATFORM=android

# Signature : le mot de passe n'a pas de défaut. La clé release signe toutes les mises à jour
# d'un appareil ; un mot de passe public (l'ancien « lavande ») rendrait l'APK resignable par
# n'importe qui, y compris pour pousser une mise à jour à la place de l'auteur.
if [ -z "${LAVANDE_KEYSTORE_PASSWORD:-}" ]; then
  echo "LAVANDE_KEYSTORE_PASSWORD absent : signature release refusée (aucun mot de passe par défaut)." >&2
  echo "  export LAVANDE_KEYSTORE_PASSWORD=\"\$(openssl rand -base64 24)\"" >&2
  exit 1
fi
if [ "$LAVANDE_KEYSTORE_PASSWORD" = "lavande" ]; then
  echo "LAVANDE_KEYSTORE_PASSWORD vaut « lavande » : mot de passe public, signature release refusée." >&2
  echo "  export LAVANDE_KEYSTORE_PASSWORD=\"\$(openssl rand -base64 24)\"" >&2
  exit 1
fi
# Le secret voyage par l'environnement, jamais par argv : `ps` et l'historique du shell sont
# lisibles par les autres processus de l'utilisateur. apksigner lit `env:VAR`,
# keytool `-storepass:env VAR`.
export LAVANDE_KEYSTORE_PASSWORD

ALIAS="${LAVANDE_KEY_ALIAS:-lavande}"
KEYSTORE="$HOME/.android/lavande-release.jks"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
OUT="artifacts/apk/Lavande.apk"

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -v -keystore "$KEYSTORE" -storepass:env LAVANDE_KEYSTORE_PASSWORD \
    -keypass:env LAVANDE_KEYSTORE_PASSWORD \
    -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Lavande, O=Lavande, C=FR"
  chmod 600 "$KEYSTORE"
  cat >&2 <<EOF

  Nouveau keystore : $KEYSTORE
  Sauvegarde HORS LIGNE du .jks ET de son mot de passe, maintenant.
  Perdu, il rend toute mise à jour impossible sur les appareils déjà installés :
  Android refuse une mise à jour signée par une autre clé (il faut désinstaller).

EOF
fi

node scripts/patch-android.mjs
rm -rf src-tauri/gen/android/app/build/outputs/apk src-tauri/gen/android/app/build/intermediates/apk*
./node_modules/.bin/tauri android build --apk -t aarch64

mkdir -p artifacts/apk
rm -f artifacts/apk/*.idsig
"$BUILD_TOOLS/zipalign" -p -f 4 "$UNSIGNED" artifacts/apk/.aligned.apk
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass env:LAVANDE_KEYSTORE_PASSWORD \
  --key-pass env:LAVANDE_KEYSTORE_PASSWORD \
  --ks-key-alias "$ALIAS" --out "$OUT" artifacts/apk/.aligned.apk
rm -f artifacts/apk/.aligned.apk artifacts/apk/*.idsig
"$BUILD_TOOLS/apksigner" verify "$OUT"
ls -la "$OUT"
