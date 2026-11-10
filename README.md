# Lavande — client mail (Rust + Tauri)

Client mail **PC + Android**, front en React/Vite/Tailwind, shell natif **Rust + Tauri v2**,
composants inspirés de [Magic UI](https://magicui.design/docs/components).

> **État actuel : maquette de design (mobile first).** Aucun backend mail, aucune
> authentification : les données sont des fixtures dans `src/lib/mail.ts`.
>
> 🎨 **Intentions de design, palette, motion et arbitrages : [`DESIGN.md`](./DESIGN.md).**

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

## Design system

- Fond **blanc lavande** (`--canvas: #fbfaff`), surfaces blanches, encre violet-noir.
- Accent par défaut **violet lavande** `#8b7cf6`.
- La **couleur secondaire est personnalisable** : palette de préréglages + sélecteur libre
  (Réglages → Couleur d'accent), persistée en `localStorage`.
- Tout dérive de variables CSS : `--accent`, `--accent-soft`, `--accent-ring`, `--accent-ink`
  (calculées avec `color-mix`, donc jamais de teintes codées en dur dans les composants).
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

Swipe horizontal entre les 3 onglets (`#inbox`, `#search`, `#settings` — deep-link par hash)
+ dock flottant. Les écrans message et compose sont des overlays animés.

## Accès

- **`https://plasma.int.lanro.eu:8443/lavande/`** — TLS valide (wildcard `*.int.lanro.eu`),
  DNS interne déjà en place. Portail des projets sur `/`.
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
