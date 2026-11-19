# Mises à jour de l'application

Deux chaînes, un seul manifeste public et une seule clé minisign.

**Bureau** — `tauri-plugin-updater` : l'app interroge le manifeste, télécharge le
paquet correspondant à son installation, vérifie la signature minisign, installe
puis redémarre.

**Android** — le plugin est desktop-only, donc l'app fait la même chose elle-même :
elle lit `platforms.android` du manifeste, télécharge l'APK (plugin Kotlin
`lavandeupdater`), en vérifie la signature minisign **côté Rust**
(`verify_android_update`, même clé que le bureau), puis le confie à
`PackageInstaller` (confirmation système) — voir [`android.md`](./android.md#mises-à-jour-apk).

## Clés

| Quoi | Où | Versionné |
| --- | --- | --- |
| Clé privée (signe les releases) | `.tauri/lavande-updater.key` | **non** (`.gitignore` : `.tauri/*.key`) |
| Clé publique correspondante | `.tauri/lavande-updater.key.pub` | oui (référence) |
| Clé publique utilisée par l'app | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | oui |
| Clé GPG (signe le RPM et l'AppImage) | trousseau `$LAVANDE_GPG_HOME`, empreinte dans `LAVANDE_GPG_KEY_ID` | **non** — voir [`SIGNING.md`](./SIGNING.md) |

Générer une nouvelle paire (casse la chaîne de mise à jour : toutes les
installations existantes refuseront les paquets signés avec l'ancienne clé) :

```bash
npx tauri signer generate -w .tauri/lavande-updater.key --ci -f
# puis recopier le contenu de .tauri/lavande-updater.key.pub dans plugins.updater.pubkey
```

Sauvegarder la clé privée hors du dépôt (gestionnaire de secrets, sauvegarde
chiffrée). Perdue, elle oblige à republier un installeur complet.

## Endpoint

```json
"plugins": {
  "updater": {
    "pubkey": "…",
    "endpoints": ["https://lavande.lanro.eu/updates/latest.json"],
    "requireSignedVersion": true
  }
}
```

- Par défaut : `https://lavande.lanro.eu/updates/latest.json` (à héberger : un
  simple serveur statique HTTPS suffit, aucun code serveur).
- Changer d'hébergement = changer l'URL ici. Variantes possibles :
  - Gitea : `https://git.lanro.eu/Roman/lavande/releases/download/updater/latest.json`
    (tag réutilisé à chaque release, assets remplacés).
  - GitHub : `https://github.com/<owner>/lavande/releases/latest/download/latest.json`.
- HTTPS obligatoire (le plugin refuse `http://` sauf
  `dangerousInsecureTransportProtocol`).
- `requireSignedVersion` (`true`) : la version annoncée par le manifeste doit
  être celle qui a été signée — sans cela un manifeste falsifié pourrait
  associer un numéro de version récent à un ancien paquet valide.

Le même dossier public doit contenir les artefacts, puisque les URLs du
manifeste sont relatives à `--url-base` (par défaut le dossier de l'endpoint).

Quand `artifacts/apk/Lavande.apk` existe au moment de la release, le script y
ajoute `platforms.android`, signé minisign comme les paquets de bureau :

```json
"platforms": {
  "android": { "signature": "dW50cnVzdGVk…", "url": "https://lavande.lanro.eu/updates/Lavande.apk" }
}
```

Sans cet APK, la release reste valable pour le bureau : le script avertit
bruyamment et n'écrit aucune entrée `android`.

## Publier une release

1. Incrémenter la version dans `src-tauri/tauri.conf.json` (le manifeste la
   reprend) et `package.json`.
2. Construire les paquets : `npx tauri build --bundles rpm,appimage`.
   Le verrou distribution n'est pas à poser : `beforeBuildCommand` pointe sur
   `npm run build:distribution` (`VITE_DISTRIBUTION=1`), donc les fixtures de
   maquette et l'aperçu n'entrent dans aucun paquet. `node
   scripts/release-updater.mjs --build` fait le même build et exporte la variable
   explicitement ; sans `--build`, le script avertit si les binaires réutilisés
   ne l'ont pas. L'AppImage demande `linuxdeploy`/`appimagetool`, téléchargés par
   le bundler.

   Le RPM se construit dans le conteneur local `lavande-rpm-builder` (Debian bookworm,
   node 22, rust, `libwebkit2gtk-4.1-dev`, `rpm`) : dépôt monté en `/src:ro`, copié dans
   `/work`, puis `npx tauri build --bundles rpm`. Le RPM sort dans
   `src-tauri/target/release/bundle/rpm/` (dans le conteneur :
   `/work/src-tauri/target/release/bundle/rpm/`, copié vers `/out`). `.env.production`
   est copié explicitement : il porte `VITE_OAUTH_CLIENT_ID`, sans lequel le build
   conteneur perdrait l'identifiant OAuth.

```bash
mkdir -p artifacts/rpm && docker run --rm \
  -v "$PWD":/src:ro \
  -v "$PWD/artifacts/rpm":/out \
  -v "$HOME/.cargo/registry":/root/.cargo/registry \
  -w /work lavande-rpm-builder:latest bash -lc '
set -e
mkdir -p /work /out && cd /work
cp -a /src/package.json /src/package-lock.json /src/index.html /src/tsconfig.json /src/vite.config.ts /src/vitest.config.ts /src/Cargo.toml /src/Cargo.lock /src/app-icon.svg /src/.env.production /work/
tar -C /src --exclude=target --exclude=gen --exclude=node_modules -cf - src src-tauri crates | tar -xf - -C /work
npm ci --no-audit --no-fund >/dev/null 2>&1
npx tauri build --bundles rpm
cp src-tauri/target/release/bundle/rpm/*.rpm /out/
chown $(stat -c %u /src/package.json):$(stat -c %g /src/package.json) /out/*.rpm
ls -la /out/*.rpm
'
```

   Le RPM sort **non signé** ; il se signe sur l'hôte, après le conteneur — les clés
   privées n'entrent pas dans un conteneur, et `rpmsign` ne demande que le paquet
   `rpm` :

   ```bash
   sudo apt install rpm                     # rpmsign, rpm -K
   export LAVANDE_GPG_KEY_ID=<empreinte>
   bash scripts/sign-artifacts.sh artifacts/rpm/*.rpm
   cp artifacts/rpm/*.rpm src-tauri/target/release/bundle/rpm/   # là où release-updater le cherche
   ```

   Sans `LAVANDE_GPG_KEY_ID`, le script refuse de continuer (pas de signature
   silencieuse). Création de la clé, publication de la clé publique, vérification :
   [`SIGNING.md`](./SIGNING.md).

3. Générer le manifeste et signer :

```bash
export LAVANDE_GPG_KEY_ID=<empreinte>       # clé GPG de release (RPM + AppImage)
npm run release:updater -- --notes "Correctifs de synchronisation"
# ou, en une fois, build + signature :
node scripts/release-updater.mjs --build --notes "…"
# release stricte : échoue si la clé GPG est absente
npm run release:updater -- --require-gpg --notes "…"
```

Le script (`scripts/release-updater.mjs`) :

- lit la version de `src-tauri/tauri.conf.json` ;
- vérifie que `plugins.updater.pubkey` correspond bien à
  `.tauri/lavande-updater.key.pub` (sinon les mises à jour seraient rejetées) ;
- prend `src-tauri/target/release/bundle/rpm/*.rpm` et
  `src-tauri/target/release/bundle/appimage/*.AppImage`, compresse l'AppImage en
  `.AppImage.tar.gz` (format attendu par l'updater Linux) ;
- signe chaque paquet avec `tauri signer sign --app-version <version>`
  (la version signée est vérifiée à l'installation) ;
- si `LAVANDE_GPG_KEY_ID` est défini, signe d'abord le `.rpm` (`rpmsign --addsign`, via
  `scripts/sign-artifacts.sh`) et le `.AppImage.tar.gz` (`gpg --detach-sign` → `.asc`) :
  l'ordre est imposé, `rpmsign` réécrit le paquet et une signature minisign posée
  avant porterait sur d'autres octets. Sans la clé, avertissement explicite ;
  `--require-gpg` le transforme en échec (voir [`SIGNING.md`](./SIGNING.md)) ;
- écrit `artifacts/updater/latest.json` et copie les `.sig`.

4. Déposer dans le dossier public **tous** les fichiers listés par le script :
   `latest.json`, les paquets, leurs `.sig` et les `.asc` GPG. Ajouter
   `lavande-release.asc` (clé publique GPG) ; l'app compare sa version à `version` et
   télécharge l'entrée `linux-x86_64-rpm` / `linux-x86_64-appimage` / `linux-x86_64`.

Exemple de manifeste :

```json
{
  "version": "0.2.0",
  "notes": "Correctifs de synchronisation",
  "pub_date": "2026-11-11T19:30:27.057Z",
  "platforms": {
    "linux-x86_64-rpm": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6…",
      "url": "https://lavande.lanro.eu/updates/Lavande-0.2.0-1.x86_64.rpm"
    },
    "linux-x86_64-appimage": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6…",
      "url": "https://lavande.lanro.eu/updates/Lavande_0.2.0_amd64.AppImage.tar.gz"
    },
    "linux-x86_64": { "signature": "…", "url": "…/Lavande-0.2.0-1.x86_64.rpm" }
  }
}
```

## Côté application

- `src/lib/updater.ts` : états (`idle`, `checking`, `current`, `available`,
  `downloading`, `installing`, `error`, `unsupported`), `checkForUpdate`,
  `installAndRelaunch`, backend Tauri réel et hook `useUpdater`.
  Hors coquille de bureau (`isTauriShell()` faux, Android, tests) : aucun plugin
  n'est chargé, tout répond « non pris en charge ».
- Réglages → **Mise à jour** : version installée, « Vérifier les mises à jour »,
  état, barre de progression, « Installer et redémarrer ».
- Une vérification silencieuse a lieu à l'ouverture des réglages, une fois par
  session (`sessionStorage`), sans afficher d'erreur réseau.
- Permissions Tauri : `updater:default` + `process:default` dans
  `src-tauri/capabilities/default.json` ; plugins initialisés dans
  `src-tauri/src/lib.rs`.

## Limites connues

- **Installation RPM** : l'updater télécharge le `.rpm` et lance `rpm -U` via
  `pkexec` (fenêtre polkit), puis `zenity`/`kdialog` + `sudo`, puis `sudo` en
  terminal. Sans polkit ni `sudo` disponible, l'installation échoue (l'app
  affiche l'erreur, le paquet reste téléchargé en cache temporaire). Le RPM doit
  être publié avec une version supérieure et une signature RPM valide : elle est
  posée par `scripts/sign-artifacts.sh` (`docs/SIGNING.md`), et le poste cible doit
  avoir importé `lavande-release.asc` s'il applique `gpgcheck`.
- **AppImage** : mise à jour en place du fichier `.AppImage` ; c'est le format
  le plus fiable pour l'auto-update Linux.
- **Android** : pas d'auto-update Tauri, mais une chaîne dédiée (voir
  [`android.md`](./android.md#mises-à-jour-apk)) : l'installation passe par la
  confirmation système de `PackageInstaller` et exige que l'APK soit signé par la
  **même clé** que l'installation existante (`~/.android/lavande-release.jks`).
- `bundle.createUpdaterArtifacts` reste `false` : un `tauri build` sans clé
  continue de fonctionner (build RPM du conteneur inclus) ; c'est le script de
  release qui signe. Si on préfère la signature automatique du bundler, passer
  l'option à `true` **et** fournir `TAURI_SIGNING_PRIVATE_KEY` à chaque build,
  sinon le build échoue.
- Aucune limite de débit ni authentification côté serveur : le manifeste est
  public, les paquets sont signés.

### Fedora Atomic / Bazzite

- **Détection.** La commande Tauri `update_host` (`src-tauri/src/lib.rs`) renvoie
  `{ immutable, bundle }` : `immutable` est la présence de `/run/ostree-booted`
  (marqueur d'un hôte ostree), `bundle` le type de paquet compilé dans le binaire
  (`tauri::utils::platform::bundle_type()`, formaté en minuscules : `rpm`, `deb`,
  `appimage`, ou `null` hors binaire empaqueté).
- **Pourquoi `rpm -U` ne peut pas aboutir.** L'installation RPM réécrit des
  fichiers sous `/usr`, monté en lecture seule sur un hôte ostree : elle échoue
  après trois invitations polkit/sudo. Quand `immutable` est vrai **et** que
  `bundle` vaut `rpm`, `tauriUpdater()` renvoie la mise à jour avec un `install()`
  qui échoue immédiatement (`OSTREE_RPM`) sans rien télécharger ; le message
  s'affiche dans la popup de mise à jour et les deux écrans de réglages, sans UI
  supplémentaire. Si la commande échoue, le flux normal reprend : la garde est
  purement additive.
- **AppImage = seule mise à jour en place.** C'est le format à installer sur ces
  systèmes : l'updater remplace le fichier `.AppImage` lui-même, sans toucher au
  système. Sous Fedora 41+, `libfuse2` n'est plus fourni : si l'AppImage refuse de
  démarrer, lancer `APPIMAGE_EXTRACT_AND_RUN=1 ./Lavande_<version>_amd64.AppImage`.
- **Voie manuelle, non automatisée.** `rpm-ostree install ./Lavande-<version>-1.x86_64.rpm`
  puis redémarrage : le paquet est intégré à la nouvelle deployment au reboot.
  L'updater ne tente aucune automatisation `rpm-ostree`.

## Ce qui manque pour activer l'auto-updater (à faire)

Le code est en place, mais **aucune mise à jour ne peut encore être distribuée**
tant que les points ci-dessous ne sont pas faits :

1. **Héberger l'endpoint.** `https://lavande.lanro.eu/updates/` n'existe pas. Choisir
   un hébergement (serveur statique HTTPS, ou releases Gitea/GitHub — voir
   « Endpoint »), y déposer les fichiers, et au besoin mettre à jour
   `plugins.updater.endpoints` dans `src-tauri/tauri.conf.json`.
2. **Sauvegarder les clés privées.** `.tauri/lavande-updater.key`, la clé GPG de release
   (`LAVANDE_GPG_KEY_ID`) et le keystore APK ne sont que sur ce poste. Les copier
   dans un gestionnaire de secrets / une sauvegarde chiffrée hors ligne — inventaire
   et procédure : [`SIGNING.md`](./SIGNING.md). Perdue, la clé de l'updater casse la
   chaîne de mise à jour (réinstallateur complet à republier).
3. **Publier une première release.** Incrémenter la version (`tauri.conf.json` +
   `package.json`, ex. 0.1.0 → 0.2.0), construire les paquets, lancer
   `npm run release:updater -- --notes "…"`, puis déposer `latest.json` + paquets +
   `.sig` sur l'endpoint. Sans une version supérieure publiée, l'app restera « à jour ».
4. **Construire l'AppImage.** L'AppImage est construite et publiée depuis la 0.2.x
   (`scripts/release.sh`, clé `linux-x86_64-appimage` dans le manifeste produit par
   `scripts/release-updater.mjs`). C'est le format le plus fiable pour l'auto-update
   Linux (mise à jour en place). Le bundler télécharge `linuxdeploy`/`appimagetool`
   (réseau requis au build).
5. **Tester le flux de bout en bout.** Vérifier avec une vraie mise à jour hébergée :
   détection → téléchargement → vérification de signature → installation →
   redémarrage. Pas encore fait.
6. **Prérequis d'installation RPM.** Le poste cible doit avoir polkit (`pkexec`) ou
   `sudo` pour `rpm -U`. À confirmer sur la machine de l'utilisateur ; sinon
   privilégier l'AppImage.
7. **(Optionnel) Vérification au démarrage.** Aujourd'hui la vérification silencieuse
   n'a lieu qu'à l'ouverture des Réglages (1×/session). On peut ajouter une
   vérification au lancement + notification si une mise à jour est disponible.
