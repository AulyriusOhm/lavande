# Mises à jour de l'application de bureau

Lavande embarque `tauri-plugin-updater` : l'app interroge un manifeste public,
télécharge le paquet signé correspondant à son installation, vérifie la
signature minisign, installe puis redémarre. Android n'est pas concerné (l'APK
se réinstalle à la main) : le plugin n'est utilisé que dans la coquille de
bureau.

## Clés

| Quoi | Où | Versionné |
| --- | --- | --- |
| Clé privée (signe les releases) | `.tauri/lavande-updater.key` | **non** (`.gitignore` : `.tauri/*.key`) |
| Clé publique correspondante | `.tauri/lavande-updater.key.pub` | oui (référence) |
| Clé publique utilisée par l'app | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | oui |

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
    "endpoints": ["https://lavande.mail/updates/latest.json"],
    "requireSignedVersion": true
  }
}
```

- Par défaut : `https://lavande.mail/updates/latest.json` (à héberger : un
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

## Publier une release

1. Incrémenter la version dans `src-tauri/tauri.conf.json` (le manifeste la
   reprend) et `package.json`.
2. Construire les paquets : `npm run tauri build -- --bundles rpm,appimage`
   (en conteneur, le montage `/src:ro → /work` utilisé pour
   `lavande-rpm-builder` fonctionne à l'identique ; l'AppImage demande
   `linuxdeploy`/`appimtool`, téléchargés par le bundler).
3. Générer le manifeste et signer :

```bash
npm run release:updater -- --notes "Correctifs de synchronisation"
# ou, en une fois, build + signature :
node scripts/release-updater.mjs --build --notes "…"
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
- écrit `artifacts/updater/latest.json` et copie les `.sig`.

4. Déposer dans le dossier public **tous** les fichiers listés par le script :
   `latest.json`, les paquets et leurs `.sig`. Rien d'autre n'est nécessaire ;
   l'app compare sa version à `version` et télécharge l'entrée
   `linux-x86_64-rpm` / `linux-x86_64-appimage` / `linux-x86_64`.

Exemple de manifeste :

```json
{
  "version": "0.2.0",
  "notes": "Correctifs de synchronisation",
  "pub_date": "2026-11-11T19:30:27.057Z",
  "platforms": {
    "linux-x86_64-rpm": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6…",
      "url": "https://lavande.mail/updates/Lavande-0.2.0-1.x86_64.rpm"
    },
    "linux-x86_64-appimage": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6…",
      "url": "https://lavande.mail/updates/Lavande_0.2.0_amd64.AppImage.tar.gz"
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
  être publié avec une version supérieure et une signature RPM valide si la
  politique du poste l'exige.
- **AppImage** : mise à jour en place du fichier `.AppImage` ; c'est le format
  le plus fiable pour l'auto-update Linux.
- **Android** : pas d'auto-update Tauri ; l'APK reste manuel
  (`scripts/build-android-release.sh`).
- `bundle.createUpdaterArtifacts` reste `false` : un `tauri build` sans clé
  continue de fonctionner (build RPM du conteneur inclus) ; c'est le script de
  release qui signe. Si on préfère la signature automatique du bundler, passer
  l'option à `true` **et** fournir `TAURI_SIGNING_PRIVATE_KEY` à chaque build,
  sinon le build échoue.
- Aucune limite de débit ni authentification côté serveur : le manifeste est
  public, les paquets sont signés.

## Ce qui manque pour activer l'auto-updater (à faire)

Le code est en place, mais **aucune mise à jour ne peut encore être distribuée**
tant que les points ci-dessous ne sont pas faits :

1. **Héberger l'endpoint.** `https://lavande.mail/updates/` n'existe pas. Choisir
   un hébergement (serveur statique HTTPS, ou releases Gitea/GitHub — voir
   « Endpoint »), y déposer les fichiers, et au besoin mettre à jour
   `plugins.updater.endpoints` dans `src-tauri/tauri.conf.json`.
2. **Sauvegarder la clé privée.** `.tauri/lavande-updater.key` n'est que sur ce
   poste. La copier dans un gestionnaire de secrets / une sauvegarde chiffrée.
   Perdue = chaîne de mise à jour cassée (il faudra republier un installeur complet).
3. **Publier une première release.** Incrémenter la version (`tauri.conf.json` +
   `package.json`, ex. 0.1.0 → 0.2.0), construire les paquets, lancer
   `npm run release:updater -- --notes "…"`, puis déposer `latest.json` + paquets +
   `.sig` sur l'endpoint. Sans une version supérieure publiée, l'app restera « à jour ».
4. **Construire l'AppImage.** Le build actuel ne produit que le RPM. L'AppImage est
   le format le plus fiable pour l'auto-update Linux (mise à jour en place). Le
   bundler télécharge `linuxdeploy`/`appimagetool` (réseau requis au build).
5. **Tester le flux de bout en bout.** Vérifier avec une vraie mise à jour hébergée :
   détection → téléchargement → vérification de signature → installation →
   redémarrage. Pas encore fait.
6. **Prérequis d'installation RPM.** Le poste cible doit avoir polkit (`pkexec`) ou
   `sudo` pour `rpm -U`. À confirmer sur la machine de l'utilisateur ; sinon
   privilégier l'AppImage.
7. **(Optionnel) Vérification au démarrage.** Aujourd'hui la vérification silencieuse
   n'a lieu qu'à l'ouverture des Réglages (1×/session). On peut ajouter une
   vérification au lancement + notification si une mise à jour est disponible.
