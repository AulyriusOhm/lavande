# Lavande — client mail (Rust + Tauri)

Client mail **PC + Android**, front en React/Vite/Tailwind, shell natif **Rust + Tauri v2**,
composants inspirés de [Magic UI](https://magicui.design/docs/components).

> **État actuel : maquette de design (mobile first) + coquille Android.** Aucun backend mail, aucune
> authentification mail : les données sont des fixtures dans `src/lib/mail.ts`. La **synchronisation
> E2EE de la planification** existe en revanche (serveur `server/` + client `src/lib/sync/`, protocole
> dans [`docs/SYNC.md`](./docs/SYNC.md), e2e `npm run e2e`).
>
> 🎨 **Intentions de design, palette, motion et arbitrages : [`DESIGN.md`](./DESIGN.md).**
>
> Deux maquettes navigables, mêmes fixtures et même design system : **mobile** sur `/lavande/`
> (cadre téléphone) et **PC** sur `/lavande/?desktop`. La coquille native **Android** reprend la
> maquette mobile en plein écran, toujours sans backend ([`docs/android.md`](./docs/android.md)).

## Implémentation (périmètre Mails)

Le moteur mail Rust existe : crate **`crates/mail-core`** (package `lavande-mail`, lib `lavande_mail`),
exposé en HTTP local par **`crates/mail-api`** (binaire `lavande-maild`). Le front s'y branche :
`src/lib/api.ts` + `src/lib/mail-backend.ts`, écran de connexion, dossiers et fils réels, flags,
déplacement et envoi. Le mode maquette reste disponible (`VITE_MAIL_BACKEND=demo`). Contrat HTTP,
schéma SQLite, correspondance des types et limites détaillées :
**[`docs/mail-core.md`](./docs/mail-core.md)**.

### Lancer l'app avec le backend

```bash
scripts/mail-service.sh start   # démon local sur 127.0.0.1:8790 (données : ~/.local/share/lavande)
scripts/dev-web.sh start        # maquette servie sur le portail (équivaut à npm run dev:portal)
npm run dev                     # ou en direct : http://localhost:1420/
```

### APK Android

La coquille Tauri **embarque le démon mail** : le routeur `lavande-mail-api` est monté dans le
processus de l'app (écoute `127.0.0.1:8790`, données dans le stockage privé de l'app), donc un seul
processus, aucun sidecar. Le front vise cette base dès qu'il tourne dans la coquille.

```bash
npm run android:build           # release arm64 signé → artifacts/apk/Lavande.apk
npm run android:build:debug     # debug universel (inspecteur WebView, plus lent)
adb install -r artifacts/apk/Lavande.apk
```

Le build passe par `scripts/build-android-release.sh` (voir aussi `docs/android.md`) : clé de
signature dans `~/.android/lavande-release.jks`, jamais versionnée, sinon les mises à jour de l'app
seront refusées par Android.

Le portail sert l'app sous `/lavande/` : il faut `npm run dev:portal` (base `/lavande/`), sinon Vite
renvoie l'index avec des chemins absolus et la page reste blanche (`404` sur `/src/main.tsx`).

### Bureau Linux (RPM)

La même coquille, en paquet Fedora/RHEL : le binaire embarque le démon mail, comme l'APK. La vue PC
s'ouvre directement au lancement (pas de `?desktop` à ajouter).

```bash
npx tauri build --bundles rpm   # → src-tauri/target/release/bundle/rpm/Lavande-0.1.0-1.x86_64.rpm
```

