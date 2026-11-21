#!/usr/bin/env bash
# Usage : source scripts/android-env.sh
#
# Exporte l'environnement Android/Tauri (JDK 21, SDK, NDK) pour la session
# courante. À sourcer, pas à exécuter : les variables doivent rester dans le
# shell appelant.
#
#   source scripts/android-env.sh && java -version && echo "$NDK_HOME"
#
# Si la machine n'a pas de compilateur hôte (`cc`), le script en installe un
# sans sudo : le clang 19 du NDK, avec les objets et bibliothèques libgcc
# extraits dans ~/.local/share/hostgcc. Nécessaire pour les build scripts C
# des crates (proc-macro2, libc…) qui compilent pour l'hôte.
#
# Les trois chemins sont paramétrables : `JAVA_HOME`, `ANDROID_HOME` et
# `NDK_HOME` déjà définis sont honorés, sinon repli sur ceux de cette machine.
# Le job CI `android` installe ses outils ailleurs, exporte les siens, puis
# source ce script pour le `PATH` et le `cc` hôte : un seul chemin de code.

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/share/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"

HOST_CC_DIR="$HOME/.local/share/hostgcc/bin"
HOST_CC_ROOT="$HOME/.local/share/hostgcc/root"
NDK_CLANG="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/clang"
GCC_LIBS="$HOST_CC_ROOT/usr/lib/gcc/x86_64-linux-gnu/14"

if ! command -v cc >/dev/null 2>&1 && [ -x "$NDK_CLANG" ]; then
  if [ -d "$GCC_LIBS" ]; then
    mkdir -p "$HOST_CC_DIR"
    printf '#!/bin/sh\nexec "%s" --gcc-install-dir="%s" "$@"\n' "$NDK_CLANG" "$GCC_LIBS" >"$HOST_CC_DIR/cc"
    chmod +x "$HOST_CC_DIR/cc"
    export PATH="$HOST_CC_DIR:$PATH"
  else
    echo "android-env: aucun cc hôte et $GCC_LIBS absent (voir docs/android.md)" >&2
  fi
fi

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
