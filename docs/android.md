# Android — coquille native (APK)

La même interface que la maquette mobile, dans une coquille **Tauri v2** : plein écran, sans le cadre
téléphone ni la fausse barre de statut de la version web. Le démon mail (`crates/mail-api`) est embarqué
dans le processus de l'app (`127.0.0.1:8790`, données dans le stockage privé) : l'APK est un vrai client
mail, sans mode démo (verrou distribution — voir ci-dessous).

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
npm run android:build     # release, arm64, signé → artifacts/apk/Lavande.apk
```

Le script `scripts/build-android-release.sh` enchaîne : `patch-android.mjs`, `tauri android build --apk -t aarch64`,
`zipalign`, signature avec `~/.android/lavande-release.jks` (créé au premier lancement), puis vérification
`apksigner`. `npm run android:build:debug` existe pour déboguer (`chrome://inspect`), mais **pas pour un usage
réel** : voir « Fluidité ».

Le front est construit avant le build natif (`beforeBuildCommand: npm run build:distribution` dans
`src-tauri/tauri.conf.json`). `[profile.release] strip = true` fait tomber le `.so` à 6,2 Mo (contre 21,7 Mo
en dev, et 127 Mo sans strip).

### Verrou distribution et gate plateforme

Les deux builds, release et debug, produisent un APK **verrouillé** :

| Variable | Posée par | Effet |
| --- | --- | --- |
| `VITE_DISTRIBUTION=1` | `scripts/build-android-release.sh` l'exporte ; en debug c'est `beforeBuildCommand` (`npm run build:distribution`) qui s'en charge, donc tout `tauri android build` en hérite | `mailMode()` (`src/lib/mail-backend.ts`) renvoie toujours `api` (`VITE_MAIL_BACKEND=demo` ignoré) ; fixtures purgées du bundle (`EVENTS`, `TASKS`, `MAILS`, `MAIL_SUGGESTIONS`, `RECENT_SEARCHES` valent `[]`) ; aucun aperçu maquette (« Voir la démo », « Voir la maquette PC », badges « maquette PC » / « design preview ») |
| `VITE_PLATFORM=android` | `scripts/build-android-release.sh` et `npm run android:build:debug` | `vite.config.ts` aliase `@/lib/mcp` et `@/screens/mcp-screen` vers `src/lib/mcp.android.ts` et `src/screens/mcp-screen.android.tsx` : le code MCP **n'est pas dans l'APK** (stubs vides, pas du code masqué), et ses sections sortent des réglages |

Conséquence pratique : l'APK n'a **pas de mode démo**. Sans compte configuré, il s'arrête à l'écran de
connexion ; les données de la maquette n'existent pas dans le bundle. Pour revoir la maquette mobile, il
faut le web (`?app` ou le portail), où les deux variables sont absentes.

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
| `artifacts/apk/Lavande.apk` | APK release signé, prêt à installer (`artifacts/` est ignoré par git ; `dist/` est effacé par `npm run build`) |

Les deux sont produits par le même script :

```bash
npm run android:build
```

## Installer

Par USB, `adb` étant dans le `PATH` après `source scripts/android-env.sh` :

```bash
adb devices
adb install -r artifacts/apk/Lavande.apk
```

Sans câble : transférer l'APK sur le téléphone (cloud, Bluetooth, `scp`), l'ouvrir depuis le gestionnaire
de fichiers et autoriser l'installation depuis cette source. `-r` réinstalle en conservant les données.

## Mises à jour (APK)

L'app se met à jour elle-même, sans store : Réglages → **Mise à jour** (groupe *Application*).

