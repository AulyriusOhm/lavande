# `mail-core` — moteur mail de Lavande

Crate `crates/mail-core` (package **`lavande-mail`**, lib **`lavande_mail`**). Contient le modèle de
données mail, le parsing MIME, le threading, le store SQLite local et la couche transport IMAP/SMTP.

**Statut : compilé et testé, pas encore branché.** Aucune commande Tauri n'existe, le front tourne
toujours sur les fixtures de `src/lib/mail.ts`. Ce document décrit l'API réelle du crate et le
contrat des commandes à écrire.

## Vue d'ensemble

| Fait | Ne fait pas |
| --- | --- |
| Connexion IMAP TLS implicite ou STARTTLS, auth mot de passe ou XOAUTH2 | Pas de pool de connexions, pas de reconnexion automatique : l'appelant ouvre et ferme la session |
| `LIST` + `STATUS` pour les dossiers, réconciliation par dossier : une passe métadonnées `UID FETCH 1:*`, corps seulement pour les UID nouveaux | Pas de keychain : les secrets vivent dans `AccountConfig`, en mémoire (et en clair dans le JSON IPC) |
| Envoi SMTP (lettre) avec pièces jointes, texte + HTML | Pas de PGP réel : `PgpState` ne fait que détecter `multipart/signed` et `multipart/encrypted` |
| Parsing MIME complet (encodage de transfert, RFC 2047, pièces jointes, aperçu) | Pas de flux navigateur OAuth2 : seul l'échange *refresh token* → *access token* existe |
| Threading déterministe par `References` / `In-Reply-To` / sujet normalisé | Pas d'IDLE ni de push : la synchro est toujours déclenchée par l'appelant |
| Store SQLite (WAL, `user_version`), threads agrégés en Rust à la lecture | Pas de recherche côté serveur (`SEARCH`) : le filtrage reste côté front, sur les données chargées |

## Arborescence

```
crates/mail-core/
├── Cargo.toml            # lavande-mail / lib lavande_mail
├── src/
│   ├── lib.rs            # modules + ré-exports
│   ├── model.rs          # Address, Message, Thread, Folder, Flags, AttachmentMeta, PgpState
│   ├── config.rs         # AccountConfig, AuthConfig, Endpoint, Encryption, FolderMapping
│   ├── error.rs          # MailError
│   ├── mime.rs           # parse_message, ParsedMessage
│   ├── threading.rs      # thread_id, split_ids, normalize_subject
│   ├── store/mod.rs      # Store (rusqlite)
│   ├── store/schema.sql  # schéma embarqué (include_str!)
│   ├── imap.rs           # session, dossiers, réconciliation, flags, move
│   ├── smtp.rs           # envoi
│   ├── oauth.rs          # refresh token + XOAUTH2
│   ├── sync.rs           # sync_account (niveau compte)
│   └── tls.rs            # TlsOptions (racines supplémentaires)
└── tests/                # config, mime, threading, oauth, store (hors-ligne), live (réseau)
```

Ré-exports de `lib.rs` : `AccountConfig`, `AuthConfig`, `Encryption`, `Endpoint`, `FolderMapping`,
`MailError`, `SyncReport`, `parse_message`, `ParsedMessage`, `thread_key`, `Address`,
`AttachmentMeta`, `Flags`, `Folder`, `FolderRole`, `Message`, `PgpState`, `Thread`,
`xoauth2_payload`, `OAuth2Provider`, `XOAuth2Authenticator`, `OutgoingAttachment`,
`OutgoingMessage`, `Store`, `thread_id`, `TlsOptions`.

## API publique

### Modèle (`model.rs`)

```rust
pub struct Address { pub name: Option<String>, pub email: String }

#[serde(rename_all = "lowercase")]
pub enum PgpState { None, Signed, Encrypted }          // Default = None
impl PgpState { pub fn as_str(self) -> &'static str; pub fn from_db(value: &str) -> Self }

#[serde(rename_all = "snake_case")]
pub enum FolderRole { Inbox, Sent, Drafts, Archive, Trash, Spam, Other }  // Default = Other
impl FolderRole { pub fn as_str(self) -> &'static str; pub fn from_db(value: &str) -> Self }

pub struct Folder {
    pub account_id: String, pub path: String, pub name: String, pub role: FolderRole,
    pub uidvalidity: u32, pub uidnext: u32, pub last_sync_at: Option<DateTime<Utc>>,
}

pub struct Flags { pub unread: bool, pub starred: bool, pub answered: bool }  // Default = false

pub struct AttachmentMeta { pub filename: String, pub mime: String, pub size: u64, pub inline: bool }

pub struct Message {
    pub account_id: String, pub folder_path: String,
    pub uid: u32, pub uidvalidity: u32,
    pub thread_id: String,
    pub message_id: Option<String>, pub in_reply_to: Option<String>, pub references: Vec<String>,
    pub from: Address, pub to: Vec<Address>, pub cc: Vec<Address>,
    pub subject: String, pub date: Option<DateTime<Utc>>,
    pub flags: Flags, pub size: u32, pub pgp: PgpState,
    pub preview: String,
    pub body_text: Option<String>, pub body_html: Option<String>,
    pub attachments: Vec<AttachmentMeta>,
}

pub struct Thread {
    pub id: String, pub account_id: String,
    pub messages: Vec<Message>, pub primary: Message,
    pub count: usize, pub unread: usize, pub starred: bool,
    pub encrypted: usize, pub attachments: usize,
    pub participants: Vec<String>, pub subject: String, pub preview: String,
}

/// Clé de thread côté UI : `account_id:thread_id`.
pub fn thread_key(account_id: &str, thread_id: &str) -> String;
```

Tous ces types sont `Serialize + Deserialize` (`serde`), donc directement sérialisables en JSON
d'IPC. `Address`, `AttachmentMeta` et `Flags` sont `Default`.

### Configuration (`config.rs`)

```rust
#[serde(rename_all = "snake_case")]
pub enum Encryption { Tls, StartTls, Plain }

pub struct Endpoint { pub host: String, pub port: u16, pub encryption: Encryption }

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthConfig {
    Password { password: String },
    OAuth2 { client_id: String, client_secret: String, refresh_token: String, token_endpoint: String },
}

pub struct AccountConfig {
    pub id: String, pub label: String, pub email: String, pub username: String,
    pub imap: Endpoint, pub smtp: Endpoint, pub auth: AuthConfig,
}
impl AccountConfig { pub fn validate(&self) -> Result<(), MailError> }

pub struct FolderMapping {
    pub inbox: Option<String>, pub sent: Option<String>, pub drafts: Option<String>,
    pub archive: Option<String>, pub trash: Option<String>, pub spam: Option<String>,
}

pub fn folder_role(path: &str, name: &str, flags: &[String]) -> FolderRole;
pub fn path_for(mapping: &FolderMapping, role: FolderRole) -> Option<&str>;
pub fn leaf_name(path: &str) -> &str;
```

`validate()` rejette : champ `id`/`label`/`email`/`username` vide, `host` ou `port == 0`, tout
endpoint `Plain` (credentials stockés ⇒ TLS obligatoire), mot de passe vide, `client_id` ou
`refresh_token` OAuth2 vide.

