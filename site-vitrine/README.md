# Site vitrine de Lavande

Application **Vite + React + TypeScript + Tailwind v4** (une page, ancres) servie à la racine de
**https://lavande.lanro.eu/**, avec une **démo live en lecture seule** de l'application embarquée
dans une iframe same-origin (`/demo/`). L'endpoint de mise à jour `/updates/` est servi à côté et
**ne fait pas partie de ce dossier**.

## Structure

```
site-vitrine/
├── index.html                       # entrée Vite : métadonnées FR, script inline anti-flash du thème
├── package.json / tsconfig.json     # projet autonome (npm install local) — strict, alias @/ → src/
├── vite.config.ts                   # @vitejs/plugin-react + @tailwindcss/vite, outDir dist/
├── src/
│   ├── main.tsx                     # montage React (StrictMode)
│   ├── App.tsx                      # composition : header + 6 sections + footer, MotionConfig reducedMotion="user"
│   ├── styles.css                   # tokens Lavande (clair/sombre), halos + grain, polices locales,
│   │                                # keyframes Magic UI (marquee, shimmer, aurora, shiny)
│   ├── hooks/useTheme.ts            # thème persisté (lavande.site.theme) + clé démo (lavande.theme)
│   ├── lib/{utils,layout}.ts        # cn() (clsx + tailwind-merge), conteneurs/rythme de section
│   └── components/
│       ├── header.tsx               # header fixe, section active (IntersectionObserver), menu mobile
│       ├── hero.tsx                 # hero = démo d'abord, marquee des protocoles
│       ├── demo-stage.tsx           # iframe /demo/?desktop | ?app, toggle PC/téléphone, poster
│       ├── features.tsx             # BentoGrid (6 cartes, captures theme-aware)
│       ├── mobile-section.tsx       # 3 châssis téléphone (captures mobile)
│       ├── flow.tsx                 # 3 étapes mail → tâche → rendez-vous
│       ├── download.tsx             # RPM / DEB / AppImage / Windows / APK + signatures
│       ├── security.tsx             # 8 garanties (PGP, trousseau, IA, MCP, paquets signés…)
│       ├── footer.tsx
│       ├── icons.tsx                # sprite SVG inline (aucune icône distante)
│       ├── magicui/                 # composants Magic UI copiés (MIT, en-tête de licence conservé)
│       │   ├── bento-grid.tsx  bottom  border-beam.tsx  dot-pattern.tsx
│       │   ├── marquee.tsx  shimmer-button.tsx  animated-shiny-text.tsx  aurora-text.tsx
│       └── ui/                      # revealed au scroll, cadre d'écran mis à l'échelle, châssis phone,
│                                    # captures dark/light basculées en CSS, titres de section
└── public/
    ├── demo/                        # bundle démo lecture seule (gitignored, régénéré par script)
    ├── fonts/plus-jakarta-sans-*.woff2 + OFL.txt
    ├── shots/{pc,mobile}-*-{dark,light}.webp   # 16 captures réelles (PC 1600×1000, mobile 780×1688)
    └── favicon.svg
```

## Développer, construire, prévisualiser

```bash
cd site-vitrine
npm install          # dépendances locales au dossier
npm run dev          # http://localhost:5173 (sert aussi public/demo/)
npm run build        # tsc --noEmit puis vite build → site-vitrine/dist/
npm run preview      # sert dist/ sur http://localhost:4173
```

## Régénérer la démo embarquée (avant le build du site)

`public/demo/` est produit depuis les sources de l'application, jamais édité à la main :

```bash
bash scripts/build-vitrine-demo.sh     # depuis la racine du dépôt
cd site-vitrine && npm run build       # le build copie public/demo/ dans dist/demo/
```

L'ordre compte : le script écrit dans `site-vitrine/public/demo/`, que Vite recopie tel quel dans
`dist/`. Une release (`scripts/release.sh`) archive `site-vitrine/dist/`, donc la démo doit avoir
été régénérée **avant** le `npm run build` du site.

## Contraintes runtime (tenues)

- **Zéro requête réseau hors du domaine** : polices (`public/fonts/`), favicon, captures
  (`public/shots/`), icônes (SVG inline) et démo (`/demo/`) sont locaux. Aucun CDN, aucune police
  distante, aucun script tiers.
- **Démo same-origin en lecture seule** : iframe `/demo/?desktop` (PC) ou `/demo/?app` (téléphone),
  bandeau « Démo · lecture seule » fourni par le bundle, zéro mutation, zéro réseau.
