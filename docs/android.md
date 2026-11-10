# Android — coquille native (APK)

La même interface que la maquette mobile, dans une coquille **Tauri v2** : plein écran, sans le cadre
téléphone ni la fausse barre de statut de la version web. Toujours aucun backend : les données restent
des fixtures de `src/lib/mail.ts`.

## Prérequis

| Élément | Valeur utilisée ici |
| --- | --- |
| JDK | Temurin 21 extrait dans `~/.local/share/jdk-21` (pas de paquet système) |
| SDK Android | `~/Android/Sdk` |
| NDK | `~/Android/Sdk/ndk/28.2.13676358` |
| Cibles rustup | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` |
| Compilateur hôte | `cc` système, sinon le clang 19 du NDK exposé par le script |
| Versions générées | compileSdk 37, targetSdk 37, minSdk 24, AGP 9.3.1, Gradle 9.6.1 |

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

## Environnement

```bash
source scripts/android-env.sh
java -version && echo "$NDK_HOME"     # contrôle rapide
```

| Variable | Valeur |
| --- | --- |
| `JAVA_HOME` | `~/.local/share/jdk-21` |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | `~/Android/Sdk` |
| `NDK_HOME` | `~/Android/Sdk/ndk/28.2.13676358` |
| `PATH` | JDK, `platform-tools` (donc `adb`), plus `~/.local/share/hostgcc/bin` si la machine n'a pas de `cc` |

Le script est à **sourcer**, pas à exécuter : les variables doivent rester dans le shell appelant.

Si la machine n'a **aucun** `cc` hôte, le script en fabrique un sans sudo : un wrapper autour du clang 19
du NDK, avec `--gcc-install-dir` pointant sur les objets et bibliothèques libgcc extraits dans
`~/.local/share/hostgcc`. C'est ce que réclament les build scripts C des crates (`proc-macro2`, `libc`…),
qui compilent pour l'hôte et pas pour Android.

## Initialiser le projet Android

```bash
npm run android:init      # tauri android init && node scripts/patch-android.mjs
```

`src-tauri/gen/` reste **ignoré par git** : le projet Gradle est régénérable, donc à recréer après un
clone ou après un `rm -rf src-tauri/gen`.

## Construire l'APK

```bash
npm run android:build     # release, arm64, signé → dist/android/Lavande.apk
```

Le script `scripts/build-android-release.sh` enchaîne : `patch-android.mjs`, `tauri android build --apk -t aarch64`,
`zipalign`, signature avec `~/.android/lavande-release.jks` (créé au premier lancement), puis vérification
`apksigner`. `npm run android:build:debug` existe pour déboguer (`chrome://inspect`), mais **pas pour un usage
réel** : voir « Fluidité ».

Le front est construit avant le build natif (`beforeBuildCommand: npm run build` dans
`src-tauri/tauri.conf.json`). `[profile.release] strip = true` fait tomber le `.so` à 6,2 Mo (contre 21,7 Mo
en dev, et 127 Mo sans strip).

### Build mono-ABI arm64

```bash
./node_modules/.bin/tauri android build --debug --apk -t aarch64
```

| Pourquoi | Détail |
| --- | --- |
| Taille | un `.so` de debug par ABI ; quatre ABI = quatre bibliothèques dans le même APK |
| Temps | quatre compilations Rust au lieu d'une |
| Suffisance | un téléphone récent est en `arm64-v8a` : les autres ABI ne servent qu'aux vieux appareils et à l'émulateur x86_64 |

Mesure sur ce dépôt : `-t aarch64` donne un APK **universal** de **28,9 Mo** contenant une seule
`lib/arm64-v8a/liblavande_lib.so` de 21,7 Mo. Sans `-t`, les quatre ABI sont embarquées : les `.so`
mesurés dans `src-tauri/target/*` allaient de 112 à 127 Mo **avant** `strip`.

`[profile.dev] strip = "debuginfo"` dans `src-tauri/Cargo.toml` fait passer le `.so` de 127 Mo à
21,7 Mo : c'est ce qui rend l'APK installable sans attendre des centaines de Mo.

## Où se trouve l'APK

| Fichier | Rôle |
| --- | --- |
| `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk` | sortie Gradle, non signée |
| `dist/android/Lavande.apk` | APK release signé, prêt à installer (`dist/` est ignoré par git) |

Les deux sont produits par le même script :

```bash
npm run android:build
```

## Installer

Par USB, `adb` étant dans le `PATH` après `source scripts/android-env.sh` :