`Debug` de `AuthConfig` est écrit à la main : il affiche `password: "<redacted>"`,
`client_secret: "<redacted>"`, `refresh_token: "<redacted>"`. **Ne jamais `{:?}` un autre type qui
embarquerait les secrets** (`AccountConfig` dérive `Debug` et contient `AuthConfig`, donc il est
redacté par transitivité).

Rôle d'un dossier : attributs SPECIAL-USE d'abord (`\Sent`, `\Junk`…), sinon le nom ou le chemin
(anglais **et** français, accents repliés) : `boite de reception`, `envoyes`, `elements envoyes`,
`brouillons`, `archives`, `corbeille`, `indesirables`, `courrier indesirable`.

### `MailError` (`error.rs`)

```rust
pub enum MailError {
    Store(rusqlite::Error),      // "store error: {0}"
    Mime(String),                // "mime error: {0}"
    Io(io::Error),               // "io error: {0}"
    InvalidData(String),         // "invalid data: {0}"
    Json(serde_json::Error),     // "json error: {0}"
    Config(String),              // "config error: {0}"
    Auth(String),                // "auth error: {0}"
    Imap(String),                // "imap error: {0}"
    Smtp(String),                // "smtp error: {0}"
    OAuth(String),               // "oauth error: {0}"
    Tls(String),                 // "tls error: {0}"
}
```

`Display` produit déjà une phrase préfixée : côté Tauri, `error.to_string()` suffit comme message
lisible. `Store::set_flags`/`set_body`/`delete_message` renvoient
`InvalidData("<quoi> not found")` quand aucune ligne n'est touchée ; les variantes batch
(`set_flags_batch`, `delete_messages`) rendent un compte (`0` si rien ne correspond).

### MIME (`mime.rs`)

```rust
pub struct ParsedMessage {
    pub subject: String, pub from: Address, pub to: Vec<Address>, pub cc: Vec<Address>,
    pub date: Option<DateTime<Utc>>,
    pub message_id: Option<String>, pub in_reply_to: Option<String>, pub references: Vec<String>,
    pub body_text: Option<String>, pub body_html: Option<String>,
    pub attachments: Vec<AttachmentMeta>, pub pgp: PgpState, pub preview: String,
}

pub fn parse_message(raw: &[u8]) -> Result<ParsedMessage, MailError>;
```

- `body_text` : premier `text/plain` réel, sinon repli sur le texte extrait du HTML.
- `body_html` : premier `text/html`.
- `preview` : `body_text` compacté (espaces normalisés) puis tronqué aux **200 premiers
  caractères** (`PREVIEW_LEN`), sans points de suspension.
- `attachments` : `filename` = nom de pièce jointe ou `"attachment"`, `mime` reconstruit depuis le
  content-type (défaut `application/octet-stream`), `size` = taille de la partie, `inline` = corps
  `InlineBinary` ou `Content-Disposition: inline`.
- `pgp` : `Encrypted` si une partie `multipart/encrypted`, `Signed` si `multipart/signed`, sinon
  `None`. Aucune vérification cryptographique.
- `message_id` est nettoyé des chevrons ; `references` et `in_reply_to` sont découpés en identifiants
  individuels (`split_ids`).
- Erreur : `MailError::Mime("could not parse message")` si `mail-parser` refuse le message.

### Threading (`threading.rs`)

```rust
pub fn thread_id(
    account_id: &str,
    subject: &str,
    message_id: Option<&str>,
    in_reply_to: Option<&str>,
    references: &[String],
) -> String;

pub fn split_ids(value: &str) -> Vec<String>;
pub fn normalize_subject(subject: &str) -> String;
```

Identifiant de thread = FNV-1a 64 bits, en hexadécimal sur 16 caractères, calculé sur
`"<account_id>\u{1f}<racine>"`. Racine, par ordre de priorité :

1. premier identifiant de `References` ;
2. sinon premier identifiant de `In-Reply-To` ;
3. sinon `Message-ID` ;
4. sinon `subject:<sujet normalisé>`.

Sujet normalisé = préfixes de réponse/transfert retirés en boucle (`re`, `tr`, `fwd`, `fw`, `aw`,
`sv`, `antw`, avec compteur `[2]` / `(2)` éventuel), accents repliés, minuscules, espaces
compactés. L'`account_id` entre dans le hash : deux comptes ne partagent jamais un thread.
`normalize_subject` rend la valeur repliée (elle finit en minuscules) ; `folder_role` réutilise le
même repli d'accents via `fold_accents` (visible en `pub(crate)`).

### IMAP (`imap.rs`)

```rust
pub type ImapSession = async_imap::Session<TlsStream<TcpStream>>;

pub struct SyncReport {
    pub inserted: usize, pub flags_updated: usize, pub removed: usize,
    pub uidvalidity_changed: bool, pub uidnext: u32,
}

pub async fn connect(cfg: &AccountConfig) -> Result<ImapSession, MailError>;
pub async fn connect_with(
    cfg: &AccountConfig, tls_options: &TlsOptions,
) -> Result<ImapSession, MailError>;

pub async fn list_folders(
    session: &mut ImapSession, account_id: &str,
) -> Result<Vec<Folder>, MailError>;

pub async fn sync_folder(
    session: &mut ImapSession, store: &Store,
    account_id: &str, folder_path: &str, mapping: &FolderMapping,
) -> Result<SyncReport, MailError>;

pub async fn fetch_body(
    session: &mut ImapSession, store: &Store,
    account_id: &str, folder_path: &str, uid: u32,
) -> Result<(), MailError>;

pub async fn fetch_flags(
    session: &mut ImapSession, folder_path: &str, uid: u32,
) -> Result<Flags, MailError>;

pub async fn set_flags(
    session: &mut ImapSession, folder_path: &str, uid: u32, flags: &Flags,
) -> Result<(), MailError>;

pub async fn move_message(
    session: &mut ImapSession, store: &Store,
    account_id: &str, from_path: &str, uid: u32, to_path: &str,
) -> Result<(), MailError>;

pub async fn create_folder(session: &mut ImapSession, path: &str) -> Result<(), MailError>;
```

Comportements à connaître :

- `connect` = `connect_with(cfg, &TlsOptions::default())` (racines webpki seules).
- STARTTLS : `read_response` pour la bannière, `STARTTLS`, puis handshake TLS sur le socket nu.
  `Encryption::Plain` est refusé même si `validate()` a été contourné.
- OAuth2 : `AUTHENTICATE XOAUTH2` est d'abord tenté en *SASL-IR* (réponse initiale inline) ; si le
  serveur répond `BAD`, nouvelle tentative en mode challenge/réponse. Une bannière `NO` remonte en
  `MailError::Auth`.
- `list_folders` ignore les dossiers `NoSelect`, fait un `STATUS (UIDVALIDITY UIDNEXT)` par dossier
  (une requête par dossier, pas de batch) et remplit `role` via `config::folder_role`.