- **Viewport logique fixe** : l'iframe fait toujours 1280×800 (PC) ou 390×844 (phone) et est mise à
  l'échelle par `transform: scale()` calculé au `ResizeObserver` — le layout interne de l'app ne
  casse jamais et les clics restent justes.
- **Thème synchrone** : le toggle écrit `lavande.site.theme` (site) et `lavande.theme` `{mode}`
  (clé partagée avec l'app dans l'iframe), puis recharge l'iframe ; le thème est appliqué avant le
  premier rendu par un script inline dans `index.html` (pas de flash), sombre par défaut.
- **Accessibilité** : `lang="fr"`, landmarks, lien d'évitement, `alt` français, `title` sur l'iframe,
  focus visible, `aria-pressed` sur les bascules, contrastes AA, `prefers-reduced-motion` respecté.

## Vérifier avant de publier

```bash
# depuis la racine du dépôt, après npm run build dans site-vitrine/
node scripts/check-vitrine-site.mjs
```

Le script sert `site-vitrine/dist/` en local et vérifie : toutes les requêtes sont same-origin,
zéro erreur console, thème sombre → clair persisté + captures basculées + iframe rechargée dans le
bon thème, bascule PC ↔ téléphone (`?desktop` / `?app`) avec bandeau de démo dans les deux modes,
ancres atterrissant sous le header, absence de débordement horizontal en 390 / 768 / 1440, liens de
téléchargement présents. Il écrit aussi `artifacts/vitrine-site-{dark,light,mobile}.png`.

## Déployer avec nginx

Le site est prévu pour être servi **à la racine** : les liens de téléchargement sont absolus
(`/updates/…`). `scripts/release.sh` produit `vitrine.tar.gz` à partir de `site-vitrine/dist/`.

```bash
# /updates/ est servi par le même serveur : on déploie le site à côté, sans y toucher.
tar -xzf vitrine.tar.gz -C /srv/www/lavande
# /srv/www/lavande/index.html, /srv/www/lavande/assets/…, /srv/www/lavande/demo/…
# /srv/www/lavande/updates/  ← inchangé (dossier séparé)
```

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name lavande.lanro.eu;

    root /srv/www/lavande;          # contenu de site-vitrine/dist/
    index index.html;
    charset utf-8;

    location / {
        try_files $uri $uri/ =404;
    }

    # Endpoint de l'auto-updater : dossier séparé, à ne pas modifier ici.
    location /updates/ {
        alias /srv/www/lavande-updates/;
        autoindex off;
        add_header Cache-Control "no-cache";
    }

    # Cache long pour les assets versionnés par leur contenu (Vite les hache).
    location ~* \.(?:css|js|svg|woff2|webp)$ {
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

Après déploiement :

```bash
curl -sI https://lavande.lanro.eu/ | head -1
curl -sI https://lavande.lanro.eu/demo/ | head -1
curl -s  https://lavande.lanro.eu/updates/latest.json | head -c 80
```

## Téléchargements (version 0.2.4)

| Lien | Fichier attendu dans `/updates/` |
| --- | --- |
| `src/components/download.tsx` | `Lavande_0.2.4_amd64.AppImage.tar.gz` (recommandé) |
| `src/components/download.tsx` | `Lavande-0.2.4-1.x86_64.rpm` |
| `src/components/download.tsx` | `Lavande_0.2.4_amd64.deb` |
| `src/components/download.tsx` | `Lavande_0.2.0_x64-setup.exe` |
| `src/components/download.tsx` / `mobile-section.tsx` | `Lavande.apk` |
| `src/components/download.tsx` / `footer.tsx` | `latest.json`, `lavande-release.asc` |

Pour une nouvelle version : mettre à jour le numéro dans `download.tsx` (texte « Version 0.2.4 »,
noms de fichiers et `href`). Le reste du site ne dépend pas du numéro.

## Composants Magic UI (MIT)

Copiés depuis `magicuidesign/magicui` (branche `main`, `apps/www/registry/magicui/`) puis adaptés :
`bento-grid`, `shimmer-button`, `border-beam`, `dot-pattern`, `marquee`, `animated-shiny-text`,
`aurora-text`. Adaptations : `framer-motion` → `motion/react`, icônes Radix → SVG inline, `cn` local
(`clsx` + `tailwind-merge`), utilitaires Tailwind v4 non disponibles remplacés par des styles
inline. Chaque fichier conserve son en-tête de licence et la mention de la source.

## Police

Plus Jakarta Sans, SIL Open Font License 1.1 — licence complète dans `public/fonts/OFL.txt`.
