# Tester l'application Android — mémo pour agents

Ce fichier décrit comment **construire, installer et vérifier** la coquille Android sur cette
machine (le « serveur »), sans redécouvrir l'environnement. Il vit sur la branche Android
(`plan/88bcc3bb`) : les scripts qu'il cite y sont — sur une autre branche, récupérez-les avec
`git checkout plan/88bcc3bb -- scripts/ src-tauri/Cargo.toml src-tauri/tauri.conf.json src/lib/native.ts`
ou fusionnez la branche.

## 1. Ce qui est déjà installé ici

| Élément | Emplacement |
| --- | --- |
| JDK 21 Temurin (aucun paquet système) | `~/.local/share/jdk-21` |
| SDK Android | `~/Android/Sdk` (platforms 35/36, build-tools 36/37, `platforms;android-37.0` téléchargé par Gradle) |
| NDK | `~/Android/Sdk/ndk/28.2.13676358` |
| Cibles rustup Android | `aarch64`, `armv7`, `i686`, `x86_64` |
| Compilateur C hôte | `cc` système ; sinon le script fabrique un `cc` sans sudo (clang du NDK + `libgcc` extraits) |
| Émulateur + AVD | `~/Android/Sdk/emulator`, AVD `lavande` (API 35, `google_apis`, x86_64) |
| Bibliothèques X11 de l'émulateur | extraites dans `~/.local/emulibs` **et copiées** dans `~/Android/Sdk/emulator/lib64/` |
| KVM | `roman` est dans le groupe `kvm`, mais les shells ne l'ont pas : préfixer par `sg kvm -c "…"` |
| Clé de signature release | `~/.android/lavande-release.jks` (alias `lavande`, mot de passe `lavande`) |
| APK x86_64 pour l'émulateur | `~/lavande-apks/Lavande-x86_64-release.apk` |

Toute la chaîne d'environnement vient d'un seul fichier : `source scripts/android-env.sh`.

## 2. Construire l'APK

```bash
source scripts/android-env.sh
npm run android:init     # une seule fois : tauri android init + scripts/patch-android.mjs
npm run android:build    # release arm64 signé → dist/android/Lavande.apk
```

- `scripts/build-android-release.sh` enchaîne : patch, `tauri android build --apk -t aarch64`,
  `zipalign`, `apksigner verify`. Rien à faire à la main.
- **Le build release n'est pas cosmétique** : en debug, la WebView active l'inspecteur V8 et
  l'application est saccadée sur téléphone. Ne jamais juger la fluidité sur un build debug.
- `npm run android:build:debug` existe uniquement pour avoir les DevTools (voir §4).
- Pour l'émulateur (x86_64), il faut une variante :

```bash
source scripts/android-env.sh
./node_modules/.bin/tauri android build --apk -t x86_64
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
$BT/zipalign -p -f 4 src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk /tmp/a.apk
$BT/apksigner sign --ks ~/.android/lavande-release.jks --ks-pass pass:lavande --key-pass pass:lavande \
  --ks-key-alias lavande --out ~/lavande-apks/Lavande-x86_64-release.apk /tmp/a.apk
```

Pièges de build :

- le build lance `npm run build`, donc **`dist/` est vidé** — ne stockez pas d'APK dedans sans le recopier ;
- sans `-t`, les 4 ABI sont embarquées : 470 Mo en debug. `-t aarch64` + `strip` → 8 Mo ;
- la clé release diffère de la clé debug d'Android : un appareil qui a un build debug doit
  désinstaller avant d'installer un release.

## 3. Installer sur un téléphone

```bash
source scripts/android-env.sh
adb install -r dist/android/Lavande.apk
```

## 4. Tester sur l'émulateur (headless)

```bash
source scripts/android-env.sh
sg kvm -c "$ANDROID_HOME/emulator/emulator -avd lavande -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu swiftshader_indirect -memory 2048 -cores 2"
```

