# lavande-sync

Serveur de synchronisation chiffrée de bout en bout de Lavande (Rust, axum 0.8, sqlx 0.8 + PostgreSQL).
Il ne déchiffre jamais rien : il stocke et ordonne des opérations opaques (`nonce` + `ciphertext`).
Le protocole complet (clés, format des ops, fusion, schéma SQL, codes d'erreur, appairage) est décrit dans
[`docs/SYNC.md`](../docs/SYNC.md).

## Prérequis

| Outil | Pourquoi |
| --- | --- |
| Rust stable (`edition 2021`) | compilation du binaire |
| toolchain C (`cc`/`gcc`, paquet `build-essential`) | **édition de liens** : `cargo build` échoue avec `linker 'cc' not found` sans lui |
| PostgreSQL 16 | base `lavande_sync` (le `docker-compose.yml` fourni en démarre une sur le port **55432**) |
| Docker + plugin `docker compose` | base locale et exécution des tests d'intégration |
| Node 22 (optionnel) | seulement pour le test e2e `scripts/e2e-sync.mjs` |

## Démarrage

```sh
# 1. base de données (port 55432, volume lavande_sync_pgdata)
docker compose -f server/docker-compose.yml up -d db

# 2. serveur : les migrations sont appliquées automatiquement au démarrage
cd server && cargo run
```

Le binaire lit un `.env` éventuel **depuis le répertoire courant** (`dotenvy`) : lancez-le depuis `server/`
(copie de `.env.example`), ou exportez les variables. Il écoute par défaut sur
`http://127.0.0.1:8787` et journalise en `info` (`RUST_LOG` pour ajuster).

Hors Docker, il faut aussi le linker C sur l'hôte. Les variables `LAVANDE_SYNC_*` s'exportent dans
l'environnement du processus. Le script `.plasma/cargo.sh` du dépôt exécute `cargo` dans l'image
`rust:1-slim` (qui embarque `gcc`) avec la base en `--network host`, et monte `server/` sur `/src`.

### Migrations

`server/src/db.rs` embarque `sqlx::migrate!("./migrations")` : au démarrage, `main` appelle `db::connect`
puis `db::migrate`, qui applique dans l'ordre `0001_accounts.sql`, `0002_ops_pairing.sql`,
`0003_pairing_v2.sql` (suivi dans `_sqlx_migrations`). Une migration en échec fait échouer le démarrage
(`application des migrations impossible`). Aucune commande manuelle n'est nécessaire.

## Configuration

Toutes les variables du serveur sont préfixées `LAVANDE_SYNC_` (voir `server/.env.example`).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LAVANDE_SYNC_DATABASE_URL` | `postgres://lavande:lavande@127.0.0.1:55432/lavande_sync` | URL PostgreSQL. **Le binaire ne lit pas `DATABASE_URL`** (seuls les tests d'intégration le lisent). |
| `LAVANDE_SYNC_BIND_ADDR` | `127.0.0.1:8787` | adresse d'écoute |
| `LAVANDE_SYNC_SERVER_MAX_SCHEMA` | `1` | version d'op maximale acceptée (`426 schema_too_new` au-delà) |
| `LAVANDE_SYNC_MIN_CLIENT_SCHEMA` | `1` | version client minimale (`409 client_too_old` en dessous, borné par `SERVER_MAX_SCHEMA`) |
| `LAVANDE_SYNC_PAIRING_TTL_SECS` | `300` | durée de vie d'un code d'appairage |
| `LAVANDE_SYNC_SESSION_TTL_SECS` | `2592000` | durée de vie d'une session (30 j, non glissante) |
| `LAVANDE_SYNC_CORS_ORIGINS` | vide | origines autorisées, séparées par des virgules (vide = aucune origine externe) |
| `RUST_LOG` | `info` | filtre `tracing` |

Toute valeur invalide (URL, adresse, entier, incohérence `MIN_CLIENT_SCHEMA > SERVER_MAX_SCHEMA`) fait
échouer le démarrage avec un message explicite.

## Endpoints

Base `/api/v1`, JSON, `Authorization: Bearer <token>`. Erreurs : `{"code": "...", "message": "..."}`.
Détail des corps, des validations et des codes : `docs/SYNC.md` §8.

| Méthode | Chemin | Auth | Réponse |
| --- | --- | --- | --- |
| GET | `/healthz` | non | `{"status":"ok","schemaVersion":1,"minClientSchema":1}` (503 si PostgreSQL ne répond pas) |
| GET | `/api/v1/auth/salt?email=` | non | `{accountSalt}` (404 `unknown_email`) |
| POST | `/api/v1/auth/register` | non | `201 {userId, token, expiresAt, accountSalt}` |
| POST | `/api/v1/auth/login` | non | `{userId, token, expiresAt, accountSalt, keyEnvelope}` |
| POST | `/api/v1/auth/logout` | oui | `204` |
| POST | `/api/v1/auth/envelope` | oui | `204` — dépose/remplace `users.key_envelope` (enveloppe de la DEK chiffrée par le mot de passe, base64url du JSON, ≤ 4096 octets) |
| GET | `/api/v1/me` | oui | `{userId, email, accountSalt, devices}` |
| GET / POST | `/api/v1/devices` | oui | liste ; `201/200 {deviceId}` |
| DELETE | `/api/v1/devices/{id}` | oui | `204` (révoque l'appareil et ses sessions) |
| POST | `/api/v1/pairing/start` | **non** | `201 {code, expiresAt}` |
| POST | `/api/v1/pairing/claim` | oui | `{deviceId, deviceName, platform, publicKey, schemaVersion, fingerprint}` |
| POST | `/api/v1/pairing/complete` | oui | `204` |
| POST | `/api/v1/pairing/{code}/poll` | **non** | `{status:"pending"}` ou `{status:"completed", token, userId, accountSalt, envelope}` |
| POST | `/api/v1/ops` | oui + appareil | `{acked:[opId], nextSeq}` (≤ 200 ops par lot) |
| GET | `/api/v1/ops?since=&limit=` | oui | `{ops, nextSeq, hasMore}` (`limit` ≤ 500) |
| GET | `/api/v1/status` | oui | `{serverSchemaVersion, minClientSchema, headSeq}` |

Les UUID d'appareil sont **choisis par le client** et imposés via `POST /devices {id}` ou
`POST /pairing/start {deviceId}`.

## Tests

```sh
cd server && cargo test            # 31 tests : 11 unitaires + 20 d'intégration
```

Les tests d'intégration (`tests/api_auth.rs`, `tests/api_sync.rs`) ont besoin d'une base joignable sur
`DATABASE_URL` (défaut : `postgres://lavande:lavande@127.0.0.1:55432/lavande_sync`) ; ils appliquent les
migrations eux-mêmes. **Si la base est injoignable, ils s'ignorent proprement** (message
`PostgreSQL injoignable : test ignoré`) au lieu d'échouer : `cargo test` reste vert sans PostgreSQL.
Chaque test crée ses propres comptes (`sync-<uuid>@lavande.test`) et les supprime à la fin.

## Test e2e (bout en bout, serveur réel)

```sh
docker compose -f server/docker-compose.yml up -d db
cd server && cargo run &            # serveur sur 127.0.0.1:8787
node scripts/e2e-sync.mjs           # ou : npm run e2e  (depuis la racine)
```

Le script (`scripts/e2e-sync.mjs`, Node 22, sans dépendance) enchaîne : deux comptes, trois appareils,
push d'ops chiffrées factices, idempotence du push, curseur `since=nextSeq`, pagination, isolation entre
comptes, appairage complet (`start → claim → complete → poll → jeton utilisable`), `GET /status`,
puis nettoyage (révocation des appareils, logout). Cible surchargée par `SYNC_URL`
(défaut `http://127.0.0.1:8787`). Sortie : une ligne `ok`/`FAIL` par vérification, code de sortie `1` en
cas d'échec, `2` si le serveur est injoignable.

## Vérifications manuelles

```sh
cargo build --manifest-path server/Cargo.toml
curl -s localhost:8787/healthz
docker compose -f server/docker-compose.yml exec -T db \
  psql -U lavande -d lavande_sync -c '\dt'
```

Le port `55432` est propre à ce projet : ne pas arrêter les autres conteneurs de la machine.