- `sync_folder` **réconcilie** le dossier avec l'état serveur : la fonction publique délègue au
  helper privé `reconcile` (qui prend un `Option<&FolderMapping>` : `None` = aucune découverte de
  rôle, cas de `move_message`). Étapes :
  1. `SELECT` du dossier, puis `UIDVALIDITY` et `UIDNEXT` lus sur la mailbox (erreur `MailError::Imap`
     si le serveur ne les expose pas).
  2. `store.get_folder` : si le `UIDVALIDITY` stocké diffère → `store.clear_folder` (messages et
     pièces jointes du dossier vidés, la ligne `folders` survit) et `uidvalidity_changed = true`.
  3. `store.flags_in_folder` : les flags de tous les messages locaux du dossier, **une requête**.
  4. **Une seule** passe métadonnées `UID FETCH 1:* (UID FLAGS RFC822.SIZE)` → `uid -> (Flags, size)`
     pour tout le dossier, sans aucun corps.
  5. Trois ensembles : *disparus* (local − serveur) → `store.delete_messages` ; *flags différents*
     (présents des deux côtés, `Flags` inégaux) → `store.set_flags_batch` ; *nouveaux UID*
     (serveur − local) → téléchargement.
  6. Les corps ne sont demandés que pour les nouveaux UID, **par lots de 500** (`BODY_BATCH`) :
     `UID FETCH uid1,…,uidN (UID BODY.PEEK[])`, puis `mime::parse_message`, `store.upsert_message`
     et `store.relink_replies` sur le `Message-ID`. Un UID que le serveur rend sans corps est ignoré,
     pas fatal.
  7. `store.upsert_folder` avec `uidvalidity`, `uidnext` et `last_sync_at = now()`.
  Coût réseau : `SELECT` + la passe métadonnées (linéaire en nombre de messages du dossier) +
  ⌈nouveaux / 500⌉ requêtes de corps ; un dossier inchangé ne coûte que la passe métadonnées, sans
  un octet de corps. `SyncReport` ne compte que les lignes réellement touchées.
- Le `role` stocké est conservé s'il n'est pas `Other`, sinon déduit de `FolderMapping`, sinon
  `Other`.
- `fetch_body` = `UID FETCH <uid> (BODY.PEEK[])` puis `store.set_body` (ne touche ni les drapeaux ni
  le reste).
- `set_flags` ne pousse que `\Seen` (inversé depuis `unread`) et `\Flagged` ; `\Answered` est lu
  mais **jamais écrit**. Deux `UID STORE` séparés : `+FLAGS` puis `-FLAGS`.