```bash
adb devices
adb install -r dist/android/Lavande.apk
```

Sans câble : transférer l'APK sur le téléphone (cloud, Bluetooth, `scp`), l'ouvrir depuis le gestionnaire
de fichiers et autoriser l'installation depuis cette source. `-r` réinstalle en conservant les données.

## Signature

L'APK est signé en release avec `~/.android/lavande-release.jks` (alias `lavande`, mot de passe `lavande`),
crée automatiquement par `scripts/build-android-release.sh` s'il manque. Conséquence pratique : la clé
diffère de la clé debug d'Android — une app installée depuis un build debug doit être **désinstallée** avant
d'installer un build release. Les mises à jour release s'installent ensuite par-dessus sans perte de données.

## `scripts/patch-android.mjs`

`tauri android init` régénère `src-tauri/gen/android` : toute retouche native y serait perdue. Le script
est **idempotent** et rejoué après `init` puis avant chaque build (les deux commandes npm l'appellent).

| Fichier écrit | Contenu | Pourquoi |
| --- | --- | --- |
| `app/src/main/java/mail/lavande/app/MainActivity.kt` | `enableEdgeToEdge()`, listener `WindowInsetsCompat` sur `android.R.id.content`, recherche récursive de la WebView, injection de `--safe-bottom` et `--ime-bottom` en px CSS | `env(safe-area-inset-*)` vaut **0** dans la WebView Android |
| `res/values/colors.xml` | `lavande_canvas` `#fbfaff`, `ic_launcher_background` `#8b7cf6` | fond de fenêtre et fond de l'icône adaptative |
| `res/values/themes.xml` et `res/values-night/themes.xml` | `android:windowBackground` = `@color/lavande_canvas` | évite le flash blanc au lancement (thème `Theme.Material3.DayNight.NoActionBar`) |
| `res/mipmap-anydpi-v26/ic_launcher.xml` et `ic_launcher_round.xml` | icône adaptative : fond couleur + `@mipmap/ic_launcher_foreground` | icône ronde / adaptative cohérente avec le monogramme |

Détails du pont d'insets : il ne s'occupe que du **bas** (barre de navigation + clavier). Le haut n'est pas
mesuré : `.native-shell` réserve une marge fixe de 44 px (`--native-top`), parce qu'une hauteur de barre de statut ou
d'encoche change selon la marque et le modèle — une valeur mesurée serait juste ici et fausse ailleurs.
Le listener garde la dernière valeur, réinjecte après `onResume` et sur `addOnGlobalLayoutListener`, et
**n'injecte rien** si la signature `bottom|ime` n'a pas changé.

## Côté web

| Élément | Rôle |
| --- | --- |
| `isNativeShell()` (`src/lib/native.ts`) | vrai si l'URL contient `?app`, ou si `__TAURI_INTERNALS__` existe et que l'UA contient `Android` |
| `NativeShell` (`src/App.tsx`) | `PhoneApp` en plein écran, classe `.native-shell`, sans le `Stage` (cadre téléphone + barre de statut factice) |
| `src/index.css` | marge haute fixe `--native-top: 44px`, tokens `--safe-bottom` et `--ime-bottom` (défaut `0px`) pour le bas, consommés par `.native-shell` (`bottom: max(--safe-bottom, --ime-bottom)` pour le clavier) |
| Polices | deux `@font-face` locaux (Plus Jakarta Sans, `src/assets/fonts/`, licence OFL) ; `index.html` ne charge plus Google Fonts |
| Icône | `app-icon.svg` (monogramme L) → `./node_modules/.bin/tauri icon app-icon.svg` → `src-tauri/icons/`, `bundle.icon` renseigné dans `src-tauri/tauri.conf.json` |

`?app` est ignoré quand `?desktop` est présent : `?desktop&app` reste la maquette PC.

## Mode aperçu `?app`

`https://plasma.int.lanro.eu:8443/lavande/?app` (ou `http://localhost:1420/?app`) montre le rendu natif
dans un navigateur : plein écran, sans cadre téléphone. Les insets restent à 0 (aucun pont natif) ; tout
le reste est identique à l'APK. C'est le moyen de juger une mise en page plein écran sans builder.

## Fluidité

Le rendu de l'APK est **identique à la maquette** : aucun effet n'est coupé (le `glass` du dock garde son
`backdrop-filter: blur(20px) saturate(180%)`, les halos leurs `blur(90–110px)`, les dégradés animés tournent).

| Levier | Effet |
| --- | --- |
| **Build release** (le principal) | en debug, la WebView active l'inspecteur V8 et du code non optimisé : sur téléphone l'app devient saccadée. En release, elle est fluide — c'est le seul changement qui a réellement tout débloqué. |
| Glissement entre onglets | reste **déclaratif** (état React → `transform`) : une version en écriture directe (`strip.style.transform`) avait été tentée, puis abandonnée — une fermeture périmée réappliquait l'ancien index après un tap sur le dock, d'où un double clic nécessaire. Le coût par événement est faible parce que les 4 écrans sont mémoïsés. |
| Écrans mémoïsés | `memo` + gestionnaires `useCallback` + `Set` des mails mémoïsé : un tap ou un toast ne réconcilie plus les 4 écrans, seulement celui qui change |
| Coquille PC en différé | `import()` de `desktop-shell` : 86 kB de JS absents du bundle mobile |
| Fond peint avant le JS | `background: #fbfaff` inline dans `index.html` et `setBackgroundColor()` sur la WebView : plus de flash blanc au lancement |

**Piège écarté** : `content-visibility: hidden` sur les écrans hors champ masquait l'écran sortant pendant
l'animation de changement d'onglet (page blanche intermittente). Retiré — la fluidité ne venait pas de là.

**Limite connue** : le `backdrop-filter` est cher dans la WebView Android (Chromium bug 1264369 :
les animations deviennent lentes dès qu'une surface floutée existe ; la région est re-floutée à chaque image
qui défile dessous). Chrome/Brave ont un chemin GPU que la WebView n'a pas. Si un accroc revient alors que
le dock est visible, c'est le premier suspect.




- **Barre de statut** : elle n'est pas mesurée. Une marge fixe de 44 px est réservée en haut (`.native-shell`,
  token `--native-top`)
  parce que la hauteur de la barre et de l'encoche change selon la marque et le modèle : mieux vaut une
  valeur constante qu'une valeur juste sur un seul appareil. Sur un modèle à grosse encoche, le titre peut
  se rapprocher des icônes. Le fond reste transparent, donc le lavande de l'app passe dessous.
