# Signature des paquets — GPG, APK, updater

Trois chaînes de confiance indépendantes protègent une release de Lavande. Elles ne se remplacent pas :
chacune couvre un artefact différent et un vérificateur différent.

| Artefact | Signé par | Clé | Vérifié par |
| --- | --- | --- | --- |
| `.rpm` | `rpmsign` (GPG) | GPG de release (`LAVANDE_GPG_KEY_ID`) | `rpm -K`, après `rpm --import` |
| `.AppImage`, `.AppImage.tar.gz` | `gpg --detach-sign` | GPG de release (la même) | `gpg --verify` |
| `latest.json` + paquets de l'updater | minisign (`tauri signer sign`) | `.tauri/lavande-updater.key` | `tauri-plugin-updater`, dans l'app |
| `Lavande.apk` | `apksigner` | `~/.android/lavande-release.jks` | Android, à l'installation |

La chaîne **updater** (minisign) est décrite dans [`UPDATER.md`](./UPDATER.md) ; celle de l'**APK** dans
[`android.md`](./android.md). Ce document couvre la clé **GPG** (RPM + AppImage) et la sauvegarde de
l'ensemble.

> ### À sauvegarder hors ligne
>
> Quatre secrets, tous irremplaçables. Perdre l'un d'eux casse quelque chose que **seule** une
> réinstallation complète répare :
>
> | Secret | Chemin sur le poste | Perdu → |
> | --- | --- | --- |
> | Clé GPG de release (privée) | trousseau `$LAVANDE_GPG_HOME` (`~/.gnupg`) | paquets suivants signés par une autre clé : les postes qui ont importé l'ancienne refusent la mise à jour RPM ; il faut réimporter la nouvelle clé à la main sur chaque poste |
> | Certificat de révocation GPG | `~/.gnupg/openpgp-revocs.d/<empreinte>.rev` | impossible de révoquer la clé compromise |
> | Clé privée de l'updater | `.tauri/lavande-updater.key` | chaîne de mise à jour cassée : réinstallateur complet à republier |
> | Keystore APK + son mot de passe | `~/.android/lavande-release.jks` | plus aucune mise à jour Android : désinstallation obligatoire (données locales perdues) |
>
> Sauvegarde **chiffrée** (gestionnaire de secrets, archive chiffrée sur support hors ligne, jamais dans
> le dépôt, jamais dans un cloud non chiffré). Vérifier qu'une restauration fonctionne : une sauvegarde
> jamais relue n'est pas une sauvegarde.

## Clé GPG de release

Une seule clé signe le RPM et l'AppImage. Elle doit être **RSA** : `rpm` ne vérifie de façon fiable que les
signatures RSA (une clé ed25519 produit une signature que les postes cibles ignorent, et
`scripts/sign-artifacts.sh` le signale).

### Créer la clé

```bash
gpg --quick-generate-key "Lavande Release <release@lavande.lanro.eu>" rsa4096 sign 3y
export LAVANDE_GPG_KEY_ID="$(gpg --list-secret-keys --with-colons release@lavande.lanro.eu \
  | awk -F: '/^fpr:/{print $10; exit}')"
echo "$LAVANDE_GPG_KEY_ID"
gpg --armor --export "$LAVANDE_GPG_KEY_ID" > lavande-release.asc
```

- L'empreinte (`LAVANDE_GPG_KEY_ID`) est l'identifiant à exporter dans l'environnement ; un uid marche
  aussi, mais une empreinte ne désigne qu'une clé.
- `3y` : l'expiration ne périme pas les signatures déjà posées, elle empêche seulement d'en produire de
  nouvelles. Prolonger avec `gpg --quick-set-expire <empreinte> 3y` — la clé publique republiée garde la
  même empreinte, donc rien à réimporter chez les utilisateurs.
- Phrase secrète : `gpg-agent` la demande une fois (mode graphique ou terminal). Sur une machine sans
  terminal interactif, un fichier `0600` :

  ```bash
  install -m 600 /dev/null ~/.config/lavande/gpg-passphrase
  # écrire la phrase secrète dedans, puis :
  export LAVANDE_GPG_PASSPHRASE_FILE=~/.config/lavande/gpg-passphrase
  ```

  Le fichier n'est jamais passé en argument de commande (`ps` est lisible), seulement par
  `--passphrase-file` / `%_gpg_options`.

### Publier la clé publique

`lavande-release.asc` va **à côté des paquets** sur le dossier public des releases, et son empreinte est
annoncée (README, page de téléchargement). Côté utilisateur :

```bash
gpg --import lavande-release.asc
```

Sur un poste RPM, l'import se fait dans la base `rpm`, sinon `rpm -K` répond `NOKEY` :

```bash
sudo rpm --import lavande-release.asc
```

## Signer un RPM

Le RPM se construit dans le conteneur `lavande-rpm-builder` ([`UPDATER.md`](./UPDATER.md)), puis se signe
**sur l'hôte** : les clés privées ne doivent pas entrer dans un conteneur, et `rpmsign` ne demande que le
paquet `rpm` (quelques Mo, sans effet sur la chaîne de build).