- `move_message` : `UID MOVE` si la capacité `MOVE` est annoncée, sinon `UID COPY` +
  `+FLAGS (\Deleted)` + `UID EXPUNGE` (le flux d'`EXPUNGE` est consommé jusqu'au bout). Côté base, la
  ligne source est **supprimée** (`store.delete_message`) et le dossier destination est **réconcilié**
  (`reconcile(…, None)`) : la ligne locale de la destination est réinsérée avec l'UID réellement
  attribué par le serveur (GreenMail réattribue l'UID au `MOVE`, vérifié en réseau), corps compris.
  Aucun UID n'est supposé conservé, aucune ligne n'est déplacée à la main.
- `create_folder` : un dossier déjà existant n'est pas une erreur (détection par le mot `exist` dans
  le message d'erreur).

### SMTP (`smtp.rs`)

```rust
pub struct OutgoingAttachment { pub filename: String, pub mime: String, pub data: Vec<u8> }

pub struct OutgoingMessage {
    pub from: Address, pub to: Vec<Address>, pub cc: Vec<Address>, pub bcc: Vec<Address>,
    pub subject: String, pub text: String, pub html: Option<String>,
    pub in_reply_to: Option<String>, pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

pub async fn send(cfg: &AccountConfig, message: &OutgoingMessage) -> Result<(), MailError>;
pub async fn send_with(
    cfg: &AccountConfig, message: &OutgoingMessage, tls_options: &TlsOptions,
) -> Result<(), MailError>;
```

- TLS : `Tls::Wrapper` ou `Tls::Required` selon `Encryption`, plus les racines supplémentaires de
  `TlsOptions`.
- Auth : mot de passe (`PLAIN`, `LOGIN`) ou OAuth2 (`XOAUTH2`, mot de passe = access token).
- Aucun destinataire (`to` + `cc` + `bcc` vide) → `MailError::Smtp("no recipient")`.
- `Date` et `Message-ID` sont laissés à `lettre` (`date_now()`, `message_id(None)` ⇒ `<uuid@hostname>`).
- `in_reply_to` et `references` sont attendus **sans chevrons** : `build()` les ré-emballe en `<>`.
- **`OutgoingMessage` et `OutgoingAttachment` ne dérivent pas `Serialize`/`Deserialize`** : il faut
  un DTO côté Tauri, ou ajouter les dérivations (voir Contrat des commandes).

### OAuth2 (`oauth.rs`)

```rust
pub const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

pub fn xoauth2_payload(email: &str, access_token: &str) -> String;  // "user=…\x01auth=Bearer …\x01\x01"

pub struct XOAuth2Authenticator { /* email, access_token */ }
impl XOAuth2Authenticator {
    pub fn new(email: impl Into<String>, access_token: impl Into<String>) -> Self;
}
// impl async_imap::Authenticator pour XOAuth2Authenticator (Response = String)

pub struct OAuth2Provider { /* client_id, client_secret, refresh_token, token_endpoint, http, cache */ }
impl OAuth2Provider {
    pub fn new(
        client_id: impl Into<String>, client_secret: impl Into<String>,
        refresh_token: impl Into<String>, token_endpoint: impl Into<String>,
    ) -> Self;
    pub async fn access_token(&mut self) -> Result<String, MailError>;
}
```

`token_endpoint` vide → `GOOGLE_TOKEN_ENDPOINT`. L'access token est mis en cache mémoire jusqu'à
`expires_in - 60 s`. Un statut non-2xx remonte
`MailError::OAuth("token endpoint refused the refresh token (<code>): <error> (<description>)")`, sans
les secrets.

### TLS (`tls.rs`)

```rust
pub struct TlsOptions { pub extra_roots_pem: Vec<Vec<u8>> }   // Default = aucune racine ajoutée
```

Sert aux tests (certificat auto-signé de GreenMail) et, plus tard, à une AC d'entreprise. Les
racines webpki sont toujours présentes ; les extra s'ajoutent.

### Store (`store/mod.rs`)

```rust
pub struct Store { /* Connection rusqlite */ }

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MailError>;
    pub fn open_in_memory() -> Result<Self, MailError>;
    pub fn migrate(&self) -> Result<(), MailError>;

    pub fn upsert_account(&self, id: &str, label: &str, email: &str) -> Result<(), MailError>;
    pub fn upsert_folder(&self, folder: &Folder) -> Result<(), MailError>;
    pub fn get_folder(&self, account_id: &str, path: &str) -> Result<Option<Folder>, MailError>;

    pub fn upsert_message(&self, message: &Message) -> Result<(), MailError>;
    pub fn get_message(
        &self, account_id: &str, folder_path: &str, uid: u32,
    ) -> Result<Option<Message>, MailError>;
    pub fn flags_in_folder(
        &self, account_id: &str, folder_path: &str,
    ) -> Result<HashMap<u32, Flags>, MailError>;
    pub fn set_flags(
        &self, account_id: &str, folder_path: &str, uid: u32, flags: &Flags,
    ) -> Result<(), MailError>;
    pub fn set_flags_batch(
        &self, account_id: &str, folder_path: &str, updates: &[(u32, Flags)],
    ) -> Result<usize, MailError>;
    pub fn set_body(
        &self, account_id: &str, folder_path: &str, uid: u32,
        text: Option<&str>, html: Option<&str>,
    ) -> Result<(), MailError>;
    pub fn delete_message(
        &self, account_id: &str, folder_path: &str, uid: u32,
    ) -> Result<(), MailError>;
    pub fn delete_messages(
        &self, account_id: &str, folder_path: &str, uids: &[u32],
    ) -> Result<usize, MailError>;
    pub fn clear_folder(&self, account_id: &str, folder_path: &str) -> Result<usize, MailError>;
    pub fn relink_replies(
        &self, account_id: &str, message_id: &str, thread_id: &str,
    ) -> Result<usize, MailError>;

    pub fn messages_in_folder(
        &self, account_id: &str, folder_path: &str, limit: i64, offset: i64,
    ) -> Result<Vec<Message>, MailError>;
    pub fn threads_in_folder(
        &self, account_id: &str, folder_path: &str,
    ) -> Result<Vec<Thread>, MailError>;
}
```

Détails :

- `from_connection` (privé) active `PRAGMA foreign_keys` et tente `journal_mode=WAL` (échec ignoré :
  une base `:memory:` le refuse).
- `migrate` est idempotent, piloté par `PRAGMA user_version` (`SCHEMA_VERSION = 1`). Il faut
  l'appeler une fois à l'ouverture.
- `messages_in_folder` trie `date DESC, uid DESC`; `limit <= 0` = tout. `offset` sert à la pagination.
- `threads_in_folder` regroupe en mémoire (tous les messages du dossier, pas de pagination), trie chaque
  thread du plus récent au plus ancien, `primary` = message le plus récent, `subject` = celui du plus
  ancien. `preview` = `"Prénom : aperçu"` sauf si le dossier a le rôle `Sent` (aperçu brut, sans
  participants). `encrypted` compte les `PgpState::Encrypted`, `attachments` la somme des pièces
  jointes.
- `flags_in_folder` : `SELECT uid, unread, starred, answered … WHERE account_id = ?1 AND
  folder_path = ?2`, **une requête** → `HashMap<uid, Flags>` du dossier (vide si rien).
- `set_flags_batch` : une seule instruction `WITH updates (uid, unread, starred, answered) AS
  (VALUES …) UPDATE messages … FROM updates`, dans une transaction `unchecked_transaction`; rend le
  nombre de lignes touchées, `&[]` → `0` (aucune requête).
- `delete_messages` : messages **et** pièces jointes du dossier pour les UID donnés, une transaction;
  rend le nombre de **messages** supprimés, `uids` vide → `0`. `delete_message` y délègue (`&[uid]`)
  et remonte `InvalidData("message not found")` si la ligne n'existait pas.
- **Pas de déplacement de ligne dans le Store** : déplacer la ligne avec l'UID source donnait un UID
  faux. Le déplacement vit dans `imap::move_message`, qui supprime la source et réconcilie la
  destination.
- Un `#[cfg(test)] mod tests` interne couvre `delete_messages` (les pièces jointes du message
  supprimé disparaissent aussi).
- `relink_replies` rattache à `thread_id` tous les messages du compte dont `in_reply_to = message_id`
  ou dont le JSON `references` contient `message_id` (`instr(...) > 0`, donc correspondance de
  sous-chaîne).
- Les dates sont écrites en RFC 3339 à la seconde (`SecondsFormat::Secs`, suffixe `Z`) et relues en
  `DateTime<Utc>`; une date illisible remonte `InvalidData("invalid date: …")`.
- **Aucune méthode de lecture des comptes** (`list_accounts`) ni des dossiers d'un compte
  (`list_folders`) : seuls `upsert_account` et `get_folder(account, path)` existent. À ajouter le
  jour du branchement.

### Synchro compte (`sync.rs`)

```rust
pub async fn sync_account(
    store: &Store, cfg: &AccountConfig, mapping: &FolderMapping,
) -> Result<Vec<(String, SyncReport)>, MailError>;
```

`validate()` → `upsert_account` → `connect` → `list_folders` + `upsert_folder` pour chaque dossier →
`sync_folder` **uniquement pour les dossiers de rôle `Inbox` et `Sent`** → `logout`. Le vecteur
retourné associe le chemin du dossier à son `SyncReport`.

## Schéma SQLite

`schema.sql` est embarqué (`include_str!`) et appliqué d'un bloc par `migrate()`.

```sql
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    label TEXT,
    email TEXT
);

CREATE TABLE IF NOT EXISTS folders (
    account_id TEXT,
    path TEXT,
    name TEXT,
    role TEXT,
    uidvalidity INTEGER,
    uidnext INTEGER,
    last_sync_at TEXT,
    PRIMARY KEY (account_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
    account_id TEXT,
    folder_path TEXT,
    uid INTEGER,
    uidvalidity INTEGER,
    thread_id TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    references_json TEXT,
    from_json TEXT,
    to_json TEXT,
    cc_json TEXT,
    subject TEXT,
    date TEXT,
    unread INTEGER,
    starred INTEGER,
    answered INTEGER,
    size INTEGER,
    pgp TEXT,
    preview TEXT,
    body_text TEXT,
    body_html TEXT,
    PRIMARY KEY (account_id, folder_path, uid)
);

CREATE TABLE IF NOT EXISTS attachments (
    account_id TEXT,
    folder_path TEXT,
    uid INTEGER,
    idx INTEGER,
    filename TEXT,
    mime TEXT,
    size INTEGER,
    inline INTEGER,
    PRIMARY KEY (account_id, folder_path, uid, idx)
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date
    ON messages (account_id, folder_path, date DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON messages (account_id, thread_id);
```

### Invariants

- **Clé d'un message : `(account_id, folder_path, uid)`.** `uidvalidity` est stocké par ligne mais
  **ne fait pas partie de la clé** : c'est `sync_folder` qui garantit la cohérence en appelant
  `clear_folder` dès que le `UIDVALIDITY` du serveur diffère de celui du dossier stocké, puis en
  réinsérant tout. Conséquence pratique : un UID est unique par dossier *pour un `UIDVALIDITY`
  donné* ; deux époques ne coexistent jamais en base.
- `thread_id` est **matérialisé sur la ligne message** (pas de table de threads). Il est calculé une
  fois, à l'insertion, par `threading::thread_id`; un message arrivé avant son parent est rattaché
  après coup par `relink_replies` (appelé à chaque insertion qui porte un `Message-ID`).
- `folders` porte l'état de synchro : `uidnext` = `UIDNEXT` annoncé par le serveur au dernier
  passage (valeur informative : la réconciliation ne repart pas de là), `last_sync_at` = dernier
  passage réussi. `migrate` ne touche pas aux données, `user_version = 1` sert de garde.
- **La base reflète l'état serveur après chaque synchro.** Disparitions (UID absent côté serveur)
  supprimées par `delete_messages`, flags alignés par `set_flags_batch`, nouveaux UID insérés;
  `UIDVALIDITY` changé → `clear_folder` puis réinsertion complète. Corollaire : un UID stocké sans
  contrepartie serveur est un état transitoire, pas un état stable.
- `messages` n'a **pas de contrainte de clé étrangère** vers `accounts`/`folders` (aucun
  `REFERENCES`) ; `foreign_keys=ON` est donc décoratif aujourd'hui. Supprimer un compte ne supprime
  rien : `delete_message` / `delete_messages` / `clear_folder` sont les seules suppressions.
