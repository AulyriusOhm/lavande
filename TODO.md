# TODO — Lavande

Liste des évolutions et correctifs à faire. Les numéros `#n` correspondent à la todo de session.
Décisions actées avec Roman le 11/11/2026 :

- **Anti-spam** (#3) : approche **hybride** (en-têtes serveur + règles locales configurables).
- **Calendriers externes** (#11) : **CalDAV + Google Calendar (OAuth) + ICS** ; choix du périmètre par compte.
- **PGP** (#12) : **interrupteur manuel par compte** (Activé/Désactivé), comme les signatures, sans automatisme.
- **Droits MCP** (#8) : **approbation par action sensible** + « toujours autoriser » par type + journal.
- **Lisibilité** (#13) : **audit visuel UI** (contrastes, tailles, troncatures, débordements) puis corrections.
- **Maquette** (#5, #10) : un **verrou build « distribution »** unique retire données factices et aperçu maquette.

Décisions actées avec Roman le 12/11/2026 :

- **Anti-spam** (#3) : **pas d'implémentation à la va-vite** — une vraie phase de recherche est requise avant (en-têtes serveur, moteurs de règles, bayésien, Rspamd/SpamAssassin, apprentissage). Garé en attendant.
- **Lisibilité** (#13) : audit + correctifs livrés, carte blanche sur les arbitrages (reflow PC responsive, palier 11px méta dense / contenu ≥12,5px, encre de compte calculée, jetons `--sync-*`, `--accent-ink` 52%, compteurs `bg-ink/10`).
- **Clavier** : actions sur le mail sélectionné — **Suppr nu** (supprimer), Ctrl+E (archiver), Ctrl+Shift+S/U/R/F (étoile/lu/répondre/transférer) + menu « Raccourcis clavier » dans les réglages.

## État d'avancement (12/11/2026)

**Livrés et vérifiés** (tests + builds, un commit par tâche) :
- #1 navigation clavier de mail en mail · #4 agenda PC responsive · #2 rendu HTML fidèle (iframe sandbox + sanitizer CSS sûr).
- #5 + #10 verrou distribution · #9 MCP exclu du build Android · #8 droits MCP (approbation + journal réel).
- #12 PGP par compte (front + démon : trousseau effectif, purge des corps déchirés, bandeau lecteur).
- #13 audit lisibilité + correctifs (contrastes WCAG, reflow, étiquette de compte, placeholders, cibles tactiles).
- Hors todo initiale : citations de réponse (retours à la ligne), images collées dans le corps (inline CID), raccourcis clavier d'actions + menu réglages, doc distribution (README/UPDATER/android/mail-core).

**Restent à faire** :
- #3 anti-spam (phase de recherche d'abord) · #6 graphisme PC agenda/planif (maquettes à valider) · #7 rangement des réglages (plan à valider) · #11 calendriers externes (OAuth Google à fournir) · #14 parapluie sécurité (audit autonome ; Keystore Android + trousseau système + signature paquets avec Roman).
- Hors todo : auto-updater (hébergement endpoint, sauvegarde clé, 1ʳᵉ release, AppImage, test E2E) · Android insets sur appareil physique + CI.
- Suivis mineurs : `htmlToText` avale les URL `<https://…>` dans les aperçus texte ; relecture locale des images inline CID dans Envoyés ; scénario live IMAP du gate PGP ; 2 chaînes démo cosmétiques sous verrou.

---

## Navigation & rendu des mails

### #1 — Naviguer de mail en mail au clavier
Refonte de la navigation clavier : flèches ↑/↓ pour se déplacer de mail en mail dans la liste,
Entrée pour ouvrir, Échap pour fermer/revenir (j/k en bonus vim). S'appuyer sur le module
`src/lib/app-shortcuts.ts` (commité) plutôt qu'un système parallèle ; gérer le focus liste/panneau de lecture.

### #2 — Afficher correctement les mails HTML
Rendu fidèle des mails contenant du HTML. À concevoir : iframe sandbox (scripts interdits), sanitisation,
images distantes bloquées par défaut avec bouton « afficher les images » (anti-tracking/phishing),
adaptation au thème sombre.

## Correctifs

### #4 — Corriger l'agenda PC au redimensionnement
L'agenda sur PC supporte mal le redimensionnement de la fenêtre ; le bouton « Nouveau rendez-vous »
apparaît en doublon selon la largeur. Diagnostiquer les deux rendus (header/toolbar) et corriger le layout responsive.

## Production / distribution

### #5 — Purger les données de maquette des builds production
Finir le retrait des éléments générés pour la maquette sur les versions de production : RDV factices dans
l'agenda et tâches factices dans la planification. Les fixtures mails (`src/lib/mail.ts`) sont déjà partiellement
traitées (commit `7d23a43`) — vérifier et compléter agenda + planification. Verrou build « distribution » commun avec #10.

### #10 — Masquer l'aperçu maquette des versions distribuées
Enlever la possibilité d'avoir l'aperçu de la maquette sur les versions distribuées : entrée « Aperçu de la
maquette mobile » (`src/desktop/settings.tsx:1437`) + branding maquette (`src/App.tsx`). Même verrou build que #5.

### #9 — Retirer le support MCP de la version mobile
Supprimer le support MCP sur mobile : exclure le code MCP (`src/lib/mcp.ts` + prefs + UI réglages) du build
Android, pas seulement le masquer. Gate par plateforme au build.

## Sécurité & droits

### #8 — Affiner les droits MCP avec approbation in-app
Approbation par action sensible : lecture libre ; chaque écriture (envoi, suppression, déplacement, création de
RDV…) déclenche une demande de permission dans l'app, avec « toujours autoriser » par type d'action. Étendre
l'existant (`mcpConfirmSend` + `mcpEnabled` par serveur dans `src/lib/prefs.tsx`, `src/lib/mcp.ts`) + journal des
actions MCP consultable dans l'app.

### #12 — Ajouter l'interrupteur PGP par compte
Interrupteur manuel par compte (Activé / Désactivé), sur le modèle des signatures par compte, sans automatisme.
Réglage dans les paramètres du compte, appliqué à la composition (signer/chiffrer) et à la réception (déchiffrer).

### #14 — Sécuriser comptes et code des versions distribuées
Audit sécurité + correctifs sur les versions distribuées. **Comptes** : stockage des secrets (trousseau système /
fichier chiffré, Keystore matériel Android reste à faire — `docs/mail-core.md`), jetons OAuth, aucun secret dans les
logs. **Code distribué** : pas d'endpoints ni flags de debug, pas de source maps, pas de maquette (verrou #5/#10),
surface MCP réduite (#8/#9), paquets signés (RPM/AppImage/APK), audit des dépendances (`cargo audit`, `npm audit`).
Parapluie sécurité à placer en fin de parcours, une fois #5/#8/#9/#10 faits.

## Fonctionnalités

### #3 — Implémenter le filtre anti-spam hybride configurable
Approche hybride : exploiter les verdicts serveur (`X-Spam-Status`/`Score`) quand présents, sinon moteur local de
règles + score configurable (domaines, expéditeurs, mots-clés). Entièrement configurable dans l'app : seuils, liste
blanche/noire, action vers Indésirables, apprentissage depuis les déplacements manuels. Restent à concevoir :
emplacement du moteur (démon Rust vs front) et UI de configuration.

### #11 — Synchroniser des calendriers externes sans compte mail
CalDAV générique (Zimbra, Nextcloud, iCloud…) en lecture/écriture + Google Calendar via OAuth + abonnements ICS en
lecture seule. Ajout possible sans compte mail associé. À l'ajout d'un compte mail : choix du périmètre synchronisé
(mails / agenda / contacts), éditable ensuite dans les réglages du compte.

## UI / réglages

### #6 — Affiner le graphisme PC de l'agenda et de la planification
Refonte graphique de détails sur la version PC dans Agenda et Planification. À détailler avec l'utilisateur
(maquettes/preview) avant implémentation ; s'aligner sur `DESIGN.md`.

### #7 — Réorganiser les réglages
Rangement de l'écran Réglages (`src/desktop/settings.tsx`, ~1400+ lignes) : audit des sections actuelles,
regroupement logique (Comptes / Apparence / Synchronisation / Sécurité-PGP / IA / MCP / À propos), hiérarchisation.
Proposer un plan de rangement à l'utilisateur avant de casser l'existant.

### #13 — Auditer et corriger la lisibilité des textes
Audit visuel de lisibilité sur toute l'app (PC + mobile) : contrastes insuffisants, corps de texte trop petits,
libellés tronqués, débordements, textes qui se chevauchent au redimensionnement — puis corriger. S'appuyer sur
`DESIGN.md` comme référence (tailles, couleurs). Complémentaire de #4 (agenda au resize) et #6 (refonte graphique PC).

---

## Ordre d'attaque suggéré
1. Correctifs rapides + verrou distribution : **#4, #5, #10, #9**
2. Clavier + rendu HTML : **#1, #2**
3. Gros morceaux : **#3, #8, #11, #12**
4. Refonte graphique + réglages (allers-retours maquette) : **#6, #7, #13**
5. Parapluie sécurité en dernier : **#14**

## Reste à faire hors todo (doc existante)
- **Auto-updater** (`docs/UPDATER.md`) : héberger l'endpoint, sauvegarder la clé privée, publier une première
  release, construire l'AppImage, tester le flux E2E, confirmer les prérequis RPM.
- **Android** (`docs/android.md`) : valider les insets sur appareil physique, build release signé (+ `--split-per-abi`), CI.