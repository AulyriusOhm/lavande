# Lavande / Orchidée — intentions de design

Document de référence du design : ce qu'on cherche à produire, pourquoi, et les règles
qu'on s'impose pour que la maquette reste cohérente quand on la fera vivre.

> Maquette de design uniquement (aucun backend mail). Les données sont des fixtures.

---

## 1. L'intention

**Un client mail qu'on a envie d'ouvrir.** Les clients mail sont des outils de travail ingrats :
listes denses, gris partout, hiérarchie faible. Lavande part du principe inverse — une interface
**calme, lavée de violet**, où l'information importante (qui parle, de quoi, à faire) ressort par
la couleur et le mouvement plutôt que par la densité.

Trois convictions guident le reste :

1. **Le mail n'est pas une fin, c'est une tâche en puissance.** D'où les suggestions de mails à
   transformer en tâches, le mail lié dans une tâche, et l'agenda qui accepte ce qui vient d'un mail.
2. **La couleur appartient à l'utilisateur.** Le violet lavande n'est qu'un point de départ : l'accent
   est une variable, pas une décision de designer. Tout (boutons, badges, halos, focus) en dérive.
3. **Le mouvement explique, il ne décore pas.** Chaque animation répond à « d'où ça vient, où ça va » :
   l'en-tête qui se replie libère de la place, le swipe révèle l'action avant de l'exécuter, le dock
   qui se referme sur les réglages annonce qu'il n'y a rien à créer ici.

## 2. Une marque qui change avec le thème

| Thème | Nom affiché | Fond | Accent par défaut |
| --- | --- | --- | --- |
| Clair | **Lavande** | `#fbfaff` (blanc lavé) | `#8b7cf6` (violet lavande) |
| Sombre | **Orchidée** | `#0e0c13` (nuit violacée) | identique |

Le nom technique reste `lavande` partout (package, crate, bundle, URL) ; seule la marque affichée
bascule (`useTheme().brand`). L'idée : un seul produit, deux atmosphères — la fleur qui devient plus
sombre la nuit.

## 3. Design system

### Couleurs sémantiques, pas littérales

Aucun composant ne code une teinte en dur. On manipule des **rôles** :

| Rôle | Clair | Sombre |
| --- | --- | --- |
| `--canvas` | `#fbfaff` | `#0e0c13` |
| `--surface` | `#ffffff` | `#16131f` |
| `--surface-2` | `#f6f3fd` | `#1d1929` |
| `--ink` | `#1b1523` | `#f4f1fa` |
| `--ink-soft` | `#6b6478` | `#a8a1b8` |
| `--ink-muted` | `#a49db0` | `#726b80` |
| `--line` | `#ece8f5` | `#2a2438` |

Et trois dérivés de l'accent, calculés par `color-mix` (jamais stockés) :

```css
--accent:      #8b7cf6                  /* la couleur choisie par l'utilisateur */
--accent-soft: accent 12 % sur blanc    /* fonds de badges, cartes, pastilles */
--accent-ring: accent 34 % sur blanc    /* bordures, focus, contours */
--accent-ink:  accent 58 % vers l'encre /* texte accentué, lisible sur --accent-soft */
```

**Pourquoi** : changer l'accent en une variable met à jour toute l'application sans repasser sur les
composants, et les 9 préréglages + le sélecteur libre tiennent en quelques lignes. C'est aussi ce qui
rend le mode sombre gratuit — seuls les rôles changent, pas les composants.

Deux accents secondaires subsistent, volontairement **fixes** car porteurs de sens et non de marque :
le **vert** (signature PGP valide, tâche faite, succès) et le **rouge/ambre** (retard, danger,
avertissement). Un accent utilisateur ne doit jamais pouvoir signifier « erreur ».

### Typographie

- **Plus Jakarta Sans** (300–800), seule famille. Géométrique, un peu ronde : elle porte le côté
  « doux » sans tomber dans le gadget.