- **Bas mesuré, non validé sur appareil physique** : le pont renvoie la barre de navigation et le clavier,
  mais rien n'a été mesuré sur un téléphone réel ; en mode `?app` ces marges valent 0 par construction.
- **Pas de gestes ni d'haptique natifs** : seuls les gestes WebView existants (swipe d'onglets, swipe de
  ligne) sont disponibles ; pas de retour haptique, pas de tiroir natif.
- **Bouton retour Android = historique WebView** : chaque couche ouverte pousse un état d'historique
  (`pushState` dans `src/App.tsx`), donc retour ferme la couche du dessus (message, feuille, overlay) ;
  sans couche ouverte, il sort de l'app.
- **Pas de backend mail** : fixtures uniquement (sauf la planification, synchronisée — voir ci-dessous) ;
  thème, accent, préférences de gestes et documents de planification en `localStorage`.
- Pas de build release signé, pas de `--split-per-abi`, pas de CI Android.

## Synchronisation de la planification (APK)

Les tâches et suggestions se synchronisent entre appareils via le serveur `server/` (protocole E2EE :
[`SYNC.md`](./SYNC.md)). Côté APK, trois points sont indispensables et déjà en place :

| Point | Réglage |
| --- | --- |
| Origine WebView autorisée côté serveur | `http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost` sont dans les origines CORS par défaut (`server/src/config.rs`) |
| HTTP en clair vers le serveur LAN | `scripts/patch-android.mjs` pose `android:usesCleartextTraffic="true"` dans `AndroidManifest.xml` ; sans ça, Android bloque `http://192.168.x.x:8787` |
| URL du serveur | champ **Réglages → Synchronisation → URL du serveur** : `127.0.0.1` n'a pas de sens sur un téléphone, il faut l'adresse LAN de la machine qui héberge le serveur. La dernière URL saisie est mémorisée |

Le jeton, les enveloppes de clés et les documents chiffrés restent dans le `localStorage` de la WebView :
l'app est utilisable hors ligne, les mutations s'empilent et partent à la prochaine synchro.

Le serveur écoute sur `127.0.0.1:8787` par défaut : depuis un téléphone il doit être joignable sur le LAN,
donc lancer avec `LAVANDE_SYNC_BIND_ADDR=0.0.0.0:8787 cargo run` (et ouvrir le port 8787 dans le pare-feu).
Sans HTTPS, le TLS n'est pas exigé : l'enveloppe et les ops sont déjà chiffrées côté client.
