#!/usr/bin/env bash
# Release locale de Lavande : build des paquets Linux + APK, signatures, staging.
# Le déploiement web est fait ensuite par l'agent (skill lavande-release).
#
#   bash scripts/release.sh                                  # reconstruit la version courante
#   bash scripts/release.sh 0.2.4 --notes "…"                # bump + build
set -euo pipefail
cd "$(dirname "$0")/.."

GPG_KEY_ID=AA96E189D4444573BE20965894AFC143FFA18D0C
RPM_TOOLS="$HOME/.local/bin"
UPDATER_DIR=artifacts/updater
STAGING_DIR=artifacts/staging

die() {
  echo "release : $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage : bash scripts/release.sh [VERSION] [--notes "texte"]

  VERSION        version à publier ; bumpée dans package.json, package-lock.json,
                 src-tauri/tauri.conf.json et site-vitrine/index.html.
                 Sans argument : reconstruit la version courante.
  --notes texte  notes de version (défaut : dernier commit git)
EOF
}

VERSION=""
NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes)
      [ $# -ge 2 ] || die "--notes attend un texte"
      NOTES="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "option inconnue : $1 (voir --help)"
      ;;
    *)
      [ -z "$VERSION" ] || die "version donnée deux fois : $1"
      VERSION="$1"
      shift
      ;;
  esac
done

export PATH="$RPM_TOOLS:$PATH"
export LAVANDE_GPG_KEY_ID="$GPG_KEY_ID"

echo "== étape 0 : prérequis"
command -v docker >/dev/null 2>&1 || die "docker introuvable dans le PATH"
docker image inspect lavande-rpm-builder:latest >/dev/null 2>&1 ||
  die "image docker lavande-rpm-builder:latest absente"
command -v node >/dev/null 2>&1 || die "node introuvable"
command -v python3 >/dev/null 2>&1 || die "python3 introuvable"
command -v rpmsign >/dev/null 2>&1 ||
  die "rpmsign introuvable : les wrappers doivent être dans $RPM_TOOLS (docs/SIGNING.md)"
gpg --batch --list-keys "$GPG_KEY_ID" >/dev/null 2>&1 ||
  die "clé GPG de release $GPG_KEY_ID absente du trousseau"
[ -f .tauri/lavande-updater.key ] ||
  die "clé minisign .tauri/lavande-updater.key absente"
[ -f "$HOME/.android/lavande-release.jks" ] ||
  die "keystore Android $HOME/.android/lavande-release.jks absent"
[ -f "$HOME/.android/lavande-keystore.pass" ] ||
  die "mot de passe du keystore Android absent : $HOME/.android/lavande-keystore.pass"

echo "== étape 1 : version"
OLD_VERSION="$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
[ -n "$OLD_VERSION" ] || die "version absente de src-tauri/tauri.conf.json"
VERSION="${VERSION:-$OLD_VERSION}"

if [ "$VERSION" != "$OLD_VERSION" ]; then
  echo "   bump $OLD_VERSION → $VERSION"
  python3 - "$VERSION" <<'PY'
import json
import sys

version = sys.argv[1]
for path in ("package.json", "package-lock.json"):
    with open(path) as handle:
        data = json.load(handle)
    data["version"] = version
    if "" in data.get("packages", {}):
        data["packages"][""]["version"] = version
    with open(path, "w") as handle:
        handle.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY
  old_pattern="${OLD_VERSION//./\\.}"
  sed -i "s/$old_pattern/$VERSION/g" site-vitrine/index.html
  grep -q "$VERSION" site-vitrine/index.html ||
    die "site-vitrine/index.html : $VERSION absent après remplacement de $OLD_VERSION"
fi
echo "   version publiée : $VERSION"

echo "== étape 2 : démon et client (cargo build --release --workspace)"
cargo build --release --workspace

echo "== étape 3 : paquets de bureau (rpm, deb, appimage) dans lavande-rpm-builder"
mkdir -p artifacts/rpm artifacts/deb artifacts/appimage
docker run --rm -v "$PWD":/src:ro -v "$PWD/artifacts/rpm":/out/rpm -v "$PWD/artifacts/deb":/out/deb -v "$PWD/artifacts/appimage":/out/appimage -v "$HOME/.cargo/registry":/root/.cargo/registry -w /work lavande-rpm-builder:latest bash -lc 'set -e; mkdir -p /work /out/rpm /out/deb /out/appimage; cd /work; cp -a /src/package.json /src/package-lock.json /src/index.html /src/tsconfig.json /src/vite.config.ts /src/vitest.config.ts /src/Cargo.toml /src/Cargo.lock /src/app-icon.svg /src/.env.production /work/; tar -C /src --exclude=target --exclude=gen --exclude=node_modules -cf - src src-tauri crates | tar -xf - -C /work; npm ci --no-audit --no-fund >/dev/null 2>&1; npx tauri build --bundles rpm,deb,appimage; cp src-tauri/target/release/bundle/rpm/*.rpm /out/rpm/; cp src-tauri/target/release/bundle/deb/*.deb /out/deb/; cp src-tauri/target/release/bundle/appimage/*.AppImage /out/appimage/; chown -R $(stat -c %u /src/package.json):$(stat -c %g /src/package.json) /out; ls -la /out/rpm /out/deb /out/appimage'

