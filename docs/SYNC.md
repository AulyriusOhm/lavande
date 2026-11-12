# Lavande — synchronisation chiffrée de bout en bout

Document de référence du système **tel qu'il est implémenté** (v1) : modèle de menaces, dérivation des clés,
format des opérations, fusion, schéma PostgreSQL, API HTTP, appairage, cycle de vie client, limites.
La source de vérité est le code : `server/src/**` (Rust, axum + sqlx + PostgreSQL) et `src/lib/sync/*.ts`
(TypeScript, `@noble/*`). Tout écart entre ce document et le code est un défaut du document.

Portée : entités `task` et `suggestion` du kanban de planification. Serveur : zéro connaissance du clair.

## 0. Carte du code

| Fichier | Rôle |
| --- | --- |
| `server/src/main.rs` | démarrage, `dotenvy`, migrations, `axum::serve`, arrêt gracieux (Ctrl-C) |
| `server/src/config.rs` | configuration `LAVANDE_SYNC_*` |
| `server/src/db.rs` | pool sqlx (10 connexions, timeout 5 s) + `sqlx::migrate!("./migrations")` |
| `server/src/auth.rs` | Argon2id du `authKey`, jetons, extraction `AuthedUser`, limitations de débit |
| `server/src/error.rs` | `ApiError` → `{code, message}` |
| `server/src/routes/{auth,devices,pairing,ops}.rs` | endpoints `/api/v1/*` |
| `src/lib/sync/crypto.ts` | Argon2id, HKDF, HMAC, X25519, XChaCha20-Poly1305, enveloppes, scellement d'op |
| `src/lib/sync/clock.ts` | horloge hybride logique (HLC) |
| `src/lib/sync/merge.ts` | fusion LWW par champ, tombstones, ids déterministes |
| `src/lib/sync/storage.ts` | état persistant `lavande.sync.v1` (sans secret : docs, refs, outbox, compteur d'`opId`), migration des secrets |
| `src/lib/sync/vault.ts` | coffre des secrets du front : clé privée d'appareil et jetons, gardés par le démon (§9.1) |
| `src/lib/sync/client.ts` | client HTTP (`fetch`, timeout 15 s) |
| `src/lib/sync/engine.ts` | moteur : comptes, appairage, push/pull, backoff, états |
| `src/lib/planning-store.tsx` | projection `Doc` → `Task`/`MailSuggestion`, émission locale hors ligne |

## 1. Objectifs et non-objectifs

| # | Objectif |
| --- | --- |
| O1 | Convergence du kanban `task` + `suggestion` entre desktop Tauri et mobile. |
| O2 | Hors ligne complet : mutation locale immédiate, envoi différé (outbox persistée). |
| O3 | Zéro connaissance serveur : aucun titre, description, sous-tâche, mail lié lisible. |
| O4 | Un build ancien ne peut pas détruire les données d'un build récent (§5). |
| O5 | Pas de doublon quand une même suggestion est promue sur deux appareils (§2.3). |

| Non-objectif | Raison |
| --- | --- |
| Mail (boîte, dossiers, lus/archivés) | Autre chantier ; `mailId` n'est qu'une référence opaque. |
| Calendrier / événements | Hors périmètre ; reste local. |
| Collaboration temps réel (présence, OT, CRDT texte) | Grain de conflit = champ ; latence de synchro tolérée. |
| Rotation de DEK, keystore natif, ACL par entité, partage entre utilisateurs | Absents du code (§6.6, §10). Un `user_id` = un espace. |

## 2. Entités et identifiants

### 2.1 Document client (`src/lib/sync/merge.ts`)

```ts
export const LOCAL_SCHEMA_VERSION = 1;
export type DocKind = "task" | "suggestion";
export type Doc = {
  id: string;                        // identifiant d'entité (§2.3)
  kind: DocKind;
  v: number;                         // max(schemaVersion) reçue pour ce doc
  raw: Record<string, unknown>;      // valeurs brutes, clés inconnues de ce build conservées
  fields: Record<string, string>;    // champ -> HLC du dernier écrivain (seul métadata de fusion)
  deletedAt?: string;                // HLC du tombstone ; absent = doc vivant
  readOnly: boolean;                 // v > LOCAL_SCHEMA_VERSION
  updatedAt: string;                 // ISO 8601 dérivé du HLC (informatif, hors fusion)
};
```

Il n'y a **pas** de `fieldWriters` ni de `values` : le départage est entièrement porté par le HLC
(§3.2), les valeurs vivent dans `raw`. `Task` et `MailSuggestion` sont des projections de lecture
(`projectTask` / `projectSuggestion`), jamais la source de vérité.

### 2.2 Champs synchronisés

Les patches sont produits par `taskPatch` (`src/lib/planning-store.tsx`) : un champ optionnel disparu est
émis à `null`, un champ inchangé n'est pas émis.

| Doc | Champs (`patch`) |
| --- | --- |
| `task` | `title`, `meta`, `state`, `due`, `dueTone`, `dueDate`, `progress`, `description`, `subtasks`, `mailId` |
| `suggestion` | `status` (`pending`/`accepted`/`dismissed`), `taskId`, `mailId`, `account`, `from`, `subject`, `proposal`, `due`, `dueTone`, `tone`, `description` |

`subtasks` (`{title, done}[]`) est **un seul champ**. Un seul `state` parmi
`todo|doing|waiting|review|done`, un seul `dueTone` parmi `late|soon|soft|none`.

### 2.3 Identifiants

| Entité | Forme | Déterminisme |
| --- | --- | --- |
| suggestion | `sg:` + `base64url(SHA-256(`${account}:${mailId}|${proposalNormalisee}`)).slice(0, 22)` | déterministe |
| tâche issue d'une suggestion | `ts:` + `<id de suggestion sans le préfixe sg:>` (donc `ts:<digest22>`) | déterministe |
| tâche manuelle | identifiant opaque de l'UI (fixtures : `t10`, `t2`, …) | fourni par l'appelant |
| appareil | UUID v4 généré par le client (`randomUuid()`) | choisi par le client |
| opération | `${deviceId}:${compteur}` | compteur monotone par appareil |

`base64url` = alphabet `A-Za-z0-9-_`, sans padding (`@noble/hashes` + `encodeBase64Url` maison).
`suggestionId` normalise ainsi : `trim()` → `toLowerCase()` (accents conservés) → `/\s+/g` → `" "` →
retrait de `/[.!?…:;,]+$/` → `trim()`.

L'identifiant déterministe **est** l'anti-doublon : deux appareils qui voient le même mail calculent le
même `id`, donc la même op ; une op identique est absorbée par `UNIQUE (user_id, op_id)`.

### 2.4 `entityRef`

```ts
// src/lib/sync/crypto.ts
export function entityRef(indexKey: Uint8Array, kind: EntityKind, id: string): string {
  return encodeBase64Url(hmac(sha256, indexKey, utf8ToBytes(`${kind}:${id}`))).slice(0, 22);
}
```

`indexKey = HKDF-SHA256(dek, info "lavande/index/v1")` (§6.1) : le serveur indexe les ops d'une même
entité sans connaître son `id`, donc sans connaître le `mailId` contenu dans un id de suggestion.
`kind` reste en clair dans l'op.

Côté état local, `refs` associe `entityRef` → clé de doc (`${kind}:${id}`) :

- avant configuration du compte (`phase === "unconfigured"`), `planning-store` applique ses mutations en
  local avec la référence en clair `${kind}:${id}` ; ces références ne quittent jamais l'appareil ;
- dès la première synchro, `engine.emitLocal` émet les nouvelles ops avec la référence HMAC, qui est
  ajoutée à `refs` ; l'ancienne entrée en clair devient inerte (elle ne matche plus aucune op serveur).

## 3. Journal d'opérations

Le journal serveur est append-only ; une op est immuable et idempotente.

### 3.1 Format

```ts
type SyncOp = {                       // src/lib/sync/storage.ts — forme envoyée au serveur
  opId: string;                       // `${deviceId}:${compteur}` (≤ 128 car.)
  deviceId: string;                   // UUID v4 ; recopié localement, NON envoyé (déduit de la session)
  kind: "task" | "suggestion";        // en clair
  entityRef: string;                  // base64url, 1..64 car. (§2.4)
  hlc: string;                        // `0000019a4f2b8c1-00003-2e7421` (§3.2)
  schemaVersion: number;              // >= 1 ; > SERVER_MAX_SCHEMA → 426
  nonce: string;                      // base64url, 24 octets exactement (XChaCha20-Poly1305)
  ciphertext: string;                 // base64url, 1..65536 octets (tag 16 o inclus)
};
type OpPayload = {                    // clair, avant chiffrement
  id: string;
  kind: "task" | "suggestion";
  v: number;                          // version de schéma du document produit
  op: "upsert" | "delete";
  patch?: Record<string, unknown>;    // absent pour "delete"
};
```

AAD, UTF-8 exact, séparateur `|`, aucune espace :
`` `${opId}|${deviceId}|${entityRef}|${hlc}|${schemaVersion}` ``.
Elle lie l'op à son émetteur, sa cible et son horloge : rejouer une op sous un autre `opId` ou changer son
`schemaVersion` invalide le tag côté client. `deviceId` n'est pas un champ du corps HTTP `POST /ops` : le
serveur le prend dans la session (`sessions.device_id`).

### 3.2 HLC

```ts
encodeHlc : `${wallMs sur 15 chiffres}-${compteur sur 5 chiffres}-${node}`  // node = 6 car. alphanum
```

- `node` = `deviceId` privé de ses non-alphanumériques, tronqué à 6 caractères (UUID v4 ⇒ 6 hex).
  **Il participe à l'ordre** (`compareHlc` compare `wallMs`, puis `compteur`, puis `node`).
- `wallMs < 10^15`, `compteur < 10^5` : hors bornes, `encodeHlc` lève.
- `tick()` : `wall = max(wall, now)`, `compteur = (wall inchangé ? compteur + 1 : 0)`.
- `receive(remote)` : `wall = max(wall local, wall distant, now)` puis `compteur = max(local, distant) + 1`
  si les deux mènent à égalité, `+1` du côté qui mène, `0` sinon (nouvelle ère).
- Acceptation serveur : `^\d{15}-\d{5}-[A-Za-z0-9]{1,8}$` (validation Rust, pas de contrainte SQL).
- Décodage client : `^(\d{15})-(\d{5})-([A-Za-z0-9]{0,6})$`.
- Le HLC n'est **pas persisté** : il repart de `Date.now()` à chaque démarrage (§10).

### 3.3 Règles

| Règle | Détail |
| --- | --- |
| Append-only | le serveur n'exécute aucun `UPDATE`/`DELETE` sur `ops` ; le client n'émet que des ops neuves. |
| Idempotence | `UNIQUE (user_id, op_id)` + `INSERT … ON CONFLICT DO NOTHING` ; toute op de la batch est renvoyée dans `acked`, doublons compris. |
| Compteur | `device.opCounter` persisté dans `lavande.sync.v1`, incrémenté avant émission. |
| Tombstone | `delete` n'efface aucune ligne serveur ; localement le doc reste avec `deletedAt` (HLC). |
| Résurrection | un `upsert` de HLC strictement supérieur à `deletedAt` recrée le doc vivant (`deletedAt` retiré). |
| Atomicité | une batch invalide est rejetée avant toute écriture (validation puis transaction unique). |

## 4. Fusion (LWW par champ)

### 4.1 Code réel (`src/lib/sync/merge.ts`)

```ts
const isNewer = (hlc: string, previous: string | undefined) =>
  previous === undefined || compareHlc(hlc, previous) > 0;

function tombstone(current, op) {                    // op.payload.op === "delete"
  if (current === undefined) return { ...baseDoc(op), deletedAt: op.hlc };
  if (current.deletedAt !== undefined && compareHlc(op.hlc, current.deletedAt) <= 0) return current;
  return { ...current, deletedAt: op.hlc, updatedAt: timestamp(op.hlc) };   // v inchangé
}

function upsert(current, op) {
  if (current?.deletedAt !== undefined && compareHlc(op.hlc, current.deletedAt) <= 0) return current;
  const base = current ?? baseDoc(op);
  const fields = { ...base.fields }, raw = { ...base.raw };
  for (const [name, value] of Object.entries(op.payload.patch ?? {})) {
    if (!isNewer(op.hlc, fields[name])) continue;    // merge champ par champ
    raw[name] = value; fields[name] = op.hlc;
  }
  const v = Math.max(base.v, op.schemaVersion);      // v ne décroît jamais
  return { id: base.id, kind: base.kind, v, raw, fields, readOnly: v > LOCAL_SCHEMA_VERSION,
           updatedAt: timestamp(op.hlc) };            // deletedAt absent ⇒ résurrection
}

export function applyOp(docs, refs, op) {             // entité résolue par entityRef
  const key = docKey(op.kind, op.payload.id);         // `${kind}:${id}`
  const bound = refs[op.entityRef];
  if (bound !== undefined && bound !== key) return { docs, refs, changed: false };  // réf. liée ailleurs
  …
}
```

### 4.2 Règles

| Règle | Conséquence |
| --- | --- |
| Merge de patch, jamais de reconstruction depuis le type TS | `raw` conserve toute clé du document, y compris celles qu'un build ancien ne connaît pas : aucune suppression implicite. |
| Comparaison = HLC complet (wall, compteur, node) | départage déterministe, sans métadonnée d'appareil séparée. |
| Tombstone comparé à `deletedAt`, pas à `max(fields)` | une suppression récente n'est pas annulée par une vieille écriture de champ. |
| `delete` ne touche pas `v` | un tombstone ne fait pas monter la version de schéma du doc. |
| Un `entityRef` déjà lié à un autre doc est ignoré | empêche un `entityRef` reçu de réécrire une entité locale homonyme. |
| Lecture | `visibleDocs` ne renvoie que `deletedAt === undefined`, triés par `id`. |
| `subtasks` = un champ | deux coches simultanées sur deux sous-tâches : une seule gagne (§10). |

Le serveur ne fusionne rien : la convergence est déterministe pour un même ensemble d'ops.

## 5. Version et compatibilité de schéma

| Symbole | Où | Rôle |
| --- | --- | --- |
| `schemaVersion` | champ d'op (clair) | version du format d'op/patch ; contrôlée par le serveur. |
| `payload.v` | champ d'op (chiffré) | version de document visée ; invisible du serveur. |
| `LOCAL_SCHEMA_VERSION` | `merge.ts` (`= 1`) | version que ce build sait lire et écrire. |
| `LAVANDE_SYNC_SERVER_MAX_SCHEMA` | config serveur (`1`) | version d'op maximale acceptée en écriture. |
| `LAVANDE_SYNC_MIN_CLIENT_SCHEMA` | config serveur (`1`) | version client minimale (`1 ≤ min ≤ max`). |
| `serverSchemaVersion` / `minClientSchema` | `GET /healthz`, `GET /status` | valeurs exposées au client. |

`v` de doc = `max(schemaVersion)` reçue. Pour un writer v1, `v === schemaVersion`.

| # | Règle exacte (implémentée) |
| --- | --- |
| (a) | `v > LOCAL_SCHEMA_VERSION` ⇒ doc stocké intégralement dans `raw` et marqué `readOnly` ; `engine.emitLocal` **refuse** alors toute mutation (`readOnly(kind,id)` lève). L'appareil ancien ne peut donc rien écraser. |
| (b) | `POST /ops` répond `426 schema_too_new` si **une** op dépasse `SERVER_MAX_SCHEMA` ; la batch entière est rejetée avant la transaction. |
| (c) | `409 client_too_old` si `schemaVersion < MIN_CLIENT_SCHEMA`, **uniquement** sur `POST /devices` et `POST /pairing/start` (aucun contrôle sur `/auth/*`, `/ops`, `/status`). Le moteur le traite comme une erreur terminale (`phase: "error"`). |
| (d) | `migrateDoc(raw, fromV)` existe (`MIGRATIONS = {}` en v1, `LOCAL_SCHEMA_VERSION = 1`) : elle ne sait migrer que `fromV === 1`, toute autre valeur lève. Aucune migration n'est appliquée automatiquement aujourd'hui. |

Le variant serveur `ApiError::ClientTooOld` (426) existe mais n'est construit nulle part : le seul chemin
vivant est le `409 client_too_old` de (c).

## 6. Sécurité (E2EE zéro-connaissance)

### 6.1 Dérivation réelle

```ts
masterKey = argon2id(utf8(password), accountSalt, { t: 3, m: 65536 /* Kio */, p: 1, dkLen: 32 });
authKey   = HKDF-SHA256(ikm = masterKey, salt = ∅ /* 0 octet */, info = "lavande/auth/v1", len = 32);
kek       = HKDF-SHA256(ikm = masterKey, salt = ∅,               info = "lavande/kek/v1",  len = 32);
dek       = randomBytes(32);                                     // une seule fois, par compte
indexKey  = HKDF-SHA256(ikm = dek,       salt = ∅,               info = "lavande/index/v1", len = 32);
```

Le sel HKDF est la chaîne vide (`new Uint8Array(0)`) : `accountSalt` n'entre que dans Argon2id.
`accountSalt` = 16 octets aléatoires (base64url) générés par le client (`randomSalt(16)`).

Serveur : `auth_verifier = Argon2id(authKey)` (PHC string, `Argon2::default()`, sel aléatoire de 16 octets
dupliqué dans `users.auth_salt`), `token` de session = 32 octets aléatoires, stocké **haché** SHA-256.

Ops : **XChaCha20-Poly1305**, `nonce` 24 octets aléatoires par op (jamais réutilisé), AAD §3.1, tag 16 o
inclus dans `ciphertext`.

### 6.2 Enveloppes de la DEK

Format commun : `{ v: 1, ephPub: base64url, nonce: base64url, ct: base64url }`.

| Enveloppe | Construction | AAD | Où elle vit |
| --- | --- | --- | --- |
| (a) mot de passe | `XChaCha20-Poly1305(kek, nonce24, dek)` ; `ephPub` = 32 octets aléatoires de bourrage, inutilisés | `"lavande/pw/v1"` | `state.envelopes.password` **et** `users.key_envelope` (base64url du JSON, ≤ 4096 octets) via `POST /auth/envelope` |
| (b) appareil | `eph = x25519.keygen()` ; `aad = ephPub‖devicePub` ; `k = HKDF-SHA256(X25519(ephPriv, devicePub), salt = aad, info = "lavande/wrap/v1")` ; `ct = seal(k, dek)` | `ephPub‖devicePub` | `state.envelopes.devices[deviceId]` + `pairing_sessions.wrapped_key` pendant l'appairage |

Ouverture (b) côté nouvel appareil : `devicePub = X25519.getPublicKey(devicePriv)`, même `aad`, même `k`.

Transmission de (a) : `encodeEnvelopeWire = base64url(JSON)`, déposée par `POST /auth/envelope {envelope}`
(session authentifiée, n'importe quel appareil du compte) et restituée en clair-base64url par
`POST /auth/login → keyEnvelope`. Le serveur ne peut pas l'ouvrir (il n'a pas la `kek`, dérivée du mot de
passe). Un appareil neuf peut donc récupérer la DEK avec le mot de passe seul ; l'appairage (§6.4) reste
la voie sans mot de passe.

### 6.3 Matrice de possession des clés

| Secret | Taille | Serveur | Client | Usage |
| --- | --- | --- | --- | --- |
| mot de passe | — | jamais | oui (mémoire) | entrée Argon2id |
| `masterKey` | 32 o | jamais | dérivée à la volée | racine |
| `authKey` | 32 o | vérifieur Argon2id seulement | dérivée | preuve d'authentification |
| `kek` | 32 o | jamais | dérivée | enveloppe (a) |
| `dek` | 32 o | jamais en clair | mémoire + enveloppes | chiffrement des ops |
| `indexKey` | 32 o | jamais | dérivée de la DEK | `entityRef` |
| `devicePriv` (X25519) | 32 o | jamais | coffre du démon (§9.1) | ouverture de l'enveloppe (b) |
| enveloppe (a) | ~120 o | oui (`users.key_envelope`) | oui | récupération de la DEK par mot de passe |
| `accountSalt` | 16 o | oui (`users.account_salt`) | oui | Argon2id |
| `auth_salt` | 16 o | oui (`users.auth_salt`) | non | sel du vérifieur |
| token de session | 32 o | SHA-256 seulement (`sessions.token_hash`) | coffre du démon (§9.1) | `Authorization: Bearer` |
| `pollSecret` | ≥ 16 o (client : 32) | SHA-256 de sa forme base64url | oui | retrait du résultat d'appairage |
| code d'appairage | 6 car. | SHA-256 (`pairing_sessions.code_hash`) | oui, éphémère | claim |

### 6.4 Appairage réel

Alphabet du code : `ABCDEFGHJKLMNPQRSTUVWXYZ234567` (sans `I`, `O`, `0`, `1`), 6 caractères, 5 candidats
tirés en cas de collision de `code_hash`. TTL = `LAVANDE_SYNC_PAIRING_TTL_SECS` (300 s).

| # | Acteur | Requête | Effet serveur |
| --- | --- | --- | --- |
| 1 | nouvel appareil | `POST /pairing/start {deviceId (uuid), name, platform, publicKey (32 o), schemaVersion, pollSecret}` — **non authentifié** | génère le code, écrit `pairing_sessions` (`code_hash`, `device_id`, `name`, `platform`, `target_pub_key`, `schema_version`, `poll_secret_hash = SHA-256(base64url(pollSecret))`, `expires_at`) ; répond `201 {code, expiresAt}` |
| 2 | nouvel appareil | `POST /pairing/{code}/poll {pollSecret}` | `200 {status:"pending"}` tant que `completed_at` est nul |
| 3 | appareil configuré | `POST /pairing/claim {code}` (authentifié) | refuse expiré/complété/réclamé ; écrit `claimed_at`, `user_id` ; répond `{deviceId, deviceName, platform, publicKey, schemaVersion, fingerprint}` avec `fingerprint = base64url(SHA-256(pubKey))[0..8]` |
| 4 | appareil configuré | `POST /pairing/complete {code, envelope}` (`envelope` = JSON stringifié de l'enveloppe (b), ≤ 4096 car.) | vérifie `user_id`/`claimed_at`, crée la ligne `devices` (id imposé, `pub_key`) sauf si elle existe déjà à l'identique, écrit `wrapped_key` + `completed_at` ; `204` |
| 5 | nouvel appareil | `POST /pairing/{code}/poll {pollSecret}` | `200 {status:"completed", token, userId, accountSalt, envelope}`, crée une session liée à `device_id`, écrit `token_issued_at` |
| 6 | nouvel appareil | — | ouvre l'enveloppe avec sa clé privée X25519 ⇒ DEK, stocke compte + enveloppe, puis `syncNow()` |

Le code est **à usage unique** : un seul `claim` (`claimed_at`), un seul `complete` (`completed_at`), un
seul `poll` réussi (`token_issued_at`, sinon `409 pairing_consumed`). Le `pollSecret` est la seule valeur
qui permet de retirer le résultat : deviner le code ne suffit pas. Aucun compteur de tentatives n'existe
(le code n'est pas invalidé après N `claim` infructueux) ; les lignes expirées ne sont jamais purgées.

### 6.5 Ce que le serveur voit

| Visible | Invisible |
| --- | --- |
| `userId`, `email`, `deviceId` (uuid), nom et plateforme de l'appareil, clé publique X25519, `fingerprint` | titres, `meta`, `description`, `due`, `state`, `progress`, `subtasks`, `account` |
| `kind` (`task`/`suggestion`) | `id` d'entité, `mailId` |
| `entityRef` (HMAC non réversible sans `indexKey`) | `from`, `subject`, `proposal`, `status`/`taskId` d'une suggestion |
| `hlc`, `schemaVersion`, `seq`, horodatages serveur, tailles | mot de passe, `masterKey`, `authKey`, `kek`, `dek`, `indexKey`, clés privées X25519 |
| nombre d'ops par entité, fréquence de synchro, liste des appareils | contenu de `pairing_sessions.wrapped_key` et de `users.key_envelope` (enveloppes chiffrées, opaques pour lui) |

### 6.6 Révocation, rotation, compromission

| Scénario | Procédure réelle | Effet |
| --- | --- | --- |
| Perte/vol d'un appareil | `DELETE /api/v1/devices/{id}` depuis un autre appareil | `devices.revoked_at = now()`, sessions de l'appareil supprimées ; son jeton tombe en `401`, ses `POST /ops` sont refusés (`AuthedUser` exige `revoked_at is null`) |
| Départ d'un appareil propre | `POST /auth/logout` (supprime la session) puis `DELETE /devices/{id}` | idem ci-dessus |
| DEK compromise | **aucune rotation** : `POST /auth/envelope` permet seulement de remplacer l'enveloppe (a) (nouvelle `kek`), pas de réémettre les ops ; `entityRef` est lié à l'ancienne DEK | l'attaquant conserve la DEK et donc l'historique déchiffrable ; la seule voie propre est un nouveau compte + ré-appairage des appareils |
| Mot de passe compromis | changer le mot de passe n'est **pas** possible (`authKey`/`auth_verifier` figés, aucun endpoint) | nouveau compte ; les données de l'ancien restent accessibles à qui détient `authKey`/`dek` |
| Mot de passe oublié | pas de récupération | idem |
| Code d'appairage divulgué | il ne donne rien sans `pollSecret` ; au pire un `claim` par un compte tiers, qui ne peut pas produire d'enveloppe utilisable et fait échouer l'appairage (`pairing_already_claimed`) | refaire un `start` |
| Appareil réinstallé | la DEK et l'enveloppe (b) vivaient dans `localStorage` : perdues (la clé privée d'appareil, elle, survit dans le coffre du démon) | se reconnecter avec le mot de passe (enveloppe (a) restituée par `POST /auth/login`) ou ré-appairer |

### 6.7 Limites de sécurité assumées

| Limite | Conséquence |
| --- | --- |
| enveloppes de la DEK, `docs` déchiffrés et `refs` dans `localStorage` (`lavande.sync.v1`) | un XSS lit les documents et le jeton de session courant ; clé privée X25519 et jetons ne sont plus dans le `localStorage` (coffre du démon), mais restent lisibles en mémoire du front |
| aucune attestation matérielle, aucune vérification croisée des clés d'appareil | un appareil compromis est un client légitime ; l'appairage repose sur le code + `pollSecret` |
| pas de rotation de DEK, pas de nouveau `indexKey` | DEK compromise = historique lisible |
| `entityRef` stable par entité | le serveur corrèle toutes les ops d'une entité (métadonnée assumée) |
| limitations de débit en mémoire, par processus | `10 / 60 s` par `(email|ip)` sur `/auth/login`, `10 / 60 s` par IP sur `/pairing/start` ; rien sur `/auth/register`, `/pairing/claim` (30 bits à deviner, aucun quota) ni `/ops` |

## 7. Schéma PostgreSQL réel

Appliqué automatiquement au démarrage (`sqlx::migrate!`, dossier `server/migrations`). Aucune extension
n'est requise (`gen_random_uuid()` n'est pas utilisé : les UUID viennent du client ou de Rust).

```sql
-- 0001_accounts.sql
create table users (
    id uuid primary key,
    email text not null unique,
    auth_verifier text not null,          -- PHC Argon2id(authKey)
    auth_salt bytea not null,             -- sel du vérifieur (16 o)
    account_salt bytea not null,          -- sel Argon2id public (16 o)
    key_envelope bytea,                   -- enveloppe (a) base64url(JSON), via POST /auth/envelope (§6.2)
    created_at timestamptz not null default now()
);
create table sessions (
    token_hash bytea primary key,         -- SHA-256 du jeton porteur
    user_id uuid not null references users (id) on delete cascade,
    device_id uuid,                       -- null = session de compte (avant POST /devices)
    created_at timestamptz not null default now(),
    expires_at timestamptz not null       -- now + SESSION_TTL_SECS, non glissant
);
create table devices (
    id uuid primary key,                  -- uuid v4 imposé par le client
    user_id uuid not null references users (id) on delete cascade,
    name text not null,
    platform text not null,
    pub_key bytea not null constraint devices_pub_key_len check (octet_length(pub_key) = 32),
    schema_version int not null,
    last_seen_at timestamptz not null default now(),
    revoked_at timestamptz
);
create index sessions_user_id_idx on sessions (user_id);
create index devices_user_id_idx on devices (user_id);

-- 0002_ops_pairing.sql (table pairing_sessions remplacée par 0003)
create table ops (
    seq bigserial primary key,
    user_id uuid not null references users (id) on delete cascade,
    op_id text not null,
    device_id uuid not null,              -- émetteur (session), sans clé étrangère
    entity_ref text not null,
    kind text not null constraint ops_kind_valid check (kind in ('task', 'suggestion')),
    hlc text not null,
    schema_version int not null,
    nonce bytea not null constraint ops_nonce_len check (octet_length(nonce) = 24),
    ciphertext bytea not null constraint ops_ciphertext_len check (
        octet_length(ciphertext) between 1 and 65536
    ),
    created_at timestamptz not null default now(),
    constraint ops_user_op_id_unique unique (user_id, op_id)
);
create index ops_user_seq on ops (user_id, seq);
create index ops_user_entity on ops (user_id, entity_ref);

-- 0003_pairing_v2.sql
drop table if exists pairing_sessions;
create table pairing_sessions (
  code_hash bytea primary key,            -- SHA-256 du code à 6 caractères (majuscules)
  device_id uuid not null,                -- uuid v4 du nouvel appareil
  name text not null,
  platform text not null,
  target_pub_key bytea not null constraint pairing_pub_key_len check (octet_length(target_pub_key) = 32),
  schema_version int not null,
  poll_secret_hash bytea not null,        -- SHA-256 de base64url(pollSecret)
  user_id uuid references users (id) on delete cascade,   -- null avant le claim
  wrapped_key text,                       -- enveloppe (b), JSON sérialisé
  token_issued_at timestamptz,            -- jeton déjà retiré (usage unique)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz
);
create index pairing_sessions_expiry_idx on pairing_sessions (expires_at);
create unique index devices_user_pubkey_unique on devices (user_id, pub_key) where revoked_at is null;
```

Ce qui **n'existe pas** malgré ce que décrivait une version antérieure de ce document : `server_salt`,
`sessions.revoked_at`, `sessions.last_used_at`, `sessions.id`, `devices.dek_envelope`, `devices.created_at`,
`pairing_sessions.status/attempts/consumed_at`, `pairing_sessions.code`, les contraintes `ops_entity_ref_fmt`
et `ops_hlc_fmt`, l'extension `pgcrypto`.

Conséquences directes :

- `entityRef` et `hlc` ne sont validés que par Rust (charset 1..64, regex HLC), pas par la base ;
- un `postgres` tiers peut écrire des valeurs non conformes : le serveur les refusera au pull client ;
- `DELETE /devices/{id}` supprime les sessions de l'appareil, ne supprime aucune op ;
- `ON DELETE CASCADE` sur `users` est la seule purge : il n'existe aucun endpoint de suppression de compte.

## 8. API HTTP réelle

Base `/api/v1`, `Authorization: Bearer <token>`, JSON. Erreurs : `{"code": "...", "message": "..."}`.
Erreurs de désérialisation levées par axum (corps non JSON, `Content-Type` absent, UUID malformé) :
`400` / `415` / `422` avec un corps **texte**, hors enveloppe JSON. Aucun en-tête `Retry-After` n'est émis.

| Méthode | Chemin | Auth | Corps | Réponse |
| --- | --- | --- | --- | --- |
| GET | `/healthz` | non | — | `{status:"ok"\|"unavailable", schemaVersion, minClientSchema}` (200/503) |
| GET | `/api/v1/auth/salt?email=` | non | — | `200 {accountSalt}` |
| POST | `/api/v1/auth/register` | non | `{email, authKey(32 o b64url), accountSalt(16 o b64url)}` | `201 {userId, token, expiresAt, accountSalt}` |
| POST | `/api/v1/auth/login` | non | `{email, authKey}` | `200 {userId, token, expiresAt, accountSalt, keyEnvelope}` |
| POST | `/api/v1/auth/logout` | oui | — | `204` |
| POST | `/api/v1/auth/envelope` | oui | `{envelope}` = base64url(JSON de l'enveloppe (a)), ≤ 4096 octets décodés | `204` (remplace `users.key_envelope`) |
| GET | `/api/v1/me` | oui | — | `{userId, email, accountSalt, devices:<nombre>}` |
| GET | `/api/v1/devices` | oui | — | `[{id, name, platform, schemaVersion, lastSeenAt, current}]` |
| POST | `/api/v1/devices` | oui | `{id?, name, platform, pubKey(32 o), schemaVersion}` | `201` (créé) / `200` (même `pubKey` déjà actif) `{deviceId}` |
| DELETE | `/api/v1/devices/{id}` | oui | — | `204` |
| POST | `/api/v1/pairing/start` | **non** | `{deviceId, name, platform, publicKey, schemaVersion, pollSecret}` | `201 {code, expiresAt}` |
| POST | `/api/v1/pairing/claim` | oui | `{code}` | `200 {deviceId, deviceName, platform, publicKey, schemaVersion, fingerprint}` |
| POST | `/api/v1/pairing/complete` | oui | `{code, envelope}` | `204` |
| POST | `/api/v1/pairing/{code}/poll` | **non** | `{pollSecret}` | `200 {status:"pending"}` ou `200 {status:"completed", token, userId, accountSalt, envelope}` |
| POST | `/api/v1/ops` | oui + appareil | `{ops:[Op]}` ≤ 200 | `200 {acked:[opId], nextSeq}` |
| GET | `/api/v1/ops?since=&limit=` | oui | — | `200 {ops:[Op], nextSeq, hasMore}` |
| GET | `/api/v1/status` | oui | — | `200 {serverSchemaVersion, minClientSchema, headSeq}` |

Contraintes de validation (`server/src/routes/ops.rs`), dans l'ordre : `opId` 1..128 car. ; `kind ∈
{task,suggestion}` ; `entityRef` 1..64 car. du jeu `[A-Za-z0-9_-]` (aucun décodage base64) ; `hlc` regex
ci-dessus ; `schemaVersion ≥ 1` ; `nonce` 24 octets ; `ciphertext` 1..65536 octets ; ≤ 200 ops par requête.
`since` par défaut `0` (négatif refusé), `limit` par défaut et maximum `500` (`<1` ou `>500` refusé).

Sémantique des curseurs :

- `POST /ops` → `nextSeq` = `max(seq)` du journal de l'utilisateur **après** insertion (= tête) ;
- `GET /ops` → `nextSeq` = `seq` de la **dernière op renvoyée** ; vaut `since` si la page est vide (ce
  n'est donc pas la tête globale) ; `hasMore` = `true` si la page a été tronquée à `limit` ;
- `GET /status` → `headSeq` = `max(seq)` global du journal de l'utilisateur ;
- `POST /ops` avec une session sans appareil → `401 device_required` (avant toute validation de batch).

| HTTP | `code` | Sens |
| --- | --- | --- |
| 400 | `bad_request` | corps ou champ invalide (email, `name`, `platform`, `code`, `envelope`, `nonce`, `ciphertext`, `kind`, `entityRef`, `hlc`, `schemaVersion`, `since`, `limit`, > 200 ops) |
| 401 | `unauthorized` | jeton absent, expiré, supprimé, ou appareil révoqué |
| 401 | `invalid_credentials` | `POST /auth/login` : email inconnu ou `authKey` refusée (même réponse, vérifieur factice pour l'email inconnu) |
| 401 | `device_required` | `POST /ops` sur une session non liée à un appareil |
| 401 | `invalid_poll_secret` | `POST /pairing/{code}/poll` avec un `pollSecret` faux ou malformé |
| 404 | `not_found` | `DELETE /devices/{id}` inconnu ; route inconnue (`/healthz` sous `/api/v1` renvoie 404 vide) |
| 404 | `unknown_email` | `GET /auth/salt` sur un email sans compte |
| 404 | `pairing_unknown` | code d'appairage inexistant, malformé, ou réclamé par un autre compte |
| 404 | `pairing_expired` | `expires_at <= now()` |
| 409 | `email_taken` | inscription sur un email existant |
| 409 | `device_id_taken` | `POST /devices` : uuid déjà attribué (tous comptes confondus) ; `complete` : uuid occupé ou `pubKey` déjà active pour un autre appareil (un `pubKey` identique sur `POST /devices` renvoie au contraire `200` avec l'appareil existant) |
| 409 | `client_too_old` | `schemaVersion < MIN_CLIENT_SCHEMA` sur `/devices` ou `/pairing/start` |
| 409 | `pairing_already_claimed` / `pairing_already_completed` | `claim`/`complete` rejoués |
| 409 | `pairing_not_claimed` | `complete` avant `claim` |
| 409 | `pairing_consumed` | `poll` après un premier `poll` réussi |
| 426 | `schema_too_new` | `POST /ops` avec `schemaVersion > SERVER_MAX_SCHEMA` |
| 429 | `rate_limited` | quota `/auth/login` ou `/pairing/start` dépassé (sans `Retry-After`) |
| 500 | `internal` | erreur interne (message générique, aucun détail) |

### 8.1 Push

```json
{ "ops": [
  { "opId": "2e742171-b33c-4350-9f54-70707cda18fb:41", "kind": "task",
    "entityRef": "krWPrW0BTkQ6_F74dgExhu", "hlc": "0000019a4f2b8c1-00003-2e7421",
    "schemaVersion": 1, "nonce": "9tK3xQ0m2pV7sR4uL1yZ8aBc", "ciphertext": "3Xq0m2pV7sR4uL1yZ8aBcD…" }
] }
```

`nonce` = 32 caractères base64url (24 octets). Réponse :
`{"acked":["2e742171-…:41"],"nextSeq":42}`. `acked` liste **toutes** les ops de la batch, doublons
compris : un renvoi après coupure réseau est sûr et ne crée aucune ligne (`ON CONFLICT DO NOTHING`).

### 8.2 Pull

`GET /api/v1/ops?since=41&limit=500` renvoie les ops `seq > 41`, triées par `seq` croissant :

```json
{ "ops": [ { "seq": 42, "opId": "…:42", "deviceId": "…", "kind": "suggestion",
             "entityRef": "lqwJt778GhtwP9KdZYcdAI", "hlc": "0000019a4f31a04-00000-2e7421",
             "schemaVersion": 1, "nonce": "…", "ciphertext": "…" } ],
  "nextSeq": 42, "hasMore": false }
```

Le client persiste `cursor = max(seq reçus, nextSeq)` après application effective. Un `limit` atteint
implique `hasMore: true` et une page suivante ; l'engine boucle jusqu'à `hasMore === false`.

## 9. Cycle de vie client

### 9.1 État persistant (`localStorage`, clé `lavande.sync.v1`)

Deux parts. `SyncState` est l'état complet, en mémoire ; `localStorage` n'en reçoit que la part non
sensible (`device.privKey` et `account.token` en sont retirés).

```ts
type SyncState = {                     // en mémoire
  proto: 1;
  device: { id: string; name: string; platform: string; pubKey: string; privKey: string;
            schemaVersion: number; opCounter: number };
  account?: { serverUrl: string; userId: string; email: string; accountSalt: string; token: string };
  envelopes: { password?: WrappedKey; devices: Record<string, WrappedKey> };
  cursor: number;                       // dernier seq appliqué
  docs: Record<string, Doc>;            // clé = `${kind}:${id}`
  refs: Record<string, string>;         // entityRef -> `${kind}:${id}`
  outbox: SyncOp[];                      // ops non confirmées, ordre d'émission
  autoSync: boolean;
  status: { lastSyncAt?: string; lastError?: string };
};
```

Toute lecture passe par une normalisation tolérante (`normalizeState`) : une entrée corrompue est
reconstruite ou écartée, jamais fatale. Le HLC n'est pas persisté. DEK et `indexKey` sont recalculés ou
ouverts à la demande, jamais stockés en clair.

Les deux secrets vivent dans le coffre du démon (trousseau système ou fichier chiffré, comme les
identifiants CalDAV), sous des identifiants stables : `sync:device` pour la clé privée d'appareil,
`sync:<userId>` pour le jeton de session. Routes : `GET|PUT /api/sync/secrets/device` et
`GET|PUT|DELETE /api/sync/secrets/accounts/{id}`, derrière le jeton du démon ; aucune valeur n'est
journalisée. `src/lib/sync/vault.ts` en est le client.

Invariant de migration : un secret n'est retiré du `localStorage` qu'après l'acquittement du coffre. Un
`PUT` échoué (démon absent, mode démo) laisse le secret en place — repli local assumé, rien n'est perdu.
Le premier `read()` migre un état d'avant G3 (`device.privKey`/`account.token` inline) vers le coffre, puis
réécrit l'entrée sans eux.

### 9.2 Démarrage

1. `createLocalStorageSyncStorage` : lecture de l'état persisté, secrets en mémoire, puis
   `settled()` (asynchrone) : `PUT` des secrets inline (migration), `GET` de ceux qui manquent. Tant que
   `vaulted()` est faux, `PlanningProvider` ne démarre pas le moteur : une mutation émise sans la DEK
   partirait sans op.
2. `storage.read()` : état absent → création d'un appareil (`randomUuid()`, paire X25519,
   `schemaVersion = LOCAL_SCHEMA_VERSION`), clé privée déposée au coffre — `phase = "unconfigured"`.
3. `PlanningProvider` seed les fixtures si `docs` ne contient aucune entité `task`/`suggestion` : en
   `unconfigured`, les mutations passent par `applyLocal` (référence `${kind}:${id}`, aucun chiffrement,
   aucune op) ; les docs seedés ne partent pas tant qu'aucun compte n'existe.
4. Compte présent → `phase = "offline"` ; `engine.start()` branche les écouteurs `online`/`offline` et
   l'intervalle de 30 s. **Aucune synchro n'est déclenchée au montage.**

### 9.3 Mutation locale (`engine.emitLocal`)

1. refuse si `account` absent, DEK absente, ou doc `readOnly` ;
2. `opId = `${device.id}:${++device.opCounter}``, `hlc = clock.tick()`,
   `entityRef = HMAC(indexKey, `${kind}:${id}`)[0..22]` ;
3. `sealOp(dek, meta, {id, kind, v: LOCAL_SCHEMA_VERSION, op, patch})` ;
4. `applyOp` **immédiat** sur `docs`/`refs` (l'UI n'attend pas le réseau, pas d'aller-retour) ;
5. enfile l'op dans `outbox`, persiste, notifie, programme un flush (debounce 800 ms).

Suppression = même chemin avec `op: "delete"` (tombstone locale immédiate, doc conservé).

### 9.4 Synchro (`syncNow`, single-flight)

1. `push` : batches de **100** ops (`PUSH_BATCH`) ; chaque `acked` sort de l'outbox ; la boucle s'arrête
   quand l'outbox est vide ou qu'aucun progrès n'a été fait ;
2. `pull` : pages de **500** (`PULL_LIMIT`) en boucle jusqu'à `hasMore === false` ; pour chaque op :
   `clock.receive(hlc)`, `cursor = max(cursor, seq)`, déchiffrement (`openOp`), `applyOp` ;
   une op dont le tag échoue est **ignorée** (le curseur avance quand même : §10) ;
3. persiste `docs`/`refs`/`cursor`, écrit `status.lastSyncAt`, `phase = "synced"`.

Le pull exige la DEK : sans elle, la synchro échoue (`clé de chiffrement absente (appareil non appairé)`).

### 9.5 Déclencheurs et reprise

| Déclencheur | Détail |
| --- | --- |
| Mutation locale | debounce **800 ms**, repoussé à chaque mutation (`autoSync` actif). |
| Intervalle | toutes les **30 s** si `autoSync` (défaut `true`). |
| `window online` | synchro immédiate + remise à zéro du backoff. |
| `window offline` | `phase = "offline"` (aucune requête). |
| Appels explicites | `syncNow()` (bouton UI), `loginAccount`, `pairPoll` réussi. |

Backoff : `2 s, 4 s, 8 s, …` plafonné à **60 s**, sans jitter, remis à zéro après succès ou événement
`online`. Réessayés : statut `0` (réseau), `429`, `5xx`. **Non** réessayés : `401`, `409`, `426` et
toute autre erreur 4xx (état terminal).

### 9.6 États exposés (`SyncStatus.phase` + `lastCode`)

| État | Sens | Sortie |
| --- | --- | --- |
| `unconfigured` | aucun compte : tout est local, rien ne part | création de compte, connexion ou appairage |
| `offline` | compte présent, pas de réseau ou échec réseau | succès de synchro, `online` |
| `syncing` | push/pull en cours | `synced` ou `error` |
| `synced` | outbox vide, curseur à jour | nouvelle mutation |
| `error` | erreur terminale (`unauthorized`, `client_too_old`, `not_paired`, 4xx) | action utilisateur |
| `read_only` | `schema_too_new` / `426` : émission suspendue, docs `v` trop récents non éditables | mise à jour du build |

`lastCode` : `offline`, `unauthorized`, `schema_too_new`, `internal_error`, `not_paired`, ou le `code`
serveur. `pending` = longueur de l'outbox.

### 9.7 Comptes et appairage côté moteur

| Opération | Requêtes |
| --- | --- |
| `createAccount` | `POST /auth/register` → `POST /devices` (uuid local, pubKey locale) → `POST /auth/envelope` (dépôt de l'enveloppe (a)) → stocke compte + enveloppes (a) et (b) |
| `loginAccount` | `GET /auth/salt` → Argon2id → `POST /auth/login` → `POST /devices` → décode `keyEnvelope` (`base64url` → JSON) et l'ouvre avec la `kek` ; `null` ou ouverture impossible ⇒ `phase = "error"`, `lastCode = "not_paired"`, sinon enveloppes locales reconstituées puis `syncNow()` |
| `logoutAccount` | `POST /auth/logout` (erreur réseau tolérée) → efface `account` **et** `envelopes.devices` (la DEK reste récupérable par mot de passe via `POST /auth/login`) |
| `pairStart` | `POST /pairing/start` (pollSecret = 32 octets aléatoires) ; mémorise code → `serverUrl` |
| `pairClaim` | `POST /pairing/claim` ; garde la réponse en mémoire, renvoie `{deviceId, fingerprint}` |
| `pairComplete` | `POST /pairing/complete` avec `wrapForDevice(dek, claim.publicKey)` |
| `pairPoll` | `POST /pairing/{code}/poll` ; ouvre l'enveloppe avec la clé privée locale, stocke compte + enveloppe, puis `syncNow()` |
| `listDevices` / `revokeDevice` | `GET /devices` / `DELETE /devices/{id}` |

## 10. Vérification

| Cible | Commande | Couverture |
| --- | --- | --- |
| Serveur (unitaires + intégration) | `cargo test` dans `server/`, base PostgreSQL de dev accessible | 31 tests : dérivation, erreurs, auth/sessions/rate-limit, devices, appairage complet, push/pull, idempotence, pagination, isolation, enveloppe (a) |
| Client (crypto, HLC, fusion, stockage, transport, moteur) | `npm test` | 110 tests |
| Contrat HTTP réel | `npm run e2e` (serveur démarré) | 27 vérifications : inscription, sessions, devices, push/pull/tri, appairage complet, codes d'erreur, nettoyage |
| Chaîne complète client ↔ serveur | `SYNC_LIVE_URL=http://127.0.0.1:8787 npx vitest run src/lib/sync/live-integration.test.ts` | création de compte, push, connexion d'un 2e appareil par mot de passe (enveloppe (a) serveur), propagation d'édition dans les deux sens, appairage d'un 3e appareil, déconnexion |
| Types et bundle | `npm run build` | `tsc --noEmit` + `vite build` |

## 11. Limites connues

| Limite | Effet | Évolution |
| --- | --- | --- |
| `key_envelope` : une seule enveloppe (a) par compte | elle est écrasée à chaque `POST /auth/envelope` ; deux appareils qui changent le mot de passe en parallèle se télescopent (dernier écrivain), et `key_envelope = null` jusqu'au premier dépôt → `loginAccount` en `not_paired` | conserver une enveloppe par version de `kek` |
| `logoutAccount` efface `envelopes.devices` | l'appareil ne peut plus déchiffrer sans se reconnecter (mot de passe) ni sans ré-appairage ; l'enveloppe (a) locale n'est pas réutilisée par `loginAccount`, qui se fie au serveur | réutiliser `envelopes.password` en premier recours, garder l'enveloppe (b) locale |
| HLC non persisté | redémarrage = `wall = now`, `compteur = 0` ; une horloge reculée produit des HLC plus anciens, donc ignorés par la fusion | persister `{wall, counter}` dans `SyncState` |
| op indéchiffrable ignorée, curseur avancé | perte silencieuse et définitive de cette op (aucun compteur d'échec, aucun rejeu) | mettre l'op en quarantaine et ne pas avancer le curseur sur échec de tag |
| tombstones et ops conservés indéfiniment | croissance linéaire du journal et de `localStorage` | compaction serveur + snapshot |
| pas de snapshot | première synchro = rejeu de tout le journal (`since=0`) | `GET /snapshot?asOf=seq` |
| `pairing_sessions` jamais purgée | lignes expirées accumulées, `wrapped_key` conservé côté serveur | tâche de purge (`delete … where expires_at < now()`) |
| aucune rotation de DEK / d'`indexKey` | DEK compromise = historique lisible ; `entityRef` figé | nouvelle DEK + réémission (nouveaux `entityRef`) |
| `subtasks` = un champ | deux coches simultanées : une perdue | id stable par sous-tâche, `subtasks.<id>` |
| documents déchiffrés dans `localStorage` | XSS ⇒ lecture du carnet | stockage chiffré côté client |
| `MIN_CLIENT_SCHEMA` global, appliqué seulement à `/devices` et `/pairing/start` | un vieux build peut encore pousser des ops `schemaVersion` obsolète après appairage | contrôle en tête de `/ops`, seuil par appareil |
| limitations de débit en mémoire | non partagées entre instances, perdues au redémarrage | limiteur en base/Redis |
| `mailKey = account:mailId` (fixtures locales) | ids de suggestion instables si `mailId` change | `account:messageId` (RFC 822) + migration |
| aucune ACL par entité | un compte = un espace | clé de groupe + enveloppes supplémentaires |