- Les pièces jointes sont dans une table séparée, indexées par `idx` (ordre MIME), remplacées avec
  leur message par `upsert_message` et supprimées avec lui (transactions `unchecked_transaction`).
- `references`, `from`, `to`, `cc` sont du JSON texte (`from_json` tolère la chaîne vide → `Default`).
- Les threads ne sont pas stockés : `threads_in_folder` les recalcule à chaque lecture.

## Correspondance avec le front

Côté front : `src/lib/mail.ts` (`Mail`, `FolderId`, `PgpState`, `TONES`) et `src/lib/threads.ts`
(`Thread`, `threadKey`, `buildThreads`).

### `Message` (Rust) → `Mail` (TS)

| `Mail` | Source Rust | Remarque |
| --- | --- | --- |
| `id: string` | *(aucun)* | À construire : `` `${account_id}:${folder_path}:${uid}` `` (ou `uidvalidity` en plus). Côté front, `id` est opaque et sert de clé React/undo. |
| `account: "perso" \| "pro" \| "gmail"` | `account_id` | Le front n'accepte que 3 littéraux : à élargir à `string`, ou à contraindre l'`id` des comptes réels. |
| `folder: FolderId` | `folder_path` + `Folder.role` | Mapping : `Inbox→inbox`, `Sent→sent`, `Archive→archive`, `Trash→trash`, `Spam→spam`. `FolderRole::Drafts` et `Other` **n'ont pas** de `FolderId` : à trancher (ignorer, ou ajouter `drafts`). |
| `threadId?: string` | `thread_id` | Direct. |
| `previousFolder?: FolderId` | *(aucun)* | État d'annulation local au front (archivage/suppression), à garder côté UI. |
| `name`, `email` | `from.name`, `from.email` | `from.name` est `Option` : repli sur `from.email`. |
| `to?: string` | `to: Vec<Address>` | Le front ne garde qu'un destinataire (`firstRecipient`). Repli : premier de `to`. |
| `subject` | `subject` | Direct. |
| `preview` | `preview` | Déjà calculé et tronqué à 200 caractères. `threads.ts` y préfixe `"Prénom : "` (hors `Sent`) : cette règle reste au front, le store Rust la reproduit de son côté pour `Thread.preview`. |
| `body: string[]` | `body_text: Option<String>` | Le front stocke un tableau de paragraphes : découper sur `\n`. `body_html` n'a **aucun** équivalent (le lecteur front affiche du texte). |
| `time: string` | `date: Option<DateTime<Utc>>` | **Formatage côté front** : `HH:MM` du jour, `"Hier"`, `"dim."`… Rust ne fournit que l'instant UTC. |
| `date?: string` | `date` (même champ) | Idem : `"mardi 10 novembre 2026 · 11:02"` est produit par `Intl.DateTimeFormat("fr-FR")` dans `store.tsx` (`sendDraft`). À extraire dans un helper pour le bridge. |
| `unread`, `starred` | `flags.unread`, `flags.starred` | Directs. |
| *(rien)* | `flags.answered` | Aucun affichage aujourd'hui. |
| `pgp: PgpState` | `pgp` | Mêmes trois valeurs (`"none" \| "signed" \| "encrypted"`), serde `lowercase`. |
| `attachments?: { name, size }[]` | `attachments: Vec<AttachmentMeta>` | `AttachmentMeta` vit **sur le message** (et en table `attachments` en base). `name ← filename`, `size ← size` (octets, à formater en `"4,2 Mo"` côté front). `mime` et `inline` ne sont pas affichés aujourd'hui ; le contenu binaire n'est **pas** stocké. |
| `tone: number` | *(aucun)* | Pure présentation : index dans `TONES` (`mail.ts`), dérivé du compte (`accounts.ts`) ou du hash de l'expéditeur. Reste au front. |
| *(rien)* | `cc`, `size`, `message_id`, `in_reply_to`, `references`, `uid`, `uidvalidity` | Pas d'équivalent front, mais nécessaires au bridge (clé, réponse, threading, envoi). |

### `Thread` (Rust) → `Thread` (TS)

| `Thread` (TS) | Source Rust | Remarque |
| --- | --- | --- |
| `id` | `thread_key(account_id, thread_id)` = `` `${account}:${threadId}` `` | Le Rust expose `id` (thread_id nu) **et** `account_id` : composer côté bridge, sinon les threads de deux comptes se mélangent dans la boîte unifiée. |
| `messages: Mail[]` | `messages: Vec<Message>` | À convertir message par message. |
| `primary: Mail` | `primary` | Direct (le plus récent). |
| `count`, `unread`, `starred`, `encrypted`, `attachments`, `participants`, `subject`, `preview` | mêmes champs | Calculés par `threads_in_folder`, déjà triés. |
| `time: string` | `primary.date` | À formater côté front (même helper que `Mail.time`). |
| `order: number` | *(aucun)* | Le front trie par `order` (index dans la liste source). Avec le backend, l'ordre est déjà donné par `threads_in_folder` : remplir `order` avec l'index d'itération, ou trier sur `primary.date`. |
| *(rien)* | `account_id` | Utile au bridge pour filtrer, inutile côté TS (déjà dans `id`). |

### À créer côté front (pas d'équivalent aujourd'hui)

- Un type `Mail.id` stable dérivé de `(account_id, folder_path, uid)`.
- L'élargissement de `Mail.account` (littéraux) et le passage de `FolderId` (5 valeurs) à un couple
  `role + path` : les dossiers réels sont des chemins serveur arbitraires (`"INBOX/Archives 2024"`).
- Un type compte issu de `AccountConfig` : `accounts.ts` porte `provider`, `color`, `tone`, `synced`
  que le crate ne connaît pas (pur affichage).
- L'affichage HTML (`body_html`) et les pièces jointes binaires : aujourd'hui rien ne les consomme.
- La recherche : `mailMatches` filtre en mémoire sur `MAILS`. Avec le backend il n'y a **aucune**
  recherche serveur ; il faudra soit charger puis filtrer (comportement actuel), soit ajouter un
  `SEARCH` IMAP au crate.

## Contrat des futures commandes Tauri