- démarrage ~150 s ; attendre `adb shell getprop sys.boot_completed` = `1` ;
- `adb shell dumpsys webviewupdate` donne le moteur réel (l'image API 35 embarque Chromium 124) ;
- **`adb exec-out screencap` rend du noir** avec `-gpu swiftshader_indirect` en headless, même pour
  l'écran d'accueil : ce n'est pas un bug de l'app. Utiliser le protocole DevTools ci-dessous.

### Captures et mesures via DevTools

Les DevTools ne sont exposés que par un APK **debug** (Tauri ne les active pas en release) :

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n mail.lavande.app/.MainActivity
PID=$(adb shell pidof mail.lavande.app | tr -d '\r')
adb forward tcp:9333 localabstract:webview_devtools_remote_$PID   # 9222 est déjà pris sur cette machine
curl -s http://127.0.0.1:9333/json/version        # doit renvoyer Android-Package: mail.lavande.app
curl -s http://127.0.0.1:9333/json/list           # url: http://tauri.localhost/
```

Piloter la page avec `puppeteer-core` (déjà dans `node_modules` du dépôt) :

```js
const puppeteer = require("/home/roman/Développement/lavande/node_modules/puppeteer-core");
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const page = (await browser.pages()).find((p) => p.url().includes("tauri.localhost"));
await page.screenshot({ path: "/tmp/shot.png" });          // capture du rendu WebView
await page.touchscreen.tap(x, y);                          // simule un vrai tap
console.log(await page.metrics());                         // LayoutCount, RecalcStyleCount, TaskDuration…
```

### Ce qu'il faut vérifier

| Point | Attendu |
| --- | --- |
| Mode natif | `.native-shell` présent, `padding-top` = `44px` (`--native-top`) |
| Changement d'onglet | **un seul** tap : `[aria-current="true"]` change et le strip passe à `-100 %`, `-200 %`… |
| Écrans hors champ | `document.querySelectorAll("[data-offscreen]").length` = 0 |
| Rendu de la maquette | `getComputedStyle(.glass).backdropFilter` = `blur(20px) saturate(1.8)` |
| Police | `document.fonts.check('600 16px "Plus Jakarta Sans"')` = `true` |
| Page blanche | capture pendant la transition : l'écran sortant doit rester peint |
| Coût par interaction | `page.metrics()` : layout en ms, pas de thrashing |

Utile aussi : `adb shell dumpsys gfxinfo mail.lavande.app`, `adb logcat -d | grep -iE "chromium|FATAL"`.

## 5. Tester la version web (maquettes)

```bash
npm run dev                    # port 1420 — souvent déjà pris par un autre worktree
./node_modules/.bin/vite --port 1421   # dans ce cas
```

- `/` maquette mobile (cadre téléphone), `?desktop` maquette PC, `?app` coquille native dans un navigateur ;
- déployé : `https://plasma.int.lanro.eu:8443/lavande/` (et `?desktop`, `?app`).

## 6. Pièges déjà payés — ne pas les refaire

| Piège | Dégât |
| --- | --- |
| Juger la fluidité sur un build **debug** | saccades permanentes ; croire que le code est en cause |
| `content-visibility: hidden` sur les écrans hors champ | page blanche intermittente au changement d'onglet (l'écran sortant est masqué pendant les 420 ms de glissement) |
| Écrire `strip.style.transform` dans un `requestAnimationFrame` | fermeture périmée → l'ancien onglet réapparaît → il faut deux taps |
| `unzip` sur cette machine | c'est un **wrapper qui extrait** dans le dossier courant, même avec `-l` : utiliser `python3 -c "import zipfile…"` pour lister |
| `adb exec-out screencap` en headless swiftshader | image noire, même sur le launcher |
| APK release pour les DevTools | aucun socket `webview_devtools_remote_*` : il faut un build debug |
| `platforms;android-37.0` | nommage par version mineure ; laisser Gradle le télécharger (licences déjà acceptées) |