- Échelle volontairement resserrée : 10,5 px (labels majuscules), 12,5 px (méta), 13,5 px (corps),
  22–27 px (titres), 800 en graisse sur les titres avec un `letter-spacing` négatif (−0,035 em) pour
  obtenir des titres compacts et affirmés.
- Aucune capitale décorative hors micro-labels : les libellés d'état sont en casse normale.

### Rayons, ombres, profondeur

- Grille de rayons généreuse : 22 px (lignes de mail), 26–32 px (cartes et feuilles), cercle plein
  pour les pastilles. Rien en dessous de 12 px : les angles droits sont réservés aux séparateurs.
- **Pas d'ombre portée neutre.** Les ombres sont teintées de l'accent (`shadow-[..._var(--accent)]`)
  ou très diffuses : une profondeur colorée, jamais grise.
- Le **glass** (fond translucide + `backdrop-blur`) est réservé à ce qui flotte : dock, barre compacte.

## 4. Iconographie et composants

- **Lucide** en trait 1,9 px au repos, 2,4 px actif. L'épaisseur est un signal d'état.
- Composants inspirés de **Magic UI**, réécrits à la main (pas de dépendance CLI) : `ShimmerButton`,
  `BorderBeam`, `BlurFade`, `AnimatedGradientText`, `ShinyText`, `NumberTicker`, `Dock`,
  `DotPattern`/`MeshGlow`. Chacun est utilisé **une poignée de fois** : un faisceau qui tourne sur
  chaque carte ne signalerait plus rien.
- Le `BorderBeam` ne marque que les éléments « vivants » : résumé IA, carte de suggestions.

## 5. Architecture de l'information

**4 onglets, un dock flottant, trois niveaux de profondeur.**

| Niveau | Mécanisme | Exemples |
| --- | --- | --- |
| Onglets | swipe horizontal + dock | Boîte · Agenda · Planif. · Réglages |
| Vues poussées | glissement depuis la droite | message, détail de tâche, PGP, MCP |
| Feuilles | montée depuis le bas | compose, comptes, dossiers, changement d'état, nouveau RDV/tâche |

**Pourquoi ce découpage** : sur un téléphone, un seul axe de navigation principal (les onglets) et deux
gestes secondaires (push/feuille) suffisent. La recherche, autrefois onglet, est devenue un overlay :
elle ne mérite pas une place permanente dans le dock, alors que « Planification » la mérite.

**Le dock est contextuel** : il crée ce qui a du sens là où on est — un message dans la boîte, un
rendez-vous dans l'agenda, une tâche dans la planification, **rien** dans les réglages (le dock se
referme alors en largeur, avec un ressort).

## 6. Le mouvement, règle par règle

| Situation | Animation | Intention |
| --- | --- | --- |
| Chargement de la boîte | en-tête complet 2 s, puis repli sur ~0,9 s (hauteur mesurée → 0, opacité, `scale 0.96`) | montrer qui on est, puis libérer l'écran pour les mails |
| Carte résumé | se réduit à 50 px, contenu remplacé par une pastille cliquable | l'information reste accessible sans occuper la place |
| Scroll (boîte, planification) | barre compacte en glass qui apparaît en fondu | garder le contexte et les actions quand le titre s'efface |
| Listes | `BlurFade` décalé de 40–50 ms par ligne | lire l'ordre d'arrivée, pas un bloc |
| Onglets | glissement avec résistance aux extrémités, ressort 420/34 | le bord se sent, on ne « sort » pas de l'app |
| Poussées | ressort 340/34 | latéralité = hiérarchie |
| Feuilles | montée depuis le bas, fond assombri + flou 2 px | modalité claire, retour au contexte évident |
| Gestes de ligne | révélation progressive, seuil 64 px, retour ressort | montrer l'action **avant** de l'exécuter |
| Dock contextuel | largeur `auto → 0` + opacité | dire « il n'y a rien à créer ici » |

Trois garde-fous :

