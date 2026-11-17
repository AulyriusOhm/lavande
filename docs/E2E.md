# E2E web — l'app réelle contre le démon et GreenMail

Suite `npm run e2e:ui` (`scripts/e2e-ui.mjs`) : elle pilote l'app web **réelle** (mode api, pas la
démo) dans un chromium headless, contre un démon `lavande-maild` jetable et un GreenMail de test.
Aucun mock : les mails partent en SMTP réel, reviennent par IMAP réel, et les assertions croisent
l'interface et l'API du démon.

| Fichier | Rôle |
| --- | --- |
| `scripts/e2e-ui.mjs` | entrée : orchestration de l'infra, liste des scénarios, verdict final |
| `scripts/e2e/lib.mjs` | helpers : chromium, runner `ok`/`FAIL`, GreenMail, dossiers IMAP, démon, Vite, client API, seed, helpers API partagés (`accountId`, `folderThreads`, `messageBody`, `syncAccount`, `disablePgp`) |
| `scripts/e2e/desktop.mjs` | scénarios de la coquille PC (`/?desktop`, 1440×900) |
| `scripts/e2e/mobile.mjs` | scénarios de la coquille mobile (`/?app`, 390×844 tactile) |

## Architecture du harnais

```
scripts/e2e-ui.mjs
  │
  ├─ scripts/mail-test-server.sh reset ──► conteneur lavande-mail-test (greenmail/standalone)
  │     SMTP 3025 · IMAP 3143 (clair) · IMAPS 3993 · SMTPS 3465
  │     roman@lavande.test / secret  (+ bob@lavande.test / secret si LAVANDE_MAIL_TEST_USER2)
  │     CA auto-signé ~/.cache/lavande/mail-test/cert.pem
  │
  ├─ lavande-maild jetable ──► 127.0.0.1:8791
  │     LAVANDE_MAIL_DATA_DIR=$(mktemp -d)      base SQLite + accounts.json + daemon-token
  │     LAVANDE_MAIL_EXTRA_ROOTS=<cert.pem>     racine TLS GreenMail ajoutée au démon
  │     LAVANDE_MAIL_SECRETS=file               pas de trousseau système
  │     jeton lu dans <dataDir>/daemon-token (0600)
  │
  ├─ Vite (createServer) ──► 127.0.0.1:1422 (strictPort)
  │     MAIL_API=http://127.0.0.1:8791
  │     proxy /api → démon avec Authorization: Bearer <jeton>
  │     VITE_MAIL_BACKEND supprimé → mode api
  │
  └─ chromium headless (playwright-core)
        ├─ contexte PC 1440×900 ──► http://127.0.0.1:1422/?desktop
        │     page partagée par les scénarios de scripts/e2e/desktop.mjs
        └─ contexte mobile 390×844 tactile ──► http://127.0.0.1:1422/?app
              page dédiée aux scénarios de scripts/e2e/mobile.mjs (après le PC)
```

Le trajet d'un mail de test :

```
seed(subject, text)  →  POST /api/accounts/{id}/send  (Bearer, destinataire = soi-même)
                     →  SMTP GreenMail  →  INBOX GreenMail
UI « Synchroniser »  →  IMAP GreenMail  →  store SQLite du démon  →  liste + lecteur
assertions           →  DOM (Playwright) et GET /api/accounts/{id}/folders/{path}/threads
```

Le seed passe par le démon, pas par un client SMTP du harnais : le message est donc écrit par le
même chemin que l'envoi d'un utilisateur, et GreenMail le livre dans l'INBOX du compte.

## Isolation

| Ressource | Valeur E2E | Ce qui n'est jamais touché |
| --- | --- | --- |
| Données du démon | `mkdtemp` (`/tmp/lavande-e2e-*`), supprimé par `daemon.stop()` | `~/.local/share/lavande` |
| Démon | jetable sur `127.0.0.1:8791`, enfant du process node, `SIGTERM` puis `SIGKILL` | le démon réel sur `127.0.0.1:8790` |
| Vite | `127.0.0.1:1422`, `strictPort` | `npm run dev` (1420) |
| GreenMail | conteneur `lavande-mail-test`, recréé au début du run | — (le conteneur reste en marche après le run) |
| Cache Vite | `$TMPDIR/lavande-e2e-vite-cache` | `node_modules/.vite` |