```bash
sudo apt install rpm          # rpmsign, rpm -K
export LAVANDE_GPG_KEY_ID=<empreinte>
bash scripts/sign-artifacts.sh artifacts/rpm/*.rpm
# alias : npm run sign:artifacts -- artifacts/rpm/*.rpm
```

Le script lance, pour chaque paquet :

```bash
rpmsign --addsign \
  --define "_gpg_name $LAVANDE_GPG_KEY_ID" \
  --define "_gpg_path $GNUPGHOME" \
  Lavande-0.1.0-1.x86_64.rpm
```

`%_gpg_name` est le nom que `rpm` passe à `gpg` : une empreinte, pas un chemin de clé. `--addsign`
**remplace** une signature existante, donc resigner un paquet déjà signé est sans effet de bord.

Garde-fous du script :

| Situation | Comportement |
| --- | --- |
| `LAVANDE_GPG_KEY_ID` absent ou vide | échec (`exit 1`), aucun paquet touché — pas de signature silencieuse |
| clé secrète absente du trousseau `$LAVANDE_GPG_HOME` | échec, message pointant vers ce document |
| clé non RSA | avertissement explicite : la signature risque d'être ignorée par `rpm` |
| clé publique absente de la base `rpm` locale | avertissement `NOKEY` (la signature est posée, seule la vérification locale est impossible) |
| `rpmsign` absent | échec avec la commande d'installation |

Vérifier :

```bash
rpm -K Lavande-0.1.0-1.x86_64.rpm      # → Lavande-0.1.0-1.x86_64.rpm: digests signatures OK
rpm -qpi Lavande-0.1.0-1.x86_64.rpm | grep -i signature
```

La signature est **dans** le paquet : elle survit à la copie, au dépôt HTTP et à `dnf`/`zypper`. Un dépôt
RPM servi aux utilisateurs doit la vérifier :

```ini
[lavande]
name=Lavande
baseurl=https://lavande.lanro.eu/rpm/
enabled=1
gpgcheck=1
repo_gpgcheck=0
gpgkey=https://lavande.lanro.eu/rpm/lavande-release.asc
```

## Signer une AppImage

Ce qui est publié pour l'updater est le `.tar.gz` (format attendu par `tauri-plugin-updater`), pas
l'AppImage brute : c'est donc **le `.tar.gz` qui reçoit la signature détachée**, pour que l'utilisateur
vérifie exactement les octets qu'il télécharge.

```bash
export LAVANDE_GPG_KEY_ID=<empreinte>
bash scripts/sign-artifacts.sh artifacts/updater/Lavande_0.1.0_amd64.AppImage.tar.gz
# → Lavande_0.1.0_amd64.AppImage.tar.gz.asc
```

Vérifier :

```bash
gpg --verify Lavande_0.1.0_amd64.AppImage.tar.gz.asc Lavande_0.1.0_amd64.AppImage.tar.gz
```

Le script accepte aussi l'AppImage elle-même (`*.AppImage`) : la signature détachée `<fichier>.asc` est
alors posée à côté, ce qui couvre une distribution manuelle du fichier.

### Signature embarquée (optionnelle, AppImageUpdate)

`appimagetool --sign` inscrit la signature **dans** l'AppImage, seul format que lit `AppImageUpdate`
(zsync). L'updater Tauri l'ignore : par défaut, `scripts/sign-artifacts.sh` ne l'active donc pas. Pour la
poser :

```bash
LAVANDE_APPIMAGE_EMBED=1 \
LAVANDE_APPIMAGE_UPDATE_INFO='gh-releases-zsync|Roman|lavande|latest|Lavande-*.AppImage.zsync' \
bash scripts/sign-artifacts.sh src-tauri/target/release/bundle/appimage/*.AppImage
```

Le script extrait l'AppImage (`--appimage-extract`) puis la reconstruit avec
`appimagetool --no-appstream --sign --sign-key "$LAVANDE_GPG_KEY_ID" --updateinformation "$LAVANDE_APPIMAGE_UPDATE_INFO"`.
Trois conséquences, à assumer :

- `appimagetool` doit être présent dans le `PATH` (le bundler le télécharge pour construire l'AppImage) ;
- la reconstruction réécrit le fichier : `--updateinformation` est obligatoire, sinon le zsync de
  `AppImageUpdate` disparaît silencieusement ;
- à faire **avant** la mise en `.tar.gz` et la signature minisign, sinon les octets couverts changent.

## Intégration au processus de release

Ordre imposé : **GPG d'abord, minisign ensuite**. `rpmsign` réécrit le paquet ; une signature minisign
posée avant porterait sur d'autres octets et l'installation échouerait (le plugin vérifie la signature du
fichier téléchargé).

`scripts/release-updater.mjs` applique cet ordre lui-même : il copie les paquets dans `artifacts/updater`,
appelle `scripts/sign-artifacts.sh` si `LAVANDE_GPG_KEY_ID` est défini, puis signe avec minisign.

```bash
export LAVANDE_GPG_KEY_ID=<empreinte>
# RPM construit par le conteneur : le remettre là où release-updater le cherche
cp artifacts/rpm/*.rpm src-tauri/target/release/bundle/rpm/
npm run release:updater -- --require-gpg --notes "Correctifs de synchronisation"
```

| Sans `LAVANDE_GPG_KEY_ID` | Effet |
| --- | --- |
| `node scripts/release-updater.mjs` | avertissement bruyant : RPM et AppImage publiés **sans** signature GPG (seule la signature minisign les couvre) |
| `… --require-gpg` | échec : aucune release non signée ne part par inadvertance |

Le manifeste et les paquets se déposent ensuite ensemble sur l'endpoint : `latest.json`, `.rpm`, `.tar.gz`,
leurs `.sig` (minisign), le `.asc` du `.tar.gz` (et de l'AppImage brute si elle est publiée), plus
`lavande-release.asc` (clé publique). Le `.rpm` n'a pas de `.asc` : sa signature est dans le paquet.

## Vérifier une release (côté utilisateur)

```bash
# 1. clé publique
gpg --import lavande-release.asc

# 2. AppImage
gpg --verify Lavande_0.1.0_amd64.AppImage.tar.gz.asc Lavande_0.1.0_amd64.AppImage.tar.gz
tar -xzf Lavande_0.1.0_amd64.AppImage.tar.gz
chmod +x Lavande_0.1.0_amd64.AppImage

# 3. RPM (la signature est dans le paquet)
sudo rpm --import lavande-release.asc
rpm -K Lavande-0.1.0-1.x86_64.rpm
sudo rpm -U Lavande-0.1.0-1.x86_64.rpm
```

La vérification de la clé elle-même (empreinte annoncée dans le README, hors du serveur de paquets) est ce
qui empêche un serveur compromis de publier sa propre clé : l'empreinte doit être publiée ailleurs que sur
`lavande.lanro.eu`.

## Sauvegarder et restaurer

### Exporter la clé GPG

```bash
gpg --export-secret-keys --armor "$LAVANDE_GPG_KEY_ID" > lavande-release.sec.asc
gpg --symmetric --cipher-algo AES256 lavande-release.sec.asc   # → lavande-release.sec.asc.gpg
shred -u lavande-release.sec.asc
```

Copier sur un support hors ligne, avec :

- `lavande-release.sec.asc.gpg` (clé privée, chiffrée) et sa phrase de chiffrement ;
- `lavande-release.asc` (clé publique, pour comparaison après restauration) ;
- `~/.gnupg/openpgp-revocs.d/<empreinte>.rev` (certificat de révocation).

### Restaurer

```bash
export GNUPGHOME=~/.gnupg
gpg --import lavande-release.sec.asc.gpg      # clé chiffrée symétriquement : gpg demande la phrase
gpg --import lavande-release.asc
gpg --list-secret-keys --with-colons | awk -F: '/^fpr:/{print $10; exit}'   # empreinte attendue
```

L'empreinte restaurée doit être **identique** à l'annoncée : sinon c'est une autre clé, et tous les postes
qui ont importé l'ancienne refuseront les mises à jour RPM.

### Révoquer (compromission)

```bash
# le certificat fourni par gpg est neutralisé par un « : » en tête de bloc :
sed 's/^://' ~/.gnupg/openpgp-revocs.d/<empreinte>.rev > revoke.asc
gpg --import revoke.asc                        # applique la révocation à la clé locale
gpg --armor --export <empreinte> > lavande-release-revoquee.asc   # à publier
```

Publier `lavande-release-revoquee.asc` là où la clé publique est distribuée, puis créer une nouvelle clé :
la révocation n'invalide pas les paquets déjà installés, elle empêche seulement d'en signer de nouveaux
avec l'ancienne.

## Limites connues

- **Pas de signature côté CI** : tout se signe sur le poste de l'auteur, avec les clés du trousseau. Aucune
  clé n'est présente dans le dépôt ni dans un runner.
- **La signature GPG n'authentifie pas l'endpoint** : un manifeste `latest.json` falsifié est arrêté par la
  signature minisign et `requireSignedVersion`, pas par GPG — GPG ne couvre que le téléchargement manuel.
- **RPM signé ≠ RPM installable partout** : les postes qui n'ont pas importé `lavande-release.asc`
  refusent le paquet si leur politique `gpgcheck` est stricte ; c'est le comportement voulu.
- **Pas de zsync/AppImageUpdate** : la signature embarquée n'a d'intérêt qu'une fois `AppImageUpdate`
  distribué ; aujourd'hui l'AppImage se met à jour via l'updater Tauri (minisign).
- **Une clé par usage** : ne pas signer le RPM et l'APK avec la même clé — l'APK exige un keystore Java,
  et le séparer limite les dégâts d'une compromission.
