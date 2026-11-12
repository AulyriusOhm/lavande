# Site vitrine de Lavande

Site statique autonome (HTML + CSS + JS vanilla, aucune dépendance externe, aucun build) pour
**https://lavande.lanro.eu/** — la racine du domaine. L'endpoint de mise à jour `/updates/` est
servi à côté et **ne fait pas partie de ce dossier**.

## Contenu

```
site-vitrine/
├── index.html                      # page unique : hero, fonctionnalités, flux mail→tâche,
│                                   # téléchargement, sécurité, pied de page
└── assets/
    ├── css/style.css               # design system (tokens DESIGN.md), thèmes clair/sombre,
    │                               # responsive, animations sobres
    ├── js/theme-init.js            # applique le thème avant le premier rendu (pas de flash)
    ├── js/main.js                  # bascule de thème persistée, en-tête au scroll,
    │                               # apparitions au défilement, année du pied de page
    ├── fonts/plus-jakarta-sans-*.woff2   # Plus Jakarta Sans (OFL, voir OFL.txt)
    ├── fonts/OFL.txt               # licence de la police
    └── img/favicon.svg             # monogramme L dans le dégradé de l'accent
```

Aucune requête réseau : polices, icônes (sprite SVG inline), visuels (CSS/SVG) et scripts sont
locaux. Les seuls liens sortants sont la documentation et le code source (GitHub/Gitea de
l'instance) ; ils ne sont jamais chargés, seulement suivis au clic.

## Ouvrir en local

```bash
python3 -m http.server 8080 --directory site-vitrine
# http://localhost:8080/
```

`index.html` s'ouvre aussi directement (`file://`) : la mise en page et les scripts fonctionnent,
la police embarquée est alors remplacée par la police système du navigateur (restriction CORS des
navigateurs sur les polices en `file://`). Servir en HTTP donne le rendu exact.

## Déployer avec nginx

Le site est prévu pour être servi **à la racine** : les cinq liens de téléchargement sont absolus
(`/updates/…`). Deux montages possibles.

### A. Déposer le site dans le docroot existant

`/updates/` est déjà servi par le même serveur : on copie le site à côté, sans toucher au dossier
des mises à jour.

```bash
rsync -a --exclude updates site-vitrine/ /srv/www/lavande/
# /srv/www/lavande/index.html, /srv/www/lavande/assets/…
# /srv/www/lavande/updates/  ← inchangé
```

### B. Racine dédiée + alias pour /updates/

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name lavande.lanro.eu;

    root /srv/www/lavande;          # contenu de site-vitrine/
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

    # Cache long pour les assets versionnés par leur contenu.
    location ~* \.(?:css|js|svg|woff2)$ {
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    # En-têtes utiles, sans effet sur le fonctionnement du site.
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

### Vérifier après déploiement

```bash
curl -sI https://lavande.lanro.eu/ | head -1          # 200
curl -sI https://lavande.lanro.eu/assets/css/style.css | head -1
curl -s  https://lavande.lanro.eu/updates/latest.json | head -c 80
```

## Câbler les téléchargements

Les liens pointent tous vers `/updates/…` (dossier public de l'updater). Ils fonctionneront dès que
les fichiers y seront publiés ; les noms doivent correspondre aux artefacts produits par
`scripts/release-updater.mjs` (voir `docs/UPDATER.md`).

| Lien dans `index.html` | Fichier attendu dans `/updates/` |
| --- | --- |
| ligne 463 | `Lavande_0.2.0_amd64.AppImage.tar.gz` |
| ligne 481 | `Lavande-0.2.0-1.x86_64.rpm` |
| ligne 498 | `Lavande.apk` |
| lignes 515-516, 627 | `latest.json`, `lavande-release.asc` |

Pour une nouvelle version : remplacer `0.2.0` aux lignes 439 (texte « Version 0.2.0 »), 462-463
(AppImage), 480-481 (RPM). Le reste du site ne dépend pas du numéro de version.

## Thème, langue, accessibilité

- Deux thèmes complets (`data-theme="dark"` par défaut, `light`), bascule persistée en
  `localStorage` (`lavande.site.theme`), sinon préférence système `prefers-color-scheme`.
- Tokens de couleur repris de `DESIGN.md` (`--canvas`, `--surface`, `--ink`, `--accent` dérivé en
  `--accent-soft` / `--accent-ring` / `--accent-ink` par `color-mix`).
- `lang="fr"`, lien d'évitement, landmarks, focus visible, `aria-pressed` sur la bascule de thème,
  `role="img"` sur l'aperçu, contrastes ≥ 4,5:1 (texte) et ≥ 4,89:1 (bouton principal).
- `prefers-reduced-motion` : apparitions et animations désactivées, contenu immédiatement visible.
- Sans JavaScript, tout le contenu reste affiché (les apparitions ne sont activées que par
  `main.js`).

## Police

Plus Jakarta Sans, sous SIL Open Font License 1.1 — licence complète dans
`assets/fonts/OFL.txt`. Les fichiers sont ceux de l'application (`public/maquettes/fonts/`).
