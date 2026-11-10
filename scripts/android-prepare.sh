#!/usr/bin/env bash
# Prépare le projet Android de Tauri : variables d'environnement locales,
# génération de `src-tauri/gen/android` si besoin, et autorisation du trafic
# en clair vers la boucle locale (le démon mail embarqué écoute en HTTP sur
# 127.0.0.1:8790 ; Android le bloque par défaut en release).
#   scripts/android-prepare.sh
set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
readonly JDK="${JAVA_HOME:-$HOME/jdk21}"
readonly NDK="${NDK_HOME:-$SDK/ndk/28.2.13676358}"
readonly GRADLE="$ROOT/src-tauri/gen/android/app/build.gradle.kts"

if [[ ! -d "$SDK" ]]; then
    echo "SDK Android introuvable ($SDK)" >&2
    exit 1
fi
if [[ ! -x "$JDK/bin/java" ]]; then
    echo "JDK introuvable ($JDK)" >&2
    exit 1
fi
if [[ ! -d "$NDK" ]]; then
    echo "NDK introuvable ($NDK)" >&2
    exit 1
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export NDK_HOME="$NDK"
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$SDK/platform-tools:$PATH"

if [[ ! -d "$ROOT/src-tauri/gen/android" ]]; then
    (cd "$ROOT" && npx tauri android init)
fi

# Tauri force usesCleartextTraffic=false en release ; l'API mail est en HTTP
# sur la boucle locale, donc on l'autorise (rien ne sort en clair de l'appareil).
if grep -q 'manifestPlaceholders\["usesCleartextTraffic"\] = "false"' "$GRADLE"; then
    sed -i 's/manifestPlaceholders\["usesCleartextTraffic"\] = "false"/manifestPlaceholders["usesCleartextTraffic"] = "true"/' "$GRADLE"
    echo "trafic local en clair autorisé dans $GRADLE"
fi

echo "prêt : SDK=$SDK JDK=$JDK NDK=$NDK"
