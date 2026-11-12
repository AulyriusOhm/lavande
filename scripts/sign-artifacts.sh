#!/usr/bin/env bash
# Signe GPG les paquets de bureau Lavande : RPM (rpmsign, signature dans le
# paquet) et AppImage (signature détachée `.asc`, plus signature embarquée en
# option).
#
#   LAVANDE_GPG_KEY_ID=… bash scripts/sign-artifacts.sh artifacts/rpm/*.rpm
#   LAVANDE_GPG_KEY_ID=… bash scripts/sign-artifacts.sh --dir artifacts/updater
#
# La clé n'a pas de défaut : sans LAVANDE_GPG_KEY_ID, le script refuse de
# continuer. Une release non signée ne doit jamais passer inaperçue.
# Procédure complète (création de la clé, publication, vérification,
# sauvegarde) : docs/SIGNING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

die() {
  echo "sign-artifacts : $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage : bash scripts/sign-artifacts.sh [--dir <dossier>]… <fichier>…

  *.rpm        rpmsign --addsign, signature dans le paquet (vérifiable : rpm -K)
  *.AppImage   signature GPG détachée <fichier>.asc
  *.tar.gz     signature GPG détachée <fichier>.asc

variables :
  LAVANDE_GPG_KEY_ID            clé de signature (empreinte ou uid) — obligatoire
  LAVANDE_GPG_HOME              trousseau GPG (défaut : ~/.gnupg)
  LAVANDE_GPG_PASSPHRASE_FILE   fichier de phrase secrète (défaut : gpg-agent)
  LAVANDE_APPIMAGE_EMBED=1      signe aussi l'AppImage en son sein (appimagetool)
  LAVANDE_APPIMAGE_UPDATE_INFO  update-information à réinsérer (exigé avec EMBED)
EOF
}

files=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --dir)
      [ $# -ge 2 ] || die "--dir attend un dossier"
      [ -d "$2" ] || die "dossier absent : $2"
      while IFS= read -r -d '' found; do files+=("$found"); done < <(
        find "$2" -maxdepth 1 -type f \
          \( -name '*.rpm' -o -name '*.AppImage' -o -name '*.tar.gz' \) -print0 | sort -z
      )
      shift 2
      ;;
    --*)
      die "option inconnue : $1 (voir --help)"
      ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done
[ ${#files[@]} -gt 0 ] || die "aucun fichier à signer (voir --help)"

KEY_ID="${LAVANDE_GPG_KEY_ID:-}"
if [ -z "$KEY_ID" ]; then
  cat >&2 <<'EOF'
sign-artifacts : LAVANDE_GPG_KEY_ID absent, signature refusée (aucune clé par défaut).
  export LAVANDE_GPG_KEY_ID=<empreinte ou uid de la clé de release>
  Création de la clé et publication de la clé publique : docs/SIGNING.md
EOF
  exit 1
fi

export GNUPGHOME="${LAVANDE_GPG_HOME:-$HOME/.gnupg}"
[ -d "$GNUPGHOME" ] || die "trousseau GPG introuvable : $GNUPGHOME"
command -v gpg >/dev/null || die "gpg absent (sudo apt install gnupg)"
gpg --batch --list-secret-keys "$KEY_ID" >/dev/null 2>&1 ||
  die "aucune clé secrète « $KEY_ID » dans $GNUPGHOME (création : docs/SIGNING.md)"

# La phrase secrète ne passe jamais par argv : gpg-agent l'a déjà, sinon un
# fichier lisible par le seul utilisateur (0600), jamais une variable exportée.
gpg_args=(--batch --yes --local-user "$KEY_ID")
if [ -n "${LAVANDE_GPG_PASSPHRASE_FILE:-}" ]; then
  [ -r "$LAVANDE_GPG_PASSPHRASE_FILE" ] ||
    die "fichier de phrase secrète illisible : $LAVANDE_GPG_PASSPHRASE_FILE"
  gpg_args+=(--pinentry-mode loopback --passphrase-file "$LAVANDE_GPG_PASSPHRASE_FILE")
fi

embed_appimage() {
  local appimage work
  appimage="$(realpath "$1")"
  command -v appimagetool >/dev/null ||
    die "LAVANDE_APPIMAGE_EMBED=1 mais appimagetool absent du PATH"
  [ -n "${LAVANDE_APPIMAGE_UPDATE_INFO:-}" ] || die \
    "LAVANDE_APPIMAGE_EMBED=1 exige LAVANDE_APPIMAGE_UPDATE_INFO (ex. gh-releases-zsync|owner|repo|latest|Lavande-*.AppImage.zsync)"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  (
    cd "$work"
    "$appimage" --appimage-extract >/dev/null
    appimagetool --no-appstream --sign --sign-key "$KEY_ID" \
      --updateinformation "$LAVANDE_APPIMAGE_UPDATE_INFO" squashfs-root "$appimage"
  )
  rm -rf "$work"
  trap - EXIT
}

signed=0
for file in "${files[@]}"; do
  [ -f "$file" ] || die "fichier absent : $file"
  case "$file" in
    *.rpm)
      command -v rpmsign >/dev/null ||
        die "rpmsign absent (paquet rpm : sudo apt install rpm)"
      # rpm ne vérifie de façon fiable que les clés RSA ; une clé ed25519
      # produirait une signature que les postes cibles ignorent.
      key_algo="$(gpg --batch --with-colons --list-secret-keys "$KEY_ID" 2>/dev/null |
        awk -F: '/^sec:/{print $4; exit}')"
      if [ "$key_algo" != "1" ]; then
        echo "sign-artifacts : la clé n'est pas RSA (algo $key_algo) : rpm peut rejeter la signature — rsa4096 attendu (docs/SIGNING.md)." >&2
      fi
      rpm_defines=(--define "_gpg_name $KEY_ID" --define "_gpg_path $GNUPGHOME")
      if [ -n "${LAVANDE_GPG_PASSPHRASE_FILE:-}" ]; then
        rpm_defines+=(
          --define "_gpg_options --batch --pinentry-mode loopback --passphrase-file $LAVANDE_GPG_PASSPHRASE_FILE"
        )
      fi
      rpmsign --addsign "${rpm_defines[@]}" "$file"
      echo "signé (rpm) : $file"
      if rpm -K "$file" 2>/dev/null | grep -q NOKEY; then
        echo "  clé publique absente de la base rpm locale (rpm --import) : signature posée, vérification locale non faite." >&2
      fi
      ;;
    *.AppImage)
      if [ "${LAVANDE_APPIMAGE_EMBED:-0}" = "1" ]; then
        embed_appimage "$file"
      fi
      gpg "${gpg_args[@]}" --armor --detach-sign --output "$file.asc" "$file"
      echo "signé (gpg) : $file.asc"
      ;;
    *.tar.gz)
      gpg "${gpg_args[@]}" --armor --detach-sign --output "$file.asc" "$file"
      echo "signé (gpg) : $file.asc"
      ;;
    *)
      die "type non signable : $file (attendu .rpm, .AppImage, .tar.gz)"
      ;;
  esac
  signed=$((signed + 1))
done

echo "sign-artifacts : $signed fichier(s) signé(s) avec $KEY_ID"