| Étape | Qui | Détail |
| --- | --- | --- |
| 1. Manifeste | Front | `android_update_endpoint` (Rust) renvoie `plugins.updater.endpoints[0]` ; le front lit `version`, `notes` et `platforms.android` (filtré par `http:default`, HTTPS) |
| 2. Comparaison | Front | `compareVersions` sur des segments numériques : rien à faire si la version annoncée n'est pas supérieure |
| 3. Téléchargement | Plugin Kotlin | `plugin:lavandeupdater|download_apk` (relais Rust → Kotlin) vers `cacheDir/lavande-update.apk`, schéma `https` exigé (HTTP seulement vers la boucle locale) ; la barre reste indéterminée, le plugin ne relaie pas de pourcentage |
| 4. Signature | Rust | `verify_android_update` : minisign avec la **même clé** que le bureau, et version du *trusted comment* égale à celle du manifeste — la vérification ne dépend pas du plugin |
| 5. Autorisation | Plugin Kotlin | `can_install` (`REQUEST_INSTALL_PACKAGES`) ; sinon `open_install_settings` ouvre le réglage système de l'app et l'UI explique quoi faire |
| 6. Installation | Plugin Kotlin | `install_apk` : session `PackageInstaller`, `InstallResultReceiver` relaie la confirmation système (`STATUS_PENDING_USER_ACTION`) |

Un plugin Kotlin n'est pas joignable depuis le JS : chaque commande ci-dessus est une
commande **Rust** du plugin qui relaie vers Kotlin (`run_mobile_plugin_async`), et c'est ce
relais qui porte la permission ACL.

Ce qui reste vrai :

- **Continuité de signature** — l'APK publié doit être signé par le keystore release, sinon Android refuse
  la mise à jour par-dessus l'installation existante. Le même `.jks` signe donc build et updater.
- **`REQUEST_INSTALL_PACKAGES`** est déclarée par `scripts/patch-android.mjs` (avec le receiver) : la
  permission ne suffit pas, l'utilisateur doit autoriser « installer des applications inconnues » pour
  Lavande — l'UI le détecte et ouvre le réglage au lieu d'échouer.
- **Publication** — `scripts/release-updater.mjs` copie et signe `artifacts/apk/Lavande.apk` dans le
  dossier de sortie et écrit `platforms.android` ; `scripts/release.sh` publie cet APK-là (les octets
  couverts par la signature). L'installation depuis un build **debug** demande toujours une désinstallation
  préalable (clé différente).

## Signature

