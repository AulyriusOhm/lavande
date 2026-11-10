# Lavande — client mail (Rust + Tauri)

Client mail **PC + Android**, front en React/Vite/Tailwind, shell natif **Rust + Tauri v2**,
composants inspirés de [Magic UI](https://magicui.design/docs/components).

> **État actuel : maquette de design (mobile first).** Aucun backend mail, aucune
> authentification : les données sont des fixtures dans `src/lib/mail.ts`.
>
> 🎨 **Intentions de design, palette, motion et arbitrages : [`DESIGN.md`](./DESIGN.md).**
>
> Deux maquettes navigables, mêmes fixtures et même design system : **mobile** sur `/lavande/`
> (cadre téléphone) et **PC** sur `/lavande/?desktop`.

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
npm run dev:portal              # portail https://…:8443/lavande/  (base /lavande/)
npm run dev                     # ou en direct : http://localhost:1420/
```

Le portail sert l'app sous `/lavande/` : il faut `npm run dev:portal` (base `/lavande/`), sinon Vite
renvoie l'index avec des chemins absolus et la page reste blanche (`404` sur `/src/main.tsx`).


Première ouverture : l'écran de connexion demande libellé, adresse, identifiant, hôtes/ports IMAP et
SMTP, chiffrement (TLS implicite ou STARTTLS) et mot de passe. Le serveur **teste la connexion avant
d'enregistrer** quoi que ce soit. Sans démon joignable, un bandeau explique comment le démarrer et
propose la démo.

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
npm run mail:test:live                # 9 tests, --test-threads=1 obligatoire
scripts/mail-test-server.sh stop      # ou `reset` (stop + start), `status`
```

### Limites (courte liste)

- STARTTLS non testé : seul le TLS implicite est validé (GreenMail ne l'annonce pas).
- Réconciliation, pas de CONDSTORE/QRESYNC : chaque synchro fait une passe métadonnées complète du
  dossier (coût linéaire en nombre de messages, comme Thunderbird sans CONDSTORE) ; les corps ne sont
  tirés que pour les nouveaux UID, par lots de 500.
- Pas d'IDLE/push : la synchro est toujours déclenchée par l'appelant (à la demande ou par polling).
- Aucune suppression poussée vers le serveur : le crate supprime localement et déplace, mais n'expose
  pas `STORE \Deleted` + `EXPUNGE` côté client.
- Un seul dossier synchronisé par appel (`move_message` réconcilie en plus sa destination) ;
  `sync_account` ne fait que INBOX + Sent ; aucun retry réseau.
- Ni pool de connexions, ni keychain, ni PGP réel, ni flux navigateur OAuth2, ni recherche serveur.
- Le démon écoute **127.0.0.1 uniquement** et n'a aucune authentification : quiconque atteint le port
  pilote les comptes. Ne l'expose pas hors loopback sans mettre une authentification devant.
- Les mots de passe IMAP/SMTP sont stockés en clair dans `~/.local/share/lavande/accounts.json`
  (permissions 0600) : pas encore de trousseau système.

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
3. Backend Rust : IMAP/SMTP (`async-imap`, `lettre`), store local chiffré (SQLite + SQLCipher),
   OAuth2 (Gmail/Outlook).