1. **`prefers-reduced-motion`** : l'interface démarre directement dans l'état replié.
2. **Rien ne bouge sans raison** : pas de parallaxe, pas de particules, pas de rebond décoratif.
3. **Le geste ne se bat jamais avec un autre** : les zones marquées `data-swipe` sont ignorées par le
   gestionnaire de swipe d'onglets, et le scroll vertical est préservé (`touch-pan-y`).

## 7. Les écrans, et ce qu'ils cherchent à dire

**Boîte de réception** — l'identité du compte (couleur + nom) est portée par une **étiquette** dans la
ligne, pas par un liseré coloré (essayé, jugé « moche ») ni par l'avatar (essayé, jugeait au compte
plutôt qu'à l'expéditeur). L'avatar reste coloré **par expéditeur**, pour scanner une liste en diagonale.
Les badges PGP (cadenas / bouclier) sont dans le même alignement que l'heure : l'information de
confiance ne mérite pas une ligne.

**Message** — un bandeau discret explique le chiffrement ou la signature *avant* le corps : on doit
savoir dans quoi on lit avant de lire.

**Compose** — deux pastilles « Chiffré » / « Signé » visibles dès la rédaction, pas cachées dans un menu.

**Planification** — le modèle a **5 états** (À faire · En cours · En attente · À valider · Fait), mais
l'affichage mobile est une **liste filtrée par état**, pas un kanban : trois colonnes sur 390 px ne se
lisent pas. Sur PC, les mêmes données s'affichent en colonnes. Les **suggestions issues des mails**
arrivent en tête de liste, avec le `+` à la place de la case à cocher, l'objet du mail d'origine et
l'échéance déduite — on ajoute une tâche d'un tap, on ouvre le détail d'un tap sur la ligne.

**Agenda** — grille du mois réellement calculée, sélection au tap, colonne horaire, badge « mail » quand
l'événement vient d'un message. Le rendez-vous se crée depuis le bouton flottant.

**Réglages** — l'accent se choisit en couleur **et** en aperçu ; les gestes (glisser à gauche / à
droite) se configurent par direction ; PGP et MCP sont des vues poussées, pas des onglets : ce sont des
réglages, pas des destinations quotidiennes.

## 8. Décisions assumées

- **Pas de barre d'onglets pleine largeur** : le dock flottant laisse voir le contenu passer dessous.
- **Le résumé IA n'est pas une carte permanente** : il se replie en pastille. Un encart fixe mangeait
  la moitié de l'écran — c'est le reproche qui a déclenché le repli.
- **MCP hors du dock** : c'est de l'infrastructure, pas un usage quotidien. Il vit dans les réglages.
- **Le texte d'explication est banni des en-têtes** : remplacé par des éléments actionnables
  (suggestions de mails). Un paragraphe qui décrit l'écran est un aveu d'échec de l'interface.
- **Fixtures réalistes** : noms, sujets, pièces jointes et états PGP crédibles — on ne juge pas un
  design sur du lorem ipsum.

## 9. Limites connues (maquette)

- Aucune donnée réelle : tout est en mémoire, l'état repart au rechargement (sauf thème, accent et
  préférences de gestes, persistés en `localStorage`).
- Pas de vue bureau (2 colonnes liste + lecteur) : le cadre téléphone est un choix de présentation.
- Les actions destructrices (supprimer, archiver) ne sont pas annulables.
- Pas d'états vides soignés partout, pas de mode hors-ligne, pas d'internationalisation.

## 10. Suite

1. Vue bureau/tablette (liste + lecteur, colonnes du kanban).
2. Passe d'accessibilité : contrastes AA sur `--ink-muted` (particulièrement en sombre), focus
   visibles, tailles de cible ≥ 44 px.
3. Brancher les vraies données (IMAP/OAuth) puis remplacer les fixtures sans toucher aux composants.
4. Undo sur les gestes destructeurs, et un vrai `aria-live` pour les changements d'état.