Un port déjà pris fait échouer le run explicitement (`le port 8791 est déjà pris, refus de démarrer
le démon E2E` ; `strictPort` pour Vite) : un second run concurrent ou un `npm run dev` sur 1422 ne
peuvent pas se mélanger à la suite. GreenMail survit au run, ses messages sont effacés par le
`reset` du run suivant.

## Prérequis

| Prérequis | Détail |
| --- | --- |
| `docker` | conteneur `lavande-mail-test`, image `greenmail/standalone:latest`, géré par `scripts/mail-test-server.sh` |
| chromium | déjà en cache : `~/.cache/ms-playwright/chromium-1254/...` ; `playwright-core` est une devDependency, `playwright install` n'est pas utilisé |
| binaire du démon | `~/.cache/lavande-build/target/debug/lavande-maild` — **pas** construit par `e2e:ui` |
| `openssl` | génération du certificat de test par `scripts/mail-test-server.sh` (une fois par `LAVANDE_MAIL_TEST_DIR`) |

### Build du démon

`e2e:ui` ne compile rien : il vérifie la présence du binaire et échoue avec
`binaire absent : … (cargo build -p lavande-mail-api)`. Cette machine n'a pas de compilateur C
système, on reprend l'environnement de `scripts/mail-service.sh` :

```bash
export PATH=/home/roman/.local/opt/lavande-cc:$PATH
export CC=/home/roman/.local/opt/lavande-cc/cc
export CXX=/home/roman/.local/opt/lavande-cc/c++
export CARGO_TARGET_DIR=$HOME/.cache/lavande-build/target
cargo build -p lavande-mail-api
```

Le binaire produit est exactement celui que `scripts/mail-service.sh` lance pour le démon réel ; le
harnais ne le lance qu'avec un `LAVANDE_MAIL_DATA_DIR` temporaire et un port dédié.

## Variables d'environnement

| Variable | Effet | Défaut |
| --- | --- | --- |
| `CHROMIUM_BIN` | binaire chromium prioritaire | `~/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`, puis `…/chrome-linux/chrome`, puis `chromium_headless_shell-1254/…/chrome-headless-shell` |
| `PLAYWRIGHT_LD_PATH` | répertoire de bibliothèques ajouté à `LD_LIBRARY_PATH` pour chromium | `/tmp/lav/root/usr/lib/x86_64-linux-gnu`, `/tmp/chr-root/usr/lib/x86_64-linux-gnu` |
| `FONTCONFIG_FILE` | configuration de polices du navigateur | `/tmp/fonts/fonts.conf` |
| `LAVANDE_MAIL_TEST_USER2` / `LAVANDE_MAIL_TEST_PASSWORD2` | second compte GreenMail (boîte unifiée) | posés par `e2e-ui.mjs` : `bob@lavande.test` / `secret` |
| `LAVANDE_MAIL_TEST_USER` / `LAVANDE_MAIL_TEST_PASSWORD` | compte principal GreenMail | `roman@lavande.test` / `secret` |
| `LAVANDE_MAIL_TEST_DIR` | matériel TLS et état du conteneur | `~/.cache/lavande/mail-test` |
| `LAVANDE_MAIL_TEST_SMTP_PORT`, `LAVANDE_MAIL_TEST_IMAP_PORT`, `LAVANDE_MAIL_TEST_IMAPS_PORT`, `LAVANDE_MAIL_TEST_SMTPS_PORT` | ports publiés par le conteneur | 3025 / 3143 / 3993 / 3465 |

`PLAYWRIGHT_LD_PATH` et les deux chemins de repli ne sont retenus que si le répertoire contient
`libatk-1.0.so.0` ; de même `FONTCONFIG_FILE` n'est posé que si le fichier existe. Ces deux
contournements viennent de cette machine (bibliothèques et polices hors emplacements système) et
n'ont pas d'effet ailleurs.

Le compte E2E est saisi par l'UI dans `ConnectScreen` (champs `#connect-*`) avec les serveurs
GreenMail en TLS implicite (`imap 127.0.0.1:3993`, `smtp 127.0.0.1:3465`), le certificat du
conteneur étant ajouté aux racines de confiance du démon par `LAVANDE_MAIL_EXTRA_ROOTS`.

## Lancer

```bash
npm run e2e:ui
```