Il faut `build-essential`, `pkg-config`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev` et `rpm` (`rpmbuild`). Sur une machine qui n'a pas ces
paquets et pas de `sudo`, la même commande tourne dans un conteneur Debian avec le dépôt monté en
lecture seule.



Première ouverture : l'écran de connexion demande libellé, adresse, identifiant, hôtes/ports IMAP et
SMTP, chiffrement (TLS implicite ou STARTTLS) et mot de passe. Le serveur **teste la connexion avant
d'enregistrer** quoi que ce soit. Sans démon joignable, un bandeau explique comment le démarrer et
propose la démo.

Pour un fournisseur qui n'accepte plus le mot de passe (Gmail, Outlook/Hotmail), le bouton
**Google / Microsoft** demande un consentement OAuth2 : il ouvre le navigateur du système (plugin
`opener` dans la coquille Tauri, `window.open` côté web), et un lien de secours s'affiche dans la
carte si l'ouverture est bloquée. Le `client_id` d'application est le seul prérequis :

- **livré dans les paquets** : `.env.production` porte l'identifiant Microsoft de Lavande
  (`VITE_OAUTH_CLIENT_ID`), donc `npm run android:build` et `npx tauri build` le figent dans le bundle ;
  le champ et le guide disparaissent de l'écran de connexion, l'utilisateur clique simplement
  **Microsoft** ; pour livrer un autre identifiant, surchargez la variable au build ;
- **sinon**, le champ du formulaire l'accepte (ou `LAVANDE_MAIL_MICROSOFT_CLIENT_ID` /
  `LAVANDE_MAIL_GOOGLE_CLIENT_ID` côté démon), et l'app affiche les étapes d'inscription avec l'adresse
  de retour à copier — voir [`docs/mail-core.md`](./docs/mail-core.md#oauth2-apioauth).

Un `client_id` public (PKCE) n'est pas un secret : il est visible sur l'écran de consentement, c'est
l'identité de l'application. Seul le `refresh_token` reste dans le démon.

Pour essayer sans vraie boîte : `scripts/mail-test-server.sh start`, puis connecte
`roman@lavande.test` / `secret` en IMAP `localhost:3993`, SMTP `localhost:3465`, TLS implicite — le
démon doit faire confiance au certificat de test :

```bash
LAVANDE_MAIL_EXTRA_ROOTS=$HOME/.cache/lavande/mail-test/cert.pem scripts/mail-service.sh restart
```


```
crates/mail-core/
├── Cargo.toml            # lavande-mail / lib lavande_mail
├── src/
│   ├── model.rs          # Message, Thread, Folder, Flags, AttachmentMeta, PgpState
│   ├── config.rs         # AccountConfig, AuthConfig, Endpoint, Encryption, FolderMapping
│   ├── mime.rs           # parsing RFC 5322 / MIME, aperçu, pièces jointes
│   ├── threading.rs      # thread_id déterministe (References → In-Reply-To → sujet)
│   ├── store/mod.rs      # Store SQLite (+ store/schema.sql embarqué)
│   ├── imap.rs           # TLS/STARTTLS, dossiers, réconciliation, flags, move
│   ├── smtp.rs           # envoi (lettre), pièces jointes
│   ├── oauth.rs          # refresh token + XOAUTH2
│   ├── sync.rs           # sync_account (INBOX + Sent)
│   └── tls.rs            # racines de confiance supplémentaires
└── tests/                # config, mime, threading, oauth, store (hors-ligne) · live (réseau)
```

### Tests hors-ligne

Sur cette machine il n'y a **pas de compilateur C système** (`rusqlite`/`ring` en ont besoin) : on
passe par le `cc` local avant de lancer cargo.

```bash
export PATH=/home/roman/.local/opt/lavande-cc:$PATH
export CC=/home/roman/.local/opt/lavande-cc/cc
export CXX=/home/roman/.local/opt/lavande-cc/c++