**Aucune de ces commandes n'est implémentée.** Payloads en JSON **snake_case** (les types du crate
dérivent `Serialize`/`Deserialize`; `Encryption`, `FolderRole`, `PgpState` sont renommés en
snake_case/lowercase par serde). Toutes retournent `Result<T, String>` avec
`Err(MailError::to_string())`.

| Commande | Entrée | Sortie | Fonction du crate |
| --- | --- | --- | --- |
| `add_account` | `AccountConfig` | `AccountSummary` | `AccountConfig::validate` → `Store::upsert_account` (+ `sync_account` si synchro demandée) |
| `list_accounts` | — | `Vec<AccountSummary>` | *(à ajouter : `Store::list_accounts`)* |
| `sync_folder` | `{ account_id, folder_path }` | `SyncReport` | `imap::connect_with` → `imap::sync_folder` (réconciliation complète du dossier : suppressions, flags, nouveaux corps) |
| `list_threads` | `{ account_id, folder_path }` | `Vec<Thread>` | `Store::threads_in_folder` (+ `thread_key` côté bridge) |
| `get_message` | `{ account_id, folder_path, uid, fetch_body? }` | `Message` | `Store::get_message`, puis `imap::fetch_body` si le corps manque |
| `set_flags` | `{ account_id, folder_path, uid, unread, starred }` | `()` | `imap::set_flags` puis `Store::set_flags` |
| `move_message` | `{ account_id, from_path, uid, to_path }` | `()` | `imap::move_message` (supprime la ligne source, réconcilie la destination : l'UID local devient celui du serveur) |
| `send_message` | `{ account_id, message: OutgoingMessageDto }` | `()` | `smtp::send_with` |

### Signatures (non implémentées)

```rust
#[tauri::command]
async fn add_account(state: State<'_, MailState>, config: AccountConfig) -> Result<AccountSummary, String>;

#[tauri::command]
async fn list_accounts(state: State<'_, MailState>) -> Result<Vec<AccountSummary>, String>;

#[tauri::command]
async fn sync_folder(
    state: State<'_, MailState>, account_id: String, folder_path: String,
) -> Result<SyncReport, String>;

#[tauri::command]
async fn list_threads(
    state: State<'_, MailState>, account_id: String, folder_path: String,
) -> Result<Vec<Thread>, String>;

#[tauri::command]
async fn get_message(
    state: State<'_, MailState>, account_id: String, folder_path: String, uid: u32,
) -> Result<Message, String>;

#[tauri::command]
async fn set_flags(
    state: State<'_, MailState>,
    account_id: String, folder_path: String, uid: u32, unread: bool, starred: bool,
) -> Result<(), String>;

#[tauri::command]
async fn move_message(
    state: State<'_, MailState>,
    account_id: String, from_path: String, uid: u32, to_path: String,
) -> Result<(), String>;

#[tauri::command]
async fn send_message(
    state: State<'_, MailState>, account_id: String, message: OutgoingMessageDto,
) -> Result<(), String>;
```

`MailState` n'existe pas encore : c'est l'état partagé décrit plus bas (`Store` sous `Mutex`, plus
les `AccountConfig`). `OutgoingMessageDto` est à écrire : `OutgoingMessage` **n'est pas**
`Deserialize` (champs `Vec<u8>` pour les pièces jointes, ce qui suppose du base64 côté JSON).

### Exemples de payloads

`add_account` (entrée) :

```json
{
  "id": "perso",
  "label": "Perso",
  "email": "roman@lavande.mail",
  "username": "roman@lavande.mail",
  "imap": { "host": "imap.lavande.mail", "port": 993, "encryption": "tls" },
  "smtp": { "host": "smtp.lavande.mail", "port": 465, "encryption": "tls" },
  "auth": { "kind": "password", "password": "secret" }
}
```

Variante OAuth2 (`auth`) :

```json
{ "kind": "oauth2", "client_id": "…", "client_secret": "…",
  "refresh_token": "…", "token_endpoint": "https://oauth2.googleapis.com/token" }
```

`add_account` (sortie) — forme proposée, cohérente avec `accounts.ts` :

```json
{ "id": "perso", "label": "Perso", "email": "roman@lavande.mail", "folders": 6 }
```

`sync_folder` (sortie) :

```json
{ "inserted": 42, "flags_updated": 3, "removed": 1, "uidvalidity_changed": false, "uidnext": 1207 }
```

`list_threads` (sortie, tronquée) :

```json
[
  {
    "id": "perso:9f3c1a77b2e40d18",
    "account_id": "perso",
    "count": 3, "unread": 1, "starred": true, "encrypted": 2, "attachments": 2,
    "participants": ["Camille", "Marc"],
    "subject": "Maquettes mobiles — version 3",
    "preview": "Camille : J'ai poussé la v3.1 dans Figma…",
    "primary": {
      "account_id": "perso", "folder_path": "INBOX", "uid": 1206, "uidvalidity": 7,
      "thread_id": "9f3c1a77b2e40d18",
      "from": { "name": "Camille Rousseau", "email": "camille@studio-lilas.fr" },
      "to": [{ "name": "Roman", "email": "roman@lavande.mail" }],
      "cc": [], "references": ["a@studio-lilas.fr", "b@studio-lilas.fr"],
      "in_reply_to": "b@studio-lilas.fr",
      "message_id": "c@studio-lilas.fr",
      "subject": "Re: Maquettes mobiles — version 3",
      "date": "2026-11-10T10:02:00Z",
      "flags": { "unread": true, "starred": false, "answered": false },
      "size": 48120, "pgp": "encrypted", "preview": "J'ai poussé la v3.1 dans Figma, les deux barres sont décollées",
      "body_text": null, "body_html": null,
      "attachments": [{ "filename": "inbox-v3.fig", "mime": "application/octet-stream", "size": 4404019, "inline": false }]
    }
  }
]
```

Les identifiants de message (`message_id`, `in_reply_to`, `references`) sont stockés **sans
chevrons** (`mime.rs` les nettoie) : ce sont ces valeurs qu'il faut réinjecter dans
`send_message`.

`set_flags` (entrée) :

```json
{ "account_id": "perso", "folder_path": "INBOX", "uid": 1206, "unread": false, "starred": true }
```

`send_message` (entrée) — DTO proposé, pièces jointes en base64 :

```json
{
  "account_id": "perso",
  "message": {
    "from": { "name": "Roman", "email": "roman@lavande.mail" },
    "to": [{ "name": "Camille", "email": "camille@studio-lilas.fr" }],
    "cc": [], "bcc": [],
    "subject": "Re: Maquettes mobiles — version 3",
    "text": "Les contrastes passent mieux en extérieur.",
    "html": null,
    "in_reply_to": "b@studio-lilas.fr",
    "references": ["a@studio-lilas.fr", "b@studio-lilas.fr"],
    "attachments": [{ "filename": "specs-mobile.pdf", "mime": "application/pdf", "data": "JVBERi0xLjQK…" }]
  }
}
```

### Erreurs par commande