Le déroulé : 4 vérifications d'infra (GreenMail recréé, dossiers à rôle créés, démon à l'écoute,
Vite en mode api), puis les scénarios, puis le verdict. Les dossiers à rôle sont créés en IMAP clair
sur 3143 : `Sent`, `Trash`, `Archive` pour `roman@`, `Trash` seul pour `bob@` (voir « Limites »).
GreenMail ne publie que `INBOX` à la naissance d'un utilisateur, le client crée le reste.

## Lire la sortie

```
ok   greenmail : conteneur recréé — conteneur recréé, utilisateur roman@lavande.test
ok   démon : jetable à l'écoute — http://127.0.0.1:8791 · données /tmp/lavande-e2e-XXXXXX
ok   vite : app servie en mode api — http://127.0.0.1:1422
ok   smoke : formulaire de connexion affiché — phase empty → ConnectScreen
FAIL dossiers : « Restaurer » ramène le mail dans la boîte — Timeout 60000ms exceeded (capture artifacts/e2e-dossiers-restaurer-ramene-le-mail-dans-la-boite.png)

27 vérifications, 1 échec(s) — échec
```

(run arrêté au premier scénario échoué : les suivants ne sont pas joués)

- `ok` / `FAIL` par vérification, avec le détail renvoyé par le scénario après `—`.
- Une vérification en échec prend une capture `artifacts/e2e-<slug>.png` (`artifacts/` est gitignored) ;
  le slug est le libellé en minuscules, accents retirés, tout caractère non alphanumérique remplacé
  par `-`.
- Le scénario courant s'arrête à son premier échec, et la suite s'arrête au premier scénario
  échoué : l'état accumulé (comptes, mails, fils) n'est plus fiable pour les suivants.
- Les erreurs JavaScript non rattrapées de la page sont imprimées en `erreur page : …`.
- Code de sortie 1 dès un échec (vérification ou exception hors vérification, imprimée `FAIL: …`).
- Un run entièrement vert imprime 75 vérifications : 4 d'infra + 45 PC + 26 mobile.

## Ajouter un scénario

Un scénario est une fonction exportée qui reçoit un contexte et rend la main au premier échec :

