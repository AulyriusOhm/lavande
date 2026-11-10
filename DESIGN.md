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
| `--ink-muted` | `#726c7f` | `#8c8699` |
| `--line` | `#ece8f5` | `#2a2438` |

Et trois dérivés de l'accent, calculés par `color-mix` (jamais stockés) :

```css
--accent:      #8b7cf6                  /* la couleur choisie par l'utilisateur */
--accent-soft: accent 12 % sur blanc    /* fonds de badges, cartes, pastilles */
--accent-ring: accent 34 % sur blanc    /* bordures, focus, contours */
--accent-ink:  accent 58 % vers l'encre /* texte accentué, lisible sur --accent-soft */
--accent-contrast: clair ou sombre, contraste ≥ 4,5:1 sur --accent
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

**Sur PC, la même grammaire, une autre géométrie.** Le dock flottant reste la seule navigation
permanente, mais les vues s'ouvrent en largeur : la boîte tient en trois colonnes (comptes et
dossiers · fils · lecteur), la planification devient un kanban à cinq colonnes, l'agenda remplit la
hauteur avec la navigation de mois et une colonne de jour, la rédaction devient une fenêtre flottante.
Rien n'est dupliqué côté données : les deux maquettes partagent `src/lib/store.tsx`, donc archivage,
annulations, tâches, rendez-vous et brouillons sont identiques.

**Sur Android, la maquette devient l'app.** Le cadre téléphone et la fausse barre de statut disparaissent
(`NativeShell` dans `src/App.tsx`) : la même UI occupe l'écran. En haut, une marge **fixe** de 44 px — la
hauteur d'une barre de statut ou d'une encoche change trop d'une marque à l'autre pour être mesurée. En bas,
les tokens `--safe-bottom` et `--ime-bottom` (défaut `0px`) remplacent `env(safe-area-inset-*)`, que la
WebView Android laisse à 0 : un pont Kotlin les remplit en px CSS, clavier compris. Les polices sont
embarquées (Plus Jakarta Sans, deux `@font-face` locaux, licence OFL) — aucune requête Google Fonts — et
l'icône est un monogramme L dans le dégradé de l'accent par défaut, pas un logo séparé.

Trois écarts assumés, dictés par l'espace disponible : les actions de ligne passent du geste au
survol ; le lecteur range ses actions dans une **barre d'outils pleine largeur** (jamais de pastille
flottante à côté du dock) ; le fil antérieur est **déplié par défaut** au lieu d'être une pile de
lignes repliées. Le résumé du matin y devient une carte pleine largeur du rail de lecture (phrase de
synthèse + trois actions), et les réglages de gestes tactiles ne sont pas exposés sur PC.

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

1. **`prefers-reduced-motion`** : l'interface démarre directement dans l'état replié et les animations
   d'apparition, de shimmer, de swipe et de navigation sont réduites ou supprimées.
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
lisent pas. Sur PC, les mêmes données s'affichent en **cinq colonnes** avec glisser-déposer. Les
**suggestions issues des mails** arrivent en bandeau au-dessus du kanban, avec le `+` à la place de
la case à cocher, l'objet du mail d'origine et l'échéance déduite — on ajoute une tâche d'un clic,
le panneau de détail s'ouvre d'un clic sur la carte.

C'est **la seule donnée qui quitte l'appareil**, donc c'est la seule qui affiche son état : une
**pastille dans l'en-tête**, à côté du compteur de tâches ouvertes — point coloré + un mot
(`À jour`, `3 en attente`, `Hors ligne`, `Lecture seule`, `Locale` si aucun compte n'est configuré).
Un tap mène aux réglages de synchronisation. Le point porte la couleur d'état (vert · ambre · rose),
le texte porte le nombre : on doit comprendre en un regard latéral si ce qu'on vient de cocher est
déjà parti ailleurs.

**Agenda** — grille du mois réellement calculée, sélection au tap, colonne horaire, badge « mail » quand
l'événement vient d'un message. Le rendez-vous se crée depuis le bouton flottant.

**Réglages** — l'accent se choisit en couleur **et** en aperçu ; les gestes (glisser à gauche / à
droite) se configurent par direction ; PGP et MCP sont des vues poussées, pas des onglets : ce sont des
réglages, pas des destinations quotidiennes. **Synchronisation** y vit aussi, en une seule carte d'état
(badge de phase, opérations en attente, dernière synchro, bouton manuel, interrupteur 30 s) suivie des
deux seuls formulaires qui existent : créer ou connecter un compte, appairer un appareil. Pas de
vocabulaire cryptographique à l'écran — « code d'appairage » et « empreinte » suffisent.

## 8. Décisions assumées

- **Pas de barre d'onglets pleine largeur** : le dock flottant laisse voir le contenu passer dessous.
- **Pas de barre latérale fixe sur PC** : le dock flottant reste la navigation, comme sur mobile ;
  seuls les comptes et dossiers de la boîte occupent une colonne, parce qu'ils font partie du contenu.
- **Une seule source de données pour deux maquettes** : l'état vit dans `src/lib/store.tsx`, pas dans
  les écrans. Une action (archiver, annuler, envoyer) se comporte pareil des deux côtés.
- **Le résumé IA n'est pas une carte permanente** : il se replie en pastille. Un encart fixe mangeait
  la moitié de l'écran — c'est le reproche qui a déclenché le repli.
- **MCP hors du dock** : c'est de l'infrastructure, pas un usage quotidien. Il vit dans les réglages.
- **Le texte d'explication est banni des en-têtes** : remplacé par des éléments actionnables
  (suggestions de mails). Un paragraphe qui décrit l'écran est un aveu d'échec de l'interface.
- **Fixtures réalistes** : noms, sujets, pièces jointes et états PGP crédibles — on ne juge pas un
  design sur du lorem ipsum.
- **Pas de bandeau de synchronisation** : un bandeau permanent vole une ligne de contenu et un bandeau
  conditionnel clignote ; une pastille dans l'en-tête de la seule vue concernée suffit, et le détail
  reste dans les réglages. Pas de spinner plein écran non plus : la mutation est **optimiste**, l'état
  se voit, le réseau se rattrape en arrière-plan.
- **Une synchronisation qui ne se raconte pas** : aucun écran ne parle de clés, d'enveloppes ou d'horloge
  logique. Ce qui est chiffré de bout en bout se dit une fois, dans les réglages, en une phrase.

## 9. Limites connues (maquette)

- Aucune donnée mail réelle : les messages sont des fixtures en mémoire. Thème, accent, préférences de
  gestes **et documents de planification** persistent en `localStorage` ; le brouillon est conservé
  pendant la session.
- La planification se synchronise vraiment (serveur `server/`, chiffré de bout en bout), mais il faut
  un serveur joignable : sans compte configuré la pastille affiche `Locale` et tout reste sur l'appareil.
  Les conflits se résolvent au dernier écrivain par champ — deux appareils hors ligne qui modifient le
  même champ gardent la modification la plus récente, l'autre est perdue sans dialogue.
- La vue bureau existe (`?desktop`) mais reste une maquette : hors `⌘K` et `Échap`, pas de raccourcis
  clavier, pas de colonnes redimensionnables, pas de glisser-déposer de fichiers.
- Les actions destructrices proposent une annulation temporaire, sans persistance après rechargement.
- Pas d'états vides soignés partout, pas de mode hors-ligne, pas d'internationalisation.

## 10. Suite

1. Affiner la vue bureau : raccourcis clavier (j/k, archiver, répondre), colonnes ajustables.
2. Valider sur appareils réels les safe areas, le clavier, les tailles de texte et les cibles ≥ 44 px.
3. Brancher les vraies données mail (IMAP/OAuth) puis remplacer les fixtures sans toucher aux composants.
4. Persister les brouillons et les annulations, et compléter les annonces `aria-live` des changements d'état.
5. Donner un état vide et une explication à `read_only` (client plus ancien que le serveur) : aujourd'hui
   la pastille le signale, mais rien n'indique quoi faire.