| Commande | Erreurs attendues (`MailError`) |
| --- | --- |
| `add_account` | `Config` (champ vide, endpoint `plain`), `Store` (base inaccessible), `Auth`/`Imap` si synchro immédiate. Un `id` déjà présent est **mis à jour**, pas rejeté (`ON CONFLICT DO UPDATE`) |
| `list_accounts` | `Store` |
| `sync_folder` | `Config`, `Auth`, `Tls`, `Imap` (dossier absent, pas de `UIDVALIDITY`/`UIDNEXT`), `Mime`, `Store` |
| `list_threads` | `Store` |
| `get_message` | `Store` (`get_message` renvoie `Ok(None)` quand l'UID est absent : à traduire en erreur lisible côté commande), `Imap`, `Mime` |
| `set_flags` | `Auth`, `Imap`, `Store` (`InvalidData("message not found")`) |
| `move_message` | `Auth`, `Imap` (pas de `MOVE`/`COPY`, dossier cible absent), `Mime` (corps illisible pendant la réconciliation de la destination), `Store` |
| `send_message` | `Smtp` (`"no recipient"`, refus serveur), `Tls`, `OAuth`, `Config` |

Rappel : `Display` fournit déjà `"imap error: …"`, `"auth error: …"`, etc. Le front peut afficher
`String` tel quel ; il ne faut pas renvoyer le `Debug` d'`AccountConfig`.

## Stratégie de cohabitation

### Mode démo (aujourd'hui)

`src/lib/store.tsx` initialise `const [mails, setMails] = useState<Mail[]>(MAILS)` : toute l'app lit
et mute ce tableau en mémoire (archivage, étoile, envoi, annulation). Aucun appel réseau. Les écrans
sont fonctionnels et couvrent déjà les gestes que le backend devra servir.

### Bascule par drapeau explicite

```
VITE_MAIL_BACKEND=demo    # défaut
VITE_MAIL_BACKEND=tauri
```

Lu **une seule fois**, côté front, dans un module dédié (`src/lib/backend.ts`) :

```ts
export const mailBackend = import.meta.env.VITE_MAIL_BACKEND === "tauri" ? "tauri" : "demo";
```

C'est là que vivrait l'unique import de `@tauri-apps/api/core` :

```ts
import { invoke } from "@tauri-apps/api/core";
export const listThreads = (accountId: string, folderPath: string) =>
  invoke<Thread[]>("list_threads", { accountId, folderPath });
```

Aucun autre module ne connaît le backend : `src/lib/store.tsx` choisit entre `MAILS` et un chargement
initial par `invoke`, et ses actions (`mailAction`, `toggleStar`, `sendDraft`) appellent soit la
mutation locale actuelle, soit la commande correspondante. Tant que le drapeau vaut `demo`, le
comportement actuel est strictement inchangé (et `npm run build` reste vert sans Tauri).

### Le jour du branchement

1. **Dépendance** : `lavande-mail = { path = "../crates/mail-core" }` dans `src-tauri/Cargo.toml`
   (le workspace racine `exclude` `src-tauri`, donc chemin direct, pas de membre). Attention :
   `rusqlite` est en `bundled` → il faut un compilateur C au build Tauri (même contrainte que sur
   cette machine).
2. **État partagé** : `rusqlite::Connection` est `Send` mais pas `Sync` ; `tauri::State` exige
   `Send + Sync`. Créer un `MailState { store: Mutex<Store>, accounts: RwLock<HashMap<String, AccountConfig>> }`,
   ouvert via `Store::open(app.path().app_data_dir()?.join("mail.db"))` puis `store.migrate()`, et
   l'enregistrer avec `.manage(MailState { .. })`.
3. **Sessions IMAP** : une `ImapSession` n'est pas réutilisable entre commandes (pas de pool) :
   chaque commande réseau ouvre sa session, fait son travail, `logout()`. Le `Store` reste la seule
   chose persistante.
4. **Enregistrement** : `.invoke_handler(tauri::generate_handler![add_account, list_accounts, sync_folder, list_threads, get_message, set_flags, move_message, send_message])`
   dans `src-tauri/src/lib.rs`, qui n'a aujourd'hui que `tauri::Builder::default().run(...)`.
5. **Permissions** : `src-tauri/capabilities/default.json` n'accorde que `core:default`. Les
   commandes définies dans l'app elle-même ne passent pas par les capacités (elles ne seraient
   filtrées que si on les emballait dans un plugin) ; en revanche, tout accès au système de fichiers
   ou au keychain passera par un plugin, donc par une permission à ajouter ici.
6. **Secrets** : aucun keychain dans le crate. Tant qu'il n'y en a pas, les mots de passe vivent en
   mémoire (`AccountConfig`) et transitent en clair dans l'IPC. À traiter avant tout usage réel.
7. **Conversion** : écrire la couche `Message → Mail` / `Thread → Thread` (table ci-dessus) dans un
   seul fichier front (`src/lib/bridge.ts`), formatage `time`/`date` inclus.

## Tests

### Hors-ligne (44 tests, `cargo test -p lavande-mail`)

Presque tout est dans `tests/`, sans réseau ; le seul `#[cfg(test)] mod tests` de `src/` est dans
`store/mod.rs` (suppression des pièces jointes par `delete_messages`).

| Fichier | Tests | Couverture |
| --- | --- | --- |
| `tests/config.rs` | 9 | SPECIAL-USE prioritaire sur le nom, noms anglais/français, `Other`, `path_for`, `validate` (TLS/STARTTLS acceptés, `plain` refusé, champs vides), `Debug` sans secret |
| `tests/mime.rs` | 11 | message texte simple, quoted-printable, repli HTML → texte, préférence `text/plain`, métadonnées de pièces jointes, `PgpState`, aperçu compacté/tronqué, en-têtes de threading, en-têtes absents |
| `tests/threading.rs` | 7 | `References` prioritaire, repli `In-Reply-To`, repli sujet (préfixes + accents), isolation par compte, `Message-ID` de repli, `split_ids` |
| `tests/oauth.rs` | 4 | payload XOAUTH2, cache de l'access token, rafraîchissement après expiration, message d'erreur lisible sans secret (serveur HTTP local) |
| `tests/store.rs` | 12 | upsert idempotent, flags/corps/`delete_message`, `flags_in_folder`, `delete_messages` (vide → 0, UID inconnus ignorés, pièces jointes emportées), `set_flags_batch` (même sémantique), tri `date DESC` + pagination, agrégation des threads, absence de préfixe expéditeur dans `Sent`, migration rejouable, relecture des dossiers, `relink_replies`, `clear_folder` |
| `src/store/mod.rs` (`mod tests`) | 1 | `delete_messages` supprime aussi les pièces jointes du message |
| `tests/live.rs` | 9 | réseau, `#[ignore]` (voir ci-dessous) |

Sur cette machine (pas de compilateur C système, `rusqlite`/`ring` en ont besoin) :

```sh
export PATH=/home/roman/.local/opt/lavande-cc:$PATH
export CC=/home/roman/.local/opt/lavande-cc/cc
export CXX=/home/roman/.local/opt/lavande-cc/c++
npm run mail:test          # cargo test -p lavande-mail
```