echo "== étape 4 : APK Android (artifacts/apk/Lavande.apk)"
bash -lc 'source scripts/android-env.sh && export LAVANDE_KEYSTORE_PASSWORD="$(cat "$HOME/.android/lavande-keystore.pass")" && bash scripts/build-android-release.sh'
[ -f artifacts/apk/Lavande.apk ] || die "artifacts/apk/Lavande.apk absent après le build Android"

echo "== étape 5 : paquets $VERSION dans le bundle lu par release-updater.mjs"
# release-updater.mjs cherche dans src-tauri/target/release/bundle/ : on y laisse la
# version courante et on archive les anciennes pour qu'il n'y ait aucun doute.
for target in rpm deb appimage; do
  mkdir -p "artifacts/release-build/$target"
  find "src-tauri/target/release/bundle/$target" -maxdepth 1 -type f ! -name "*$VERSION*" \
    -exec mv -t "artifacts/release-build/$target/" {} +
  shopt -s nullglob
  packages=(artifacts/"$target"/*"$VERSION"*)
  shopt -u nullglob
  [ ${#packages[@]} -gt 0 ] || die "aucun paquet $VERSION dans artifacts/$target"
  cp "${packages[@]}" "src-tauri/target/release/bundle/$target/"
done

echo "== étape 6 : manifeste et signatures (release-updater.mjs)"
if [ -n "$NOTES" ]; then
  node scripts/release-updater.mjs --notes "$NOTES"
else
  node scripts/release-updater.mjs
fi

echo "== étape 7 : vérification locale des signatures"
shopt -s nullglob
deb_signatures=(artifacts/updater/*"$VERSION"*.deb.asc)
appimage_signatures=(artifacts/updater/*"$VERSION"*.AppImage.tar.gz.asc)
rpm_packages=(artifacts/updater/*"$VERSION"*.rpm)
shopt -u nullglob
[ ${#deb_signatures[@]} -gt 0 ] || die "aucune signature .deb.asc pour $VERSION dans $UPDATER_DIR"
[ ${#appimage_signatures[@]} -gt 0 ] || die "aucune signature .AppImage.tar.gz.asc pour $VERSION dans $UPDATER_DIR"
[ ${#rpm_packages[@]} -eq 1 ] || die "attendu un RPM $VERSION dans $UPDATER_DIR"
for signature in "${deb_signatures[@]}" "${appimage_signatures[@]}"; do
  gpg --batch --verify "$signature"
done
# rpm -K de l'hôte n'est pas fiable (wrappers partiels) : vérification dans le conteneur.
public_key="$(mktemp)"
gpg --batch --yes --armor --export "$LAVANDE_GPG_KEY_ID" >"$public_key"
docker run --rm -v "$PWD/$UPDATER_DIR":/up:ro -v "$public_key":/key.asc:ro lavande-rpm-builder:latest \
  bash -lc 'set -e; rpm --import /key.asc; rpm -K /up/*'"$VERSION"'*.rpm'
rm -f "$public_key"

echo "== étape 8 : staging public ($STAGING_DIR)"
mkdir -p "$STAGING_DIR"
cp artifacts/updater/latest.json artifacts/updater/*"$VERSION"* "$STAGING_DIR/"
cp artifacts/apk/Lavande.apk "$STAGING_DIR/"
tar -czf "$STAGING_DIR/vitrine.tar.gz" -C site-vitrine .
gpg --batch --yes --armor --export "$LAVANDE_GPG_KEY_ID" >"$STAGING_DIR/lavande-release.asc"

echo "== étape 9 : récapitulatif"
echo "Lavande $VERSION prête (notes : ${NOTES:-dernier commit git})"
ls -la "$STAGING_DIR"
sha256sum "$STAGING_DIR"/*
cat <<EOF

Étapes suivantes (déploiement, par l'agent — rien n'est publié à ce stade) :
  1. servir le staging : cd $STAGING_DIR && python3 -m http.server 8091 --bind 0.0.0.0
  2. copier packages + latest.json + vitrine.tar.gz sur le serveur web via Nihyl
     (/usr/share/nginx/html et /usr/share/nginx/html/updates)
  3. vérifier https://lavande.lanro.eu/updates/latest.json et les SHA256 publics
  4. arrêter le serveur staging, commit « chore: release $VERSION », tag v$VERSION, push
EOF