L'APK est signé en release avec `~/.android/lavande-release.jks` (alias `lavande`), créé par
`scripts/build-android-release.sh` s'il manque. Le mot de passe **n'a pas de défaut** : le script refuse de
signer quand `LAVANDE_KEYSTORE_PASSWORD` est absent, vide, ou vaut `lavande` (l'ancien défaut, public).

```bash
export LAVANDE_KEYSTORE_PASSWORD="$(openssl rand -base64 24)"
npm run android:build
```

Le secret voyage par l'environnement — `--ks-pass env:LAVANDE_KEYSTORE_PASSWORD` pour `apksigner`,
`-storepass:env LAVANDE_KEYSTORE_PASSWORD` pour `keytool` — et non par la ligne de commande, sinon il
reste lisible dans `ps`. Le `.jks` est créé en `0600`.

**Sauvegarde hors ligne du `.jks` et de son mot de passe** : c'est la seule chose à conserver. Perdu, plus
une seule mise à jour n'est possible sur les appareils déjà installés — Android refuse une mise à jour
signée par une autre clé, il faut désinstaller (et perdre les données locales). Le chemin du keystore ne
change pas : un `.jks` existant avec l'ancien mot de passe reste utilisable, il suffit d'exporter le bon
`LAVANDE_KEYSTORE_PASSWORD`.

Conséquence pratique : la clé diffère de la clé debug d'Android — une app installée depuis un build debug
doit être **désinstallée** avant d'installer un build release. Les mises à jour release s'installent ensuite
par-dessus sans perte de données.

## `scripts/patch-android.mjs`

`tauri android init` régénère `src-tauri/gen/android` : toute retouche native y serait perdue. Le script
est **idempotent** et rejoué après `init` puis avant chaque build (les deux commandes npm l'appellent).

| Fichier écrit | Contenu | Pourquoi |
| --- | --- | --- |
| `app/src/main/java/mail/lavande/app/MainActivity.kt` | `enableEdgeToEdge()`, `layoutInDisplayCutoutMode = LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES`, apparence des barres et fond de WebView relus dans les `SharedPreferences` avant le premier paint, listener `WindowInsetsCompat` sur `android.R.id.content`, injection de `--native-top`, `--safe-bottom` et `--ime-bottom` en px CSS | `env(safe-area-inset-*)` vaut **0** dans la WebView Android ; le haut n'est plus une constante ; sans `SHORT_EDGES` l'encoche reste peinte par le fond natif au lieu de la bande web |
| `java/mail/lavande/app/LavandeUiBars.kt` | `object` : préférence `lavande_ui`/`bars_dark` (défaut clair), `appearance(activity, dark)` via `WindowInsetsControllerCompat` (`isAppearanceLightStatusBars`/`…NavigationBars`), `canvas()` = `#FBFAFF` / `#0E0C13`, `paint()` qui peint le fond de la WebView, `findWebView()` partagé avec `MainActivity` | un seul propriétaire de l'apparence des barres et du fond sous la WebView |
| `java/mail/lavande/app/LavandeUiBarsPlugin.kt` | plugin Tauri `lavandeuibars` : `setBarsAppearance` (`{dark}`) | le thème de l'app pilote les icônes système, plus le mode nuit du téléphone |
| `res/values/colors.xml` | `lavande_canvas` `#fbfaff`, `lavande_band` `#eceaf3`, `ic_launcher_background` `#8b7cf6` | fond de fenêtre, bande de statut et fond de l'icône adaptative |
| `res/values-night/colors.xml` | `lavande_canvas` `#0e0c13`, `lavande_band` `#1a1724` | la bande reste sombre avec le mode nuit système : pas de flash blanc en thème sombre |
| `res/values/themes.xml` et `res/values-night/themes.xml` | `android:windowBackground` = `@color/lavande_band` | le ton peint derrière l'encoche et au tout premier paint est celui de la bande, pas le canvas (thème `Theme.Material3.DayNight.NoActionBar`) |
| `res/mipmap-anydpi-v26/ic_launcher.xml` et `ic_launcher_round.xml` | icône adaptative : fond couleur + `@mipmap/ic_launcher_foreground` (dégradé plein cadre) | icône ronde / adaptative = carré dégradé violet |
| `AndroidManifest.xml` | retire `android:usesCleartextTraffic`, pose `android:networkSecurityConfig`, `android:allowBackup="false"`, `android:fullBackupContent="false"`, `android:dataExtractionRules`, `REQUEST_INSTALL_PACKAGES`, `RECEIVE_BOOT_COMPLETED`, le receiver `.InstallResultReceiver`, le receiver `.LavandeWidgetProvider` (exporté, `APPWIDGET_UPDATE` + méta-données du widget) et le receiver `.BootReceiver` (`BOOT_COMPLETED`) | cleartext borné, sauvegarde fermée (voir ci-dessous), installation d'APK (mises à jour), widget et synchro de fond |
| `java/mail/lavande/app/LavandeUpdaterPlugin.kt` | plugin Tauri `lavandeupdater` : `downloadApk`, `canInstall`, `openInstallSettings`, `installApk` | téléchargement de l'APK et session `PackageInstaller` |
| `java/mail/lavande/app/InstallResultReceiver.kt` | receiver du résultat de session : relaie `STATUS_PENDING_USER_ACTION` (confirmation système) | sans lui, la confirmation d'installation n'apparaît jamais |
| `java/mail/lavande/app/BackgroundSyncPlugin.kt` | plugin Tauri `lavandebgsync` : `setBackgroundSync`, `backgroundSyncState`, `setMutedAccounts`, `syncNow` | planification de la synchro de fond depuis les réglages de l'app |
| `java/mail/lavande/app/BackgroundSyncLib.kt` | `object` JNI : `System.loadLibrary("lavande_lib")` + `external fun syncNow(dataDir)`, symbole `Java_mail_lavande_app_BackgroundSyncLib_syncNow` | WorkManager réveille le worker sans activité : la bibliothèque native doit être chargée par le worker lui-même |
| `java/mail/lavande/app/LavandeSyncWorker.kt` | `CoroutineWorker` : appelle le Rust, filtre les comptes muets, écrit le résumé, rafraîchit le widget, notifie sur une hausse des non lus | exécution hors WebView, rejeu unique sur panne réseau (`runAttemptCount`) |
| `java/mail/lavande/app/LavandeWidgetProvider.kt` | `AppWidgetProvider` qui rend `widget_summary` en `RemoteViews`, plus `refresh(context)` | affichage instantané, même app jamais ouverte |
| `java/mail/lavande/app/LavandeBgPrefs.kt` | `SharedPreferences` `lavande_bg` : interrupteur, comptes muets, résumé du widget, non lus par compte | une seule source lue par le plugin, le worker, le widget et `BootReceiver` |
| `java/mail/lavande/app/BootReceiver.kt` | réinscrit le travail périodique sur `BOOT_COMPLETED` si l'interrupteur est ouvert | WorkManager perd ses échéances au redémarrage de l'appareil |
| `res/layout/lavande_widget.xml`, `res/xml/lavande_widget_info.xml`, `res/drawable/lavande_widget_bg.xml`, `res/drawable/ic_lavande_notification.xml` | mise en page (`LinearLayout`), métadonnées du widget (`minWidth`/`minHeight`, `updatePeriodMillis=0`), fond arrondi, icône de notification monochrome | `RemoteViews` refuse `ConstraintLayout` ; Android 8+ exige une petite icône blanche |
| `app/build.gradle.kts` | ajoute `androidx.work:work-runtime-ktx:2.9.1` et `androidx.core:core-ktx:1.13.1` au bloc `dependencies` (seulement s'ils manquent) | WorkManager et `NotificationCompat` absents du modèle Gradle généré |
| `res/xml/network_security_config.xml` | `cleartextTrafficPermitted="false"` en `base-config`, `true` seulement pour `127.0.0.1`, `localhost` et les hôtes de `LAVANDE_SYNC_HOSTS` | le démon mail local parle HTTP ; tout le reste doit être HTTPS |
| `res/xml/data_extraction_rules.xml` | exclut `secrets.enc`, `secrets.key`, `daemon-token`, `mail.db` (+ `-wal`, `-shm`) et `app_webview` de `cloud-backup` et `device-transfer` | les secrets ne quittent pas l'appareil par une sauvegarde, même quand `allowBackup="false"` est ignoré (transfert d'appareil à appareil) |

### Ce que le manifeste refuse (sauvegarde, trafic en clair)

| Réglage | Effet |
| --- | --- |
| `android:allowBackup="false"` + `android:fullBackupContent="false"` | aucune sauvegarde automatique (cloud ou `adb backup`) jusqu'à Android 11 ; `allowBackup="false"` ne suffit pas à bloquer le transfert d'appareil à appareil (Android 12+), d'où la règle suivante |
| `android:dataExtractionRules` | en plus des quatre secrets listés, exclut `app_webview`, qui contient le `localStorage` de la WebView (jeton de synchro, enveloppes de clés E2EE) : le trousseau local ne suit pas l'utilisateur d'un téléphone à l'autre, il se re-crée par la paire de clés |
| `networkSecurityConfig` au lieu de `usesCleartextTraffic="true"` | le HTTP en clair n'est permis que pour les hôtes listés ; ailleurs (IMAP/SMTP n'étant pas concernés, voir la limite ci-dessous) c'est HTTPS ou échec `ERR_CLEARTEXT_NOT_PERMITTED` |

**Limite connue — le serveur de synchro est saisi à l'exécution** (`Réglages → Synchronisation → URL du
serveur`, clé `lavande.sync.serverUrl`). Android ne sait autoriser le cleartext que par nom d'hôte ou IP
explicite : aucune règle ne couvre « n'importe quelle adresse du LAN », et un `domain-config` ne se recompose
pas à chaud. La liste est donc figée au moment du patch, via une variable de build :

```bash
LAVANDE_SYNC_HOSTS="192.168.1.42" npm run android:build   # ou "192.168.1.42,nas.lan"
```

Sans cette variable, seule la boucle locale est autorisée en HTTP : un serveur de synchro local en `http://`
(port 8787) est bloqué par la WebView, et la synchro échoue alors qu'elle marchait. Deux sorties : relancer le
build avec l'hôte en clair, ou servir le serveur en HTTPS (le protocole est déjà chiffré de bout en bout,
voir `SYNC.md`, donc le TLS ne protège que les métadonnées). Le refus est explicite côté WebView, jamais
silencieux. `LAVANDE_SYNC_HOSTS` valide ses entrées (nom ou IP, sans schéma ni port) et échoue sinon. En
debug, `devUrl` vaut `http://localhost:1420` (`tauri.conf.json`), donc déjà autorisé ; un serveur de dev
pointé sur une IP du LAN demande lui aussi `LAVANDE_SYNC_HOSTS`.