| Champ | Type | Rôle |
| --- | --- | --- |
| `page` | `Page` Playwright | page du contexte courant : PC partagée par les scénarios PC, mobile dédiée aux scénarios mobile (l'ordre de la liste compte) |
| `baseUrl` | `string` | `http://127.0.0.1:1422` |
| `api` | `(path, { method, body }) => { status, json, raw }` | API du démon, jeton Bearer inclus |
| `token` | `string` | jeton du démon (`daemon-token`) |
| `seed` | `(subject, text, accountEmail?) => subject` | s'envoie un mail à soi-même via `POST /api/accounts/{id}/send` ; arrive dans l'INBOX GreenMail |
| `check` | `(label, fn) => Promise<boolean>` | exécute une vérification, imprime `ok`/`FAIL`, capture en échec |

`check` rend `true`/`false` ; la fonction passée rend une chaîne de détail (affichée après `—`) ou
lève une erreur (`throw new Error(...)`) pour échouer. Le motif courant enchaîne les vérifications
et sort du scénario dès la première en échec :

```js
// scripts/e2e/desktop.mjs
export async function desktopStarred({ page, api, seed, check }) {
  const subject = "[e2e-star] Message a etoiler";

  if (
    !(await check("étoile : mail seedé et synchronisé", async () => {
      await seed(subject, "Corps e2e-star.");
      await syncThen(page, api, ACCOUNT.email, waitRow(page, subject));
      return subject;
    }))
  ) {
    return;
  }

  await check("étoile : « Étoiler » puis filtre « Étoilés »", async () => {
    await row(page, subject).click({ button: "right" });
    await menuItem(page, "Étoiler").click();
    await page.getByRole("button", { name: "Étoilés", exact: true }).click();
    await row(page, subject).waitFor({ timeout: 30_000 });
    return subject;
  });
}
```

Puis l'ajouter à la liste PC ou mobile de `scripts/e2e-ui.mjs` :

```js
for (const scenario of [
  desktopSmoke,
  // …
  desktopStarred,
]) {
  const before = runner.failures;
  await scenario(context2);
  if (runner.failures > before) break;
}
```

Les helpers partagés vivent dans `scripts/e2e/lib.mjs` : `accountId`, `folderThreads`,
`messageBody` (assertions backend), `syncAccount` (synchro par l'API), `disablePgp(scope)`
(page mobile ou panneau de rédaction PC). Conventions du fichier `desktop.mjs` : les sélecteurs
sont regroupés en tête (`row`, `reader`, `syncButton`, `railButton`, `dockTab`, `menuItem`) et
s'appuient sur les libellés accessibles de l'UI (`aria-label`, `role`), pas sur des classes CSS.
`syncThen(page, api, email, ready)` clique le bouton « Synchroniser » quand il est au repos puis
attend `ready(timeout)` ; si la coquille est restée bloquée sur « Synchronisation en cours », il
synchronise par l'API du démon et recharge la page. Les scénarios qui envoient un mail coupent
chiffrement et signature (`disablePgp`) : les préférences les activent par défaut et le compte E2E
n'a aucune clé PGP, le démon refuserait l'envoi.

Côté mobile (`mobile.mjs`), trois pièges documentés dans le fichier :

- **Atterrissage** : avec plusieurs comptes connectés, le mode api ouvre la Boîte unifiée, pas la
  réception du compte ; `gotoInbox` ramène sur la réception (onglet « Boîte » + feuille dossiers).
  La carte résumé n'existe que dans le dossier réception.
- **Animations** : le hero (titre, boutons d'en-tête) se replie seul 2 s après l'arrivée, et la
  barre compacte le remplace ; pendant les 0,7–0,9 s d'animation le hit-test est instable. Les
  helpers de navigation (`gotoInbox`, `syncInbox`, ouverture de la feuille dossiers) utilisent
  `dispatchEvent("click")` — les deux boutons ouvrent la même feuille, le handler est certain.
  Les assertions suivantes restent des interactions réelles.
- **Synchro** : le libellé du bouton devient « Synchronisation en cours » pendant la synchro de
  fond ; `syncInbox(page, api)` attend le repos, sinon synchro API + rechargement (même repli que
  `syncThen` PC).

## Couverture

### PC — `scripts/e2e/desktop.mjs` (`/?desktop`, 1440×900)

| Scénario | Vérifications | Ce qui est couvert |
| --- | --- | --- |
| `desktopSmoke` | 7 | connexion du compte GreenMail par l'UI, dossiers listés par le serveur, compte créé, boîte ouverte, deux mails seedés, synchro manuelle, ouverture du corps |
| `desktopReplySend` | 8 | « Répondre » préremplit destinataire et `Re:`, PGP coupé, envoi, réponse rattachée au fil (vérifié côté démon : `in_reply_to`, corps relu par `fetch_body`), copie dans Envoyés |
| `desktopComposeSend` | 4 | « Nouveau message » ouvre un brouillon vide, destinataire/objet/corps saisis, envoi, message relevé dans la boîte |
| `desktopFolderActions` | 7 | menu contextuel au clic droit : corbeille, restauration, archivage puis « Déplacer vers la réception », étoile + filtre « Étoilés », « Marquer non lu » visible sur la ligne |
| `desktopSearch` | 5 | panneau de recherche, sujet seedé remonté, le résultat ouvre le bon corps, fermeture du panneau |
| `desktopThread` | 4 | fil empilé dans le lecteur, antérieur déplié avec son corps, « Tout replier », redépliage |
| `desktopUnified` | 7 | second compte ajouté depuis les réglages (`bob@lavande.test`), mail seedé chez lui, « Tous les comptes » → Boîte unifiée avec les mails des deux comptes, corbeille depuis l'unifiée (la ligne quitte l'unifiée, le mail est dans la Corbeille du compte) |
| `desktopSettingsPersistence` | 3 | « Affichage des conversations » : option par défaut, choix « Tout dans le même mail » écrit dans `lavande.prefs`, choix conservé après `page.reload()` |

Total : 45 vérifications, plus les 4 d'infra.

### Mobile — `scripts/e2e/mobile.mjs` (`/?app`, 390×844 tactile)

Contexte dédié (`hasTouch`, `isMobile`), ouvert après les scénarios PC : les comptes et mails
créés côté PC existent déjà (le démon est le même), le localStorage est neuf.

| Scénario | Vérifications | Ce qui est couvert |
| --- | --- | --- |
| `mobileInboxRead` | 4 | réception sans écran de connexion, mail seedé relevé par la synchro, clic simple → corps du message, « Retour » → liste |
| `mobileReplySend` | 6 | « Répondre » préremplit destinataire et `Re:`, PGP coupé, corps saisi, envoi (rédaction inline refermée), réponse dans le fil (2 messages, vérifié côté démon) |
| `mobileLongPressArchive` | 5 | clic simple ouvre sans feuille, appui long 650 ms → feuille d'actions, « Archiver » retire le mail de la réception, mail présent dans Archives |
| `mobileComposeSend` | 4 | FAB « Nouveau message » → brouillon vide, destinataire/objet/corps saisis, envoi, message relevé dans la boîte (corps vérifié côté démon) |
| `mobileSettingsPersistence` | 3 | drill-in Réglages → Apparence, « Tout dans le même mail » sélectionné (`aria-pressed`), choix conservé après `page.reload()` |
| `mobileSummaryCard` | 4 | badge « local » (sans LLM), repli automatique 2 s après l'arrivée, déplier ramène le texte, « Réduire le résumé » replie |

Total : 26 vérifications. Run complet vert : 75 (4 infra + 45 PC + 26 mobile).

## Limites assumées

- **Pas de LLM en E2E** : aucun réseau externe, l'assist IA reste sur son repli local (suggestions
  et résumé déterministes). Un test qui dépendrait d'un modèle configuré n'a pas sa place ici.
- **Périmètre web** : ni la coquille Tauri de bureau ni l'APK Android ne sont exercés — seule l'app
  servie par Vite l'est, en mode api.
- **Pas de rebuild Rust** : `e2e:ui` ne compile pas le démon ; un binaire périmé produit des échecs
  qui ressemblent à des régressions front. Reconstruire avant de conclure.
- **Ports fixes** (8791, 1422) : un run concurrent ou un `npm run dev` sur 1422 fait échouer la
  suite ; pas de parallélisme, état partagé entre scénarios d'un même contexte (PC puis mobile).
- **GreenMail n'expose que INBOX** : les dossiers à rôle sont créés par le client, et le harnais les
  crée en IMAP clair (3143) avant de démarrer le démon.
- **Pas de clé PGP** sur le compte E2E : les scénarios d'envoi coupent chiffrement et signature.
- **Synchro de fond** : changer de dossier pendant la synchro de fond laisse le drapeau `syncing`
  posé (bouton « Synchroniser » bloqué sur « Synchronisation en cours » jusqu'au prochain
  rechargement). `syncThen` s'en accommode en repassant par l'API du démon et un rechargement.
- **GreenMail recopie les envois** : un mail seedé depuis un compte arrive dans son INBOX *et* dans
  son dossier Envoyés (le démon y dépose une copie). Le compte `bob@` n'a donc pas de dossier
  Envoyés, pour que ses mails seedés n'existent qu'une fois dans la boîte unifiée.
- **Pas de notifications desktop** (plugin Tauri) ni de pièces jointes volumineuses dans la
  couverture actuelle.

## Distinguer les suites

| Commande | Cible | Prérequis |
| --- | --- | --- |
| `npm run e2e:ui` | app web réelle + démon jetable + GreenMail, chromium headless | docker, chromium en cache, binaire du démon |
| `npm run e2e` (`scripts/e2e-sync.mjs`) | contrat HTTP du serveur de synchronisation, 28 vérifications, sans navigateur | serveur `server/` démarré (`SYNC_URL`, défaut `http://127.0.0.1:8787`), voir [`SYNC.md`](./SYNC.md#10-vérification) |
| `npm run mail:test:live` | IMAP/SMTP réels du crate `lavande-mail`, tests `#[ignore]` de `crates/mail-core/tests/live.rs` | GreenMail démarré, `--test-threads=1` |
| `npm run mail:test` | unitaires Rust du workspace, hors réseau | wrapper `cc` de cette machine |
| `npm test` | unitaires front (vitest, jsdom) | — |
| `scripts/check-*.mjs` | audits ponctuels de la démo et du site vitrine, lancés à la main | build démo / site servi |

`npm run e2e` et `npm run e2e:ui` n'ont en commun que le style de sortie (`ok`/`FAIL`, code 1 en
échec) : le premier vérifie un protocole HTTP, le second une interface.