### Réseau (`tests/live.rs`, 9 scénarios, ignorés par défaut)

```sh
scripts/mail-test-server.sh start      # conteneur lavande-mail-test (GreenMail)
npm run mail:test:live                 # cargo test ... --test live -- --ignored --test-threads=1
scripts/mail-test-server.sh stop       # ou `reset` = stop + start
scripts/mail-test-server.sh status
```

`--test-threads=1` est obligatoire : tous les scénarios partagent la même INBOX et préfixent leurs
sujets par `[live-<nom>]` pour ne lire que leurs propres messages. Le certificat TLS auto-signé est
généré par le script dans `$LAVANDE_MAIL_TEST_DIR` (défaut `~/.cache/lavande/mail-test` :
`cert.pem`, `key.pem`, `greenmail.p12`) et chargé via `TlsOptions.extra_roots_pem`.

| Test | Ce qu'il valide |
| --- | --- |
| `implicit_tls_lists_inbox_with_role` | TLS implicite + `LIST` + `STATUS` : l'INBOX est trouvée et porte le rôle `Inbox` |
| `smtp_send_then_sync_parses_message` | envoi SMTP réel, puis `sync_folder` insère le message (`inserted >= 1`), `from`/`unread`/`preview`/`thread_id` corrects ; un second sync ne change rien (`inserted`, `flags_updated` et `removed` à 0) |
| `flags_reach_the_server` | `set_flags` pousse bien `\Seen` + `\Flagged` (relus par une session neuve via `fetch_flags`), puis le retrait de l'étoile est effectif |
| `flags_from_another_client_are_pulled` | flags modifiés côté serveur par une session brute (`+FLAGS (\Seen \Flagged)`) : la synchro suivante les ramène (`flags_updated >= 1`, `unread == false`, `starred == true`) sans retélécharger le message |
| `expunged_message_disappears_locally` | message expurgé côté serveur (`+FLAGS (\Deleted)` + `UID EXPUNGE`) : la synchro suivante le supprime en base (`removed >= 1`, `get_message` → `None`, absent du listing) |
| `unchanged_folder_reports_nothing` | deux synchros d'affilée sans changement : `inserted`, `flags_updated` et `removed` à 0 et `uidvalidity_changed == false` (la réconciliation est idempotente) |
| `move_keeps_store_in_step_with_server` | `create_folder` deux fois (idempotent), `move_message` INBOX → Archive (capacité `MOVE`) : la ligne INBOX disparaît, la ligne Archive réapparaît **avec l'UID réattribué par le serveur** et son corps, `fetch_body` fonctionne dessus, et une session neuve confirme que tous les UID locaux d'Archive existent côté serveur |
| `reply_joins_the_thread` | une réponse (`In-Reply-To` + `References` = `Message-ID` du parent) rejoint le thread du parent : `thread_id` identique, un seul thread de `count == 2` |
| `xoauth2_authenticates_with_refresh_token` | échange refresh token contre un endpoint HTTP local (mock), puis `AUTHENTICATE XOAUTH2` (SASL-IR) sur GreenMail |

Variables lues par `tests/live.rs` :

| Variable | Défaut |
| --- | --- |
| `MAIL_TEST_IMAP` | `localhost:3993` (IMAPS) |
| `MAIL_TEST_SMTP` | `localhost:3465` (SMTPS) |
| `MAIL_TEST_USER` | `roman@lavande.test` |
| `MAIL_TEST_PASSWORD` | `secret` |
| `MAIL_TEST_TLS_DIR` | `$HOME/.cache/lavande/mail-test` (doit contenir `cert.pem`) |

Variables lues par `scripts/mail-test-server.sh` : `LAVANDE_MAIL_TEST_DIR`, `…_IMAP_PORT` (3143),
`…_IMAPS_PORT` (3993), `…_SMTP_PORT` (3025), `…_SMTPS_PORT` (3465), `…_USER`, `…_PASSWORD`.

## Limites assumées

- **STARTTLS non testé.** GreenMail ne l'annonce pas ; seul le TLS implicite est validé en réseau. Le
  chemin `Encryption::StartTls` existe dans `connect_with` mais aucun test ne l'exécute, et
  `Tls::Required` côté SMTP n'est pas couvert non plus.
- **Pas de CONDSTORE/QRESYNC.** Sans `HIGHESTMODSEQ`, la synchro ne peut pas demander « ce qui a changé
  depuis » : chaque passage fait une passe métadonnées complète du dossier (`UID FETCH 1:* (UID FLAGS
  RFC822.SIZE)`), donc un coût linéaire en nombre de messages — le compromis de Thunderbird sans
  CONDSTORE. Les corps, eux, ne sont tirés que pour les nouveaux UID.
- **Pas d'IDLE ni de push.** Rien n'arrive tout seul : la synchro est déclenchée par l'appelant, à la
  demande ou par un polling applicatif à écrire. Un changement serveur n'est visible qu'après un
  `sync_folder`.
- **Aucune suppression poussée vers le serveur.** Le crate sait supprimer **localement**
  (`Store::delete_message`/`delete_messages`) et déplacer (`imap::move_message`), mais il n'expose ni
  `STORE \Deleted` + `EXPUNGE` ni `UID EXPUNGE` comme opération publique : supprimer depuis le client
  ne supprime rien côté serveur (et la ligne locale reviendra à la synchro suivante).
- **Pas de reprise réseau.** Aucun retry, aucun timeout applicatif sur `TcpStream::connect`, pas de
  reconnexion : une coupure remonte en `MailError::Imap`/`Io` et l'appelant doit réessayer.
- **Un seul dossier par appel de `sync_folder`.** `sync_account` se limite à `Inbox` + `Sent` ; les
  autres dossiers (Archive, Trash, Spam, dossiers personnels) ne sont synchronisés que si on les
  demande un par un. `move_message` en réconcilie un second (la destination).
- **Corps complet à chaque nouveau message.** Les nouveaux UID sont téléchargés en entier
  (`BODY.PEEK[]`, lots de 500) : simple et correct, mais coûteux sur une grosse boîte. Optimisation
  prévue : métadonnées d'abord, corps à la demande (`fetch_body` le permet déjà).
- **Pas de pool, pas de keychain, pas de PGP réel, pas de flux navigateur OAuth2, pas de recherche
  serveur.** Voir la vue d'ensemble.
- **`Store` incomplet pour l'IPC** : ni `list_accounts`, ni liste des dossiers d'un compte, ni
  suppression de compte.
- **`OutgoingMessage`/`OutgoingAttachment` ne sont pas `Deserialize`** : le DTO Tauri est à écrire
  (pièces jointes en base64, donc une étape de décodage).
- **`set_flags` n'écrit que `\Seen` et `\Flagged`** ; `answered` est purement indicatif.
- **Threading heuristique** : repli sur le sujet normalisé quand aucun identifiant n'existe (deux
  conversations au même sujet fusionnent), et `relink_replies` matche `references_json` par
  sous-chaîne.
- **Le schéma n'a aucune migration incrémentale** : `user_version = 1` et un script unique ; tout
  changement de schéma demandera une vraie étape de migration.