Le cleartext de la config réseau ne s'applique qu'à la pile réseau Java/WebView. Le démon embarqué
(`crates/mail-api`) sort par des sockets Rust : IMAP/SMTP en clair, souvent le seul mode proposé par un
serveur mail local, ne sont pas bridés par ce fichier.

Détails du pont d'insets : il pousse le **haut** (`--native-top`), le **bas** (barre de navigation) et le clavier
(`--safe-bottom`, `--ime-bottom`). Le haut est l'union `systemBars() or displayCutout()` du système, convertie en px
CSS par la densité de l'écran : elle couvre la barre de statut **et** l'encoche, sans valeur devinée. `--native-top: 44px` ne reste
qu'un repli (`:root`), pour le navigateur en mode `?app` où aucun pont n'existe. Le listener garde la dernière
valeur, réinjecte après `onResume` et sur `addOnGlobalLayoutListener`, et **n'injecte rien** si la signature
`top|bottom|ime` n'a pas changé — le haut en fait partie, sinon un changement de barre seule passerait inaperçu.
Les tout premiers insets arrivent avant le chargement de la page et partent dans le document vide : `setBarsAppearance`
(appelé par l'effet du thème, une fois la page vivante) et `onResume` réinitialisent la signature pour réinjecter
les valeurs dans le document chargé.

## Synchronisation en arrière-plan et widget

Le démon embarqué ne vit que dans l'app ouverte : un réveil système (WorkManager) synchronise les
boîtes app fermée, et un widget d'écran d'accueil affiche les non lus et les derniers mails.

| Pièce | Rôle |
| --- | --- |
| Cycle | un seul travail périodique unique (`lavande-mail-periodic`, **15 min**, minimum imposé par Android) avec contraintes « réseau connecté » + « batterie pas faible », plus un travail ponctuel (`lavande-mail-now`) à l'activation et sur `syncNow` |
| Interrupteur | JS → `plugin:lavandebgsync\|set_background_sync` (`{enabled:boolean}`), relais Rust vers Kotlin `setBackgroundSync` : écrit `background_sync_enabled` dans les `SharedPreferences` `lavande_bg` puis planifie ou annule le travail ; `background_sync_state` relit le drapeau. `sync_now` renvoie `{ok:true}` après mise en file |
| Réveil | `LavandeSyncWorker` (`CoroutineWorker`, contexte applicatif) appelle `BackgroundSyncLib.syncNow(dataDir)` |
| Pont JNI | `src-tauri/src/sync_bridge.rs`, symbole `Java_mail_lavande_app_BackgroundSyncLib_syncNow` : runtime tokio, **sa propre** instance de `AppState` sur le même `mail.db`, puis `lavande_mail_api::widget::sync_and_summarize(&state, 3)`. Rend `{"summary":{"accounts":[…],"mails":[…],"unread":N,"updated_at":TS}}` ou `{"error":"…"}` ; aucune panique ni exception ne traverse la FFI |
| Résumé | `crates/mail-api/src/widget.rs` : par compte, INBOX résolue par `role == Inbox` (repli `INBOX`), non lus = `folder_counts` de **cette seule** boîte, mails = `threads_in_folder(…, 3, 0)` (les 3 plus récents, comptes mêlés), `from` = nom affiché sinon adresse. Erreurs de lecture et de synchro collectées, jamais fatales ; `summarize` est testé côté hôte |
| Comptes muets | `plugin:lavandebgsync\|set_muted_accounts` (`{ids}`) → Kotlin `setMutedAccounts` (périmètre #32) : le Rust rend **tous** les comptes, le filtrage se fait en Kotlin après parsing — un compte muet disparaît du widget et des notifications |
| Widget | `LavandeWidgetProvider` rend le résumé stocké en `RemoteViews` (`LinearLayout` de quatre `TextView`) : « N non lus » + jusqu'à 3 lignes « étiquette · sujet », « Aucun compte » si aucun compte ; tout le widget ouvre `MainActivity`. `updatePeriodMillis=0` : seul le worker le rafraîchit |
| Notification | canal `mails`, le même que `src/lib/notify.ts` (créé s'il manque, `IMPORTANCE_HIGH`, description identique) ; une seule notification, et seulement quand le nombre de non lus d'un compte **dépasse** le compteur mémorisé (`widget_unread`) |
| Démarrage | `BootReceiver` (`BOOT_COMPLETED` + `RECEIVE_BOOT_COMPLETED`) réinscrit le travail périodique quand l'interrupteur est ouvert |

Points durs :

- **Même base SQLite, deux instances.** Le worker entre par un autre chemin que l'app (aucune activité,
aucune WebView) et ouvre ses propres connexions ; `journal_mode=WAL` et `busy_timeout(5s)`, posés par
`Store::open`, sérialisent les écritures. Une synchro de l'app ouverte et une du worker peuvent se
chevaucher sans corruption, au prix d'un aller-retour IMAP en double.
- **Le worker charge la bibliothèque lui-même** : le `System.loadLibrary` vit dans `BackgroundSyncLib.init`,
parce qu'aucun `MainActivity` n'existe quand WorkManager réveille le processus.
- **Persistance du travail** : WorkManager garde ses échéances dans sa propre base, elles survivent à un
kill de l'app mais **pas** au redémarrage de l'appareil — d'où `BootReceiver`. Une mise à jour d'APK
conserve la file. Désactiver la synchro annule le travail périodique, pas le résumé déjà stocké.
- **Rythme imprécis** : 15 min est un minimum, Android regroupe les réveils et Doze décale davantage.
Rien ne garantit une relève à l'heure près ; le résumé porte son horodatage (`updated_at`), que le
widget n'affiche pas faute de place.
- **`RemoteViews`** : ni `ConstraintLayout` ni `TextView` riche — la mise en page reste un `LinearLayout`
de `TextView`, ce qui borne la mise en forme (une ligne par mail, tronquée).
- **Permission de notification** : `POST_NOTIFICATIONS` est déclarée, mais un refus utilisateur
(`areNotificationsEnabled()` faux) laisse le worker silencieux : widget et compteurs se mettent à jour
quand même.

## Côté web

| Élément | Rôle |
| --- | --- |
| `isNativeShell()` (`src/lib/native.ts`) | vrai si l'URL contient `?app`, ou si `__TAURI_INTERNALS__` existe et que l'UA contient `Android` |
| `NativeShell` (`src/App.tsx`) | `PhoneApp` en plein écran dans une feuille `.native-sheet` (coins hauts 18 px), elle-même dans `.native-shell` (bande de statut plate), sans le `Stage` (cadre téléphone + barre de statut factice) |
| `src/index.css` | tokens `--native-top` (repli `44px`, écrasé par le pont), `--safe-bottom`/`--ime-bottom` (défaut `0px`, `bottom: max(--safe-bottom, --ime-bottom)` pour le clavier) et `--statusband` (`#eceaf3` en clair, `#1a1724` en sombre, alignés sur `lavande_band` natif) ; `.native-shell` fond `--canvas` + `::before` peignant la bande **plate** `--statusband` sur `--native-top` en haut (le bas, barre nav/clavier, reste canvas), `.native-sheet` coins arrondis en haut |
| `applySystemBars()` (`src/lib/system-bars.ts`) | appelle `plugin:lavandeuibars\|set_bars_appearance` (`{dark}`) depuis l'effet du thème, en coquille native seulement |
| Polices | deux `@font-face` locaux (Plus Jakarta Sans, `src/assets/fonts/`, licence OFL) ; `index.html` ne charge plus Google Fonts |
| Icône | `app-icon.svg` (carré dégradé violet, sans monogramme) + `app-icon-adaptive.svg` (même dégradé, plein cadre, calques de l'icône adaptative) → `./node_modules/.bin/tauri icon icon-manifest.json` → `src-tauri/icons/`, `src-tauri/gen/android/app/src/main/res/mipmap-*`, `bundle.icon` renseigné dans `src-tauri/tauri.conf.json` |

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
| Fond peint avant le JS | aucun `background` inline dans `index.html` (les styles inline y sont interdits par la CSP à nonce) ; `windowBackground` = `@color/lavande_band`, avec `values-night` sombre, et `setBackgroundColor()` sur la WebView avec le canvas du thème mémorisé |

**Piège corrigé (#81)** : `setBackgroundColor(0xFFFBFAFF)` figé en dur était la **source** d'un flash blanc en thème
sombre — la WebView repeignait son fond en clair avant que le CSS n'arrive. La couleur vient maintenant du thème
mémorisé (`lavande_ui`/`bars_dark`), lue au `onCreate` et mise à jour par le pont. `Color.TRANSPARENT` a été écarté :
la fenêtre laisse alors voir le gris/noir du premier paint du système.

**Piège écarté** : `content-visibility: hidden` sur les écrans hors champ masquait l'écran sortant pendant
l'animation de changement d'onglet (page blanche intermittente). Retiré — la fluidité ne venait pas de là.

**Limite connue** : le `backdrop-filter` est cher dans la WebView Android (Chromium bug 1264369 :
les animations deviennent lentes dès qu'une surface floutée existe ; la région est re-floutée à chaque image
qui défile dessous). Chrome/Brave ont un chemin GPU que la WebView n'a pas. Si un accroc revient alors que
le dock est visible, c'est le premier suspect.




- **Barre de statut** : elle est mesurée (`systemBars() or displayCutout()`, convertie en px CSS) et poussée dans
  `--native-top` par le pont d'insets ; les 44 px de `src/index.css` ne servent plus qu'au navigateur (`?app`).
  **Décision (21/11)** : le thème de l'app — et lui seul — décide de l'apparence des icônes système
  (`WindowInsetsControllerCompat`, `isAppearanceLightStatusBars`/`…NavigationBars`) ; ni
  `AppCompatDelegate.setDefaultNightMode` ni `values-night` global pour les couleurs web, les widgets gardent leur
  propre mode nuit. Visuel retenu après retour réel sur téléphone à encoche (**21/11**, « bande plate tonale,
  2 tons ») : `.native-shell::before` peint un **ton uni** `--statusband` (`#eceaf3` clair / `#1a1724` sombre, mêmes
  valeurs que `lavande_band` natif, donc l'encoche et le démarrage sont assortis) sur la hauteur `--native-top` en
  haut (le shell reste `--canvas` ailleurs, bas compris) ; le contenu est une feuille opaque `--canvas` à coins arrondis **en haut seulement** (18 px) — les
  arrondir en bas re-floute le dock (voir plus haut). Le cutout est passé en `SHORT_EDGES` : la bande web peint
  dans l'encoche au lieu de laisser le `windowBackground` la repeindre. L'ancien dégradé vertical
  `--statusband-top` → mélange 45 % vers le canvas est abandonné (trois tons visibles : encoche claire, bande
  dégradée, canvas). Le header
  `glass` des écrans reste `absolute top-0` **dans** la feuille : il passe donc sous la bande, c'est voulu.
  `setStatusBarColor` ne peint plus rien depuis l'edge-to-edge imposé (targetSdk 37) : on règle les icônes, jamais
  la couleur native de la barre.
- **Bas mesuré, non validé sur appareil physique** : le pont renvoie la barre de navigation et le clavier,
  mais rien n'a été mesuré sur un téléphone réel ; en mode `?app` ces marges valent 0 par construction.
- **Pas de gestes natifs, haptique par la WebView** : seuls les gestes WebView existants (swipe d'onglets,
  swipe de ligne) sont disponibles, pas de tiroir natif ; le retour haptique passe par
  `navigator.vibrate` (`src/lib/haptics.ts`), inactif sans la permission `android.permission.VIBRATE`
  ajoutée par `scripts/patch-android.mjs`.
- **Bouton retour Android intercepté en JS** : `onBackButtonPress` (`src/lib/back.ts`) prend la main sur
  le retour système et l'app décide seule — aucun retour WebView implicite. Ordre de dépilement :
  couches des composants (drill-in des réglages, confirmation de fermeture, popup de mise à jour) →
  couches de l'app (`layers` dans `src/App.tsx` : feuilles, lecteur de message…) → retour à l'onglet
  Boîte → sortie de l'app (`exit(0)`).
- **Pièces jointes ouvertes par le plugin Kotlin** `LavandeAttachmentsPlugin` (`FileProvider` + `ACTION_VIEW`,
  copie dans le cache de l'app, purgeable par le système — pas un fichier « Téléchargements ») ; sur PC
  elles sont enregistrées dans le dossier de téléchargements, chemin affiché et bouton « Ouvrir le dossier ».
- **Démon mail embarqué** : API locale `127.0.0.1:8790`, données dans le stockage privé de l'app ;
  planification synchronisée (voir ci-dessous) ; thème, accent et préférences de gestes en `localStorage`.
- Pas de `--split-per-abi`, pas de CI Android : l'APK arm64 est signé par `scripts/build-android-release.sh`.

## Synchronisation de la planification (APK)

Les tâches et suggestions se synchronisent entre appareils via le serveur `server/` (protocole E2EE :
[`SYNC.md`](./SYNC.md)). Côté APK, trois points sont indispensables et déjà en place :

| Point | Réglage |
| --- | --- |
| Origine WebView autorisée côté serveur | `http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost` sont dans les origines CORS par défaut (`server/src/config.rs`) |
| HTTP en clair vers le serveur LAN | `scripts/patch-android.mjs` pose un `networkSecurityConfig` (`res/xml/network_security_config.xml`) : HTTP permis pour `127.0.0.1` (démon local) et pour les hôtes de `LAVANDE_SYNC_HOSTS`, refusé partout ailleurs. Sans l'hôte déclaré au build, Android bloque `http://192.168.x.x:8787` |
| URL du serveur | champ **Réglages → Synchronisation → URL du serveur** : `127.0.0.1` n'a pas de sens sur un téléphone, il faut l'adresse LAN de la machine qui héberge le serveur. La dernière URL saisie est mémorisée |

Le jeton, les enveloppes de clés et les documents chiffrés restent dans le `localStorage` de la WebView :
l'app est utilisable hors ligne, les mutations s'empilent et partent à la prochaine synchro.

Le serveur écoute sur `127.0.0.1:8787` par défaut : depuis un téléphone il doit être joignable sur le LAN,
donc lancer avec `LAVANDE_SYNC_BIND_ADDR=0.0.0.0:8787 cargo run` (et ouvrir le port 8787 dans le pare-feu).
Sans HTTPS, le TLS n'est pas exigé : l'enveloppe et les ops sont déjà chiffrées côté client.