npm run mail:test          # cargo test -p lavande-mail          (44 tests, aucun réseau)
npm run mail:fmt           # cargo fmt --all -- --check
npm run mail:clippy        # cargo clippy -p lavande-mail --all-targets -- -D warnings
```

### Tests réseau (GreenMail)

9 scénarios réels (TLS implicite, envoi SMTP puis sync, flags poussés puis rapatriés depuis un autre
client, message expurgé côté serveur, dossier inchangé, déplacement INBOX → Archive avec UID
réattribué, réponse qui rejoint son thread, XOAUTH2), ignorés par défaut par `cargo test`.

```bash
scripts/mail-test-server.sh start     # conteneur lavande-mail-test, certificat auto-signé
npm run mail:test:live                # 11 tests, --test-threads=1 obligatoire
scripts/mail-test-server.sh stop      # ou `reset` (stop + start), `status`
```

### Limites (courte liste)

- STARTTLS non testé : seul le TLS implicite est validé (GreenMail ne l'annonce pas).
- Réconciliation, pas de CONDSTORE/QRESYNC : chaque synchro fait une passe métadonnées complète du
  dossier (coût linéaire en nombre de messages, comme Thunderbird sans CONDSTORE) ; les corps ne sont
  tirés que pour les nouveaux UID, par lots de 500.
- Push via IMAP **IDLE sur INBOX** (SSE vers le front) : un mail arrive sans clic ; les autres
  dossiers restent à la demande.
- Suppression définitive poussée vers le serveur (`STORE \Deleted` + `UID EXPUNGE`) : `/delete` et
  `/purge` côté démon. Sans `UIDPLUS`, supprimer **un** message est refusé (l'`EXPUNGE` disponible
  emporterait ceux qu'un autre client a marqués) ; vider un dossier reste un `EXPUNGE` dossier-wide
  assumé et `removed` en rapporte le compte côté serveur.
- Un seul dossier synchronisé par appel (`move_message` réconcilie en plus sa destination) ;
  `sync_account` couvre tous les dossiers à rôle (inbox, sent, drafts, archive, spam, trash) ; aucun retry réseau.
- HTML des mails assaini à l'ingestion (liens sûrs, **images retirées**) ; les mails purement
  graphiques sont donc plus sobres que dans leur client d'origine.
- OAuth2 fonctionnel mais **sans identifiant d'application embarqué** : il faut enregistrer un
  `client_id` (Google/Microsoft) ou le fournir au service ; seul le parcours de test est validé.
- Pas de pool de connexions. **PGP réel** (trousseau, signature/chiffrement) et **recherche serveur** sont implémentés — voir « PGP & rédaction » ci-dessous. Les secrets ont un trousseau.
- Le démon écoute **127.0.0.1 uniquement** et exige un **jeton Bearer** (`daemon-token`, 0600) : sans
  lui, 401. Le proxy Vite/nginx et la coquille Tauri l'injectent ; ne l'expose pas hors loopback.
- Les mots de passe IMAP/SMTP et jetons OAuth2 ne sont **plus en clair dans `accounts.json`** :
  trousseau système (desktop Linux) ou fichier chiffré XChaCha20-Poly1305 (Android/headless), tous deux
  0600. Détails et migration : [`docs/mail-core.md`](./docs/mail-core.md#stockage-des-secrets).

### PGP & rédaction

- **PGP réel** (crate `pgp`, pur Rust) : trousseau de clés (génération, import, export, suppression) via
  `/api/pgp/keys`. Les clés **privées** vivent dans le store de secrets (trousseau système / fichier chiffré),
  les publiques dans un keyring 0600 ; l'export ne renvoie jamais le privé. À l'envoi, `pgp_sign` / `pgp_encrypt`
  signent puis chiffrent (RFC 3156), clés appariées par email ; à la réception, le démon déchiffre et vérifie,
  et expose `pgp_detail` (vérifié / signataire / erreur) affiché en badge à la lecture. Routes derrière le jeton.
- **Signatures HTML par compte** : éditeur dédié + aperçu dans les réglages, activation/désactivation, toggle par
  message ; ajoutées automatiquement à l'envoi (multipart texte + HTML).
- **Éditeur riche** (TipTap) à la composition : gras/italique/titres/listes/citation/code/liens, **raccourcis
  Markdown** à la frappe et collage Markdown→HTML. Le HTML est assaini à l'envoi comme à la lecture (ammonia).
- **Recherche serveur** (`/api/accounts/{id}/search`) sur tous les dossiers, et **synchro automatique** à la
  première visite d'un dossier. Les clés PGP générées ont une **expiration** (2 ans par défaut).

### Pièces jointes, notifications & IA

- **Pièces jointes** : envoi depuis la composition (picker, chips, limite 24 Mo) ; téléchargement à la lecture via
  un endpoint qui re-fetch la partie MIME par IMAP (`…/messages/{uid}/attachments/{idx}`). Les bytes ne sont pas
  stockés localement (métadonnées seulement).
- **Notifications desktop** (plugin Tauri) à l'arrivée d'un mail (IDLE), uniquement si la fenêtre n'a pas le focus ;
  **badge non-lus** dans le titre de la fenêtre.
- **Images des mails HTML** : masquées par défaut (anti-tracking) ; bandeau « Afficher les images » par message,
  re-fetch + assainissement à la demande (http/https uniquement, jamais de script). Aucun pixel persisté.
- **Assist IA** : suggestions de réponse et réécriture via un modèle compatible OpenAI, configurable dans les
  réglages (endpoint / modèle / clé). Sans configuration, repli sur des propositions locales.
- **Synchro CONDSTORE** : détection de capacité + repli sûr sur la passe complète ; le chemin incrémentiel est
  opt-in (`LAVANDE_MAIL_CONDSTORE=1`) tant qu'il n'a pas été validé sur un vrai serveur. IDLE sur INBOX ; les
  autres dossiers se synchronisent à la demande.

## Dépôt

- Gitea : **https://git.lanro.eu/Roman/lavande** (branche `main`)
- ⚠️ Le WAF en frontal bloque git-over-HTTPS : `/.git/info/refs` renvoie **403 « Accès refusé »**
  (constaté aussi sur les autres dépôts, sans et avec authentification). Depuis le LAN/WireGuard, on
  pousse donc sur l'instance directe :

  ```bash
  git remote set-url origin http://192.168.5.121:3555/Roman/lavande.git
  git push origin main
  ```

## Nom

Le nom de marque suit le thème : **Lavande** en clair, **Orchidée** en sombre
(`useTheme().brand`, exposé par `src/lib/theme.tsx`). L'identifiant technique reste
`lavande` partout (package, crate, bundle).

## Stack

| Couche | Choix |
| --- | --- |
| Shell natif | Rust + Tauri v2 (desktop + mobile) |
| UI | React 19 + TypeScript + Vite 7 |
| Styles | Tailwind CSS v4 (`@theme inline`, tokens CSS) |
| Animations | `motion` (ex-Framer Motion) |
| Icônes | `lucide-react` |
| Synchronisation planification | serveur Rust `server/` (axum + PostgreSQL, zéro connaissance) + client `src/lib/sync/` (`@noble/*`), E2EE |

## Démarrer

```bash
npm install
npm run dev        # http://0.0.0.0:1420
npm run build      # typecheck + build
```

## Écrans

| Onglet / vue | Contenu |
| --- | --- |
| **Boîte** | boîte unifiée, sélecteur de comptes, badges PGP, filtres (non lus / étoilés / chiffrés), résumé du matin **repliable au scroll** |
| **Agenda** | mois + jour, événements issus d'un mail, participants |
| **Planif.** | tâches multi-états (À faire · En cours · En attente · À valider · Fait) : filtre par état, tri par échéance, case à cocher, changement d'état au tap, **en-tête qui s'efface au scroll** + barre compacte, suggestions issues des mails, détail de tâche avec mail lié |
| **Réglages** | comptes, couleur d'accent, sécurité (PGP), **serveurs MCP**, apparence |
| Comptes (feuille) | Tous les comptes / Perso / Studio / Gmail, non-lus, ajout de compte |
| Message | bandeau PGP (chiffré / signature vérifiée), pièces jointes |
| Compose | bascule Chiffré / Signé, signature, pièces jointes |
| PGP (vue poussée) | clé secrète + empreinte, chiffrement/signature par défaut, clés destinataires, alerte d'expiration |
| MCP (vue poussée) | serveurs (stdio/http), outils exposés par portée, journal des appels |
| Recherche (overlay) | recherche multi-comptes, contacts fréquents |

Navigation : swipe horizontal entre les 4 onglets (Boîte · Agenda · Planif. · Réglages) + dock
flottant. La recherche est un overlay ouvert depuis l'en-tête de la boîte ; PGP, **MCP** et Comptes
sont des vues poussées / feuilles depuis les réglages.

### En-tête repliable (boîte de réception)

**Animation d'entrée, pas de scroll** : la vue complète (avatar + titre, sélecteur de compte, carte
« Résumé du matin ») reste affichée **2 s** (`INTRO_HOLD_MS`), puis se replie sur ~0,9 s :

- le héros tombe à une hauteur 0 (opacité 0 à 45 %, `scale 0.96`) ;
- un espace de 52 px apparaît pour réserver la place de la barre ;
- la carte **Résumé du matin** ne disparaît pas : elle se réduit à **50 px** et affiche une
  pastille cliquable `Résumé du matin · 3 à traiter` (8 px sous la barre) ;
- la **barre glass** (avatar, titre, compte · non-lus, chevron, recherche, sélecteur) apparaît en haut.

Le dépliage est **manuel et stable** : la pastille (ou le chevron de la barre) redéploie l'en-tête
et le résumé, qui **restent ouverts** — plus de repli automatique. Le chevron `^` en haut à droite
de la carte replit quand on veut.

Les mails remontent alors sous la pastille, sans zone morte. Hauteurs mesurées (`offsetHeight`,
remesurées au `resize`). `prefers-reduced-motion` → tout est déjà replié au chargement.

Le bloc « LAVANDE / roman@lavande.mail » a été retiré : le titre est à côté de l'avatar, le nom,
le compte et les non-lus sont dans la puce de compte et dans la barre.

## Maquette PC (`?desktop`)

La même application en géométrie bureau : `/lavande/?desktop`, le mobile restant sur `/lavande/`.
L'application packagée suit la coquille : **le bureau (RPM) ouvre directement la vue PC**, Android ouvre
le plein écran mobile (`src/lib/native.ts`, `resolveShell`). Dans un navigateur, `/lavande/` garde la
maquette mobile encadrée et `?desktop` force la vue PC.
Mêmes fixtures, même store (`src/lib/store.tsx`), mêmes règles d'annulation — seule la mise en page change.

| Zone | Choix PC |
| --- | --- |
| Navigation | **dock flottant** comme sur mobile : 4 destinations + action contextuelle (Écrire / RDV / Tâche), recherche `⌘K` |
| Boîte | **3 colonnes** : comptes + dossiers (248 px) · fils (420 px) · lecteur large. Résumé du matin en carte pleine largeur, actions au survol, fil antérieur déplié, actions du message dans une barre d'outils (aucune pastille flottante) |
| Agenda | grille du mois **navigable** qui remplit la hauteur (précédent / suivant / Aujourd'hui) + colonne du jour de 440 px, événements liés aux mails, création avec détection de conflit |
| Planif. | **kanban 5 colonnes** avec glisser-déposer, bandeau de suggestions issues des mails, panneau de tâche éditable (sous-tâches, mail lié, suppression annulable) |
| Réglages | sections desktop : comptes, apparence (accent + aperçu), modules, PGP, serveurs MCP, à propos. Les gestes tactiles ne sont pas exposés sur PC |
| Recherche | overlay global `⌘K` : recherches récentes, contacts fréquents, résultats multi-comptes |
| Rédaction | fenêtre flottante en bas à droite qui réutilise l'écran de rédaction mobile (assistants, PGP, pièces jointes) ; brouillon minimisable |

Le dock reste la seule navigation permanente : aucun rail fixe, le contenu passe dessous.
Les actions de ligne (archiver, supprimer, étoiler, lu / non lu) apparaissent au survol à la place
des gestes tactiles ; les préférences de gestes restent dans les réglages, marquées « tactile ».

Chaque vue est adressable : `?desktop#inbox`, `#calendar`, `#planning`, `#settings`.
`⌘K` / `Ctrl+K` ouvre la recherche, `Échap` ferme la couche supérieure (recherche, dialogue,
panneau de tâche, message). Les deux maquettes partagent `src/lib/store.tsx` et `src/lib/*` :
archivage, annulations, tâches, rendez-vous et brouillons se comportent à l'identique.

## APK Android

La maquette mobile tourne aussi en coquille **Tauri v2** : plein écran, sans cadre téléphone ni barre
de statut factice (`NativeShell` dans `src/App.tsx`). Toujours sans backend, mêmes fixtures.

| Étape | Commande |
| --- | --- |
| Environnement (JDK 21, SDK, NDK) | `source scripts/android-env.sh` |
| Projet Gradle | `npm run android:init` |
| **APK de production** (release, arm64, signé) | `npm run android:build` |
| APK de débogage (inspecteur WebView, **lent**) | `npm run android:build:debug` |

APK : `artifacts/apk/Lavande.apk`, installation `adb install -r`. Le build release n'est pas cosmétique :
en debug, la WebView active l'inspecteur V8 et le rendu devient saccadé sur téléphone.

Le rendu natif s'aperçoit aussi dans un navigateur avec `?app` :
`https://plasma.int.lanro.eu:8443/lavande/?app`.

Prérequis détaillés, `scripts/patch-android.mjs` (insets, thème, icône) et limites connues :
[`docs/android.md`](./docs/android.md).

## Design system

- Fond **blanc lavande** (`--canvas: #fbfaff`), surfaces blanches, encre violet-noir.
- Accent par défaut **violet lavande** `#8b7cf6`.
- La **couleur secondaire est personnalisable** : palette de préréglages + sélecteur libre
  (Réglages → Couleur d'accent), persistée en `localStorage`.
- Tout dérive de variables CSS : `--accent`, `--accent-soft`, `--accent-ring`, `--accent-ink`
  (calculées avec `color-mix`) et `--accent-contrast` (texte clair/sombre garantissant au moins 4,5:1).
- Mode sombre complet via la classe `.dark` sur `<html>`.

Tokens dans `src/index.css`, provider dans `src/lib/theme.tsx`.

## Composants Magic UI portés

| Composant | Fichier | Usage |
| --- | --- | --- |
| `ShimmerButton` | `ui/shimmer-button.tsx` | Répondre / Envoyer |
| `BorderBeam` | `ui/border-beam.tsx` | Carte « Résumé du matin » |
| `BlurFade` | `ui/blur-fade.tsx` | Apparition des listes et sections |
| `AnimatedGradientText` | `ui/animated-text.tsx` | Titres, pied de page |
| `ShinyText` | `ui/animated-text.tsx` | Hint de recherche |
| `NumberTicker` | `ui/number-ticker.tsx` | Compteur de non-lus |
| `Dock` | `components/dock.tsx` | Dock flottant + compose |
| `DotPattern` / `MeshGlow` | `ui/backdrops.tsx` | Fonds |

## Navigation

Swipe horizontal entre les 4 onglets (`#inbox`, `#calendar`, `#planning`, `#settings`)
+ dock flottant. La recherche, les messages et la rédaction sont des overlays animés ; les réponses
+ préremplissent le message et le brouillon peut être réduit puis repris sans perte.

## Accès

- **`https://plasma.int.lanro.eu:8443/lavande/`** — maquette mobile, TLS valide
  (wildcard `*.int.lanro.eu`), DNS interne déjà en place. Portail des projets sur `/`.
- **`https://plasma.int.lanro.eu:8443/lavande/?desktop`** — maquette PC.
- `https://10.1.50.10:8443/lavande/` — même service si le nom ne résout pas.
- `http://10.1.50.10:1420/lavande/` — dev server Vite direct, sans TLS.
- Tout reste sur le LAN, rien n'est exposé vers l'extérieur. Le portail est le conteneur
  `dev-proxy` (`deploy/dev-proxy.sh`), un `location` par projet.

## Aperçus

`design/` contient les captures des écrans : boîte de réception, message, compose,
recherche, réglages, mode sombre avec accent rose, et la vue bureau (cadre téléphone).

## Prochaines étapes (hors design)

1. Installer le toolchain : `apt install build-essential libwebkit2gtk-4.1-dev` (sudo requis)
   puis `npm run tauri dev`.
2. Android : `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`,
   SDK + NDK Android, `npm run tauri android init`.
3. Backend mail Rust : IMAP/SMTP (`async-imap`, `lettre`), store local chiffré (SQLite + SQLCipher),
   OAuth2 (Gmail/Outlook) — la synchronisation de la planification est déjà en place (`server/`, `docs/SYNC.md`).
