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
| `LIST` + `STATUS` pour les dossiers, réconciliation par dossier : une passe métadonnées `UID FETCH 1:*`, en-têtes seuls pour les UID nouveaux, corps à l'ouverture d'un message (`fetch_body`) | Secrets dans le trousseau système / fichier chiffré (0600), plus en clair dans `accounts.json` ; base SQLite non chiffrée au repos |
| Envoi SMTP (lettre) avec pièces jointes, texte + HTML ; PGP réel (signature/chiffrement) | Pas de décompression bzip2 des payloads OpenPGP ; voir « PGP & rédaction » |
| Parsing MIME complet (encodage de transfert, RFC 2047, pièces jointes, aperçu) ; flux OAuth2 navigateur (PKCE) | Pas de `client_id` d'application embarqué (Google/Microsoft) : à enregistrer ou fournir au service |
| Threading déterministe par `References` / `In-Reply-To` / sujet normalisé ; IDLE sur INBOX + push SSE | Pas de CONDSTORE/QRESYNC : chaque synchro refait une passe métadonnées complète du dossier |
| Store SQLite (WAL, `user_version`), threads agrégés en Rust à la lecture ; recherche locale FTS5 (accents/casse repliés) sur tous les dossiers, filtres structurés et pagination, complétée par un `UID SEARCH` serveur quand l'index local ne remplit pas la page | Le repli serveur n'importe que des en-têtes : jamais de corps, jamais de déchiffrement PGP ; `has_attachment` y est une heuristique d'en-tête |

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
    OAuthRevoked(String),        // "oauth authorization expired: {0}"
    Tls(String),                 // "tls error: {0}"
}
```

`OAuthRevoked` n'est rendu que lorsque le point de jeton répond `invalid_grant` : le refresh token
est mort côté fournisseur, aucun réessai ne le ressuscite, seul un nouveau consentement rend le
compte utilisable. Tout autre refus (`invalid_client`, `invalid_request`, panne du proxy) reste
`OAuth` : le jeton stocké est intact, l'utilisateur n'a rien à refaire.

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
- `body_html` : premier `text/html`, les `src="cid:…"` remplacés par l'image de la part qui porte
  ce `Content-ID` (voir plus bas).
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

### Contrat d'assainissement HTML (`mime.rs`)

`sanitize_html(html) -> Option<String>` (corps stocké) et `sanitize_html_with_images(html)`
(relu à la demande du lecteur) partagent le **même** filtre, à une différence près : les images
**distantes**. `None` quand plus aucun texte visible n'est laissé et qu'aucun `<img>` ne survit.

**Tags** (32) : `p br div span a ul ol li b strong i em u s blockquote code pre h1 h2 h3 h4 table
thead tbody tr td th hr center font caption img`. Tout autre tag perd sa balise et garde son texte
— `script`, `iframe`, `object`, `embed`, `form`, `input`, `meta`, `link`, `base`, `svg`, `button`…
n'existent pas dans la sortie. Les éléments `<style>` sont retirés du markup eux aussi, mais leur
CSS est extrait **avant** ammonia et réinjecté assaini (voir plus bas).

**Images** : `img` est dans la liste dans les deux modes, c'est son `src` qui décide. Une image
`data:` d'un type de `INLINE_IMAGE_TYPES` (`image/png`, `image/jpeg`, `image/gif`, `image/webp`,
payload base64) est **toujours** conservée : c'est le contenu que l'expéditeur a collé (ou l'image
`cid:` rendue en `data:`, voir plus bas), pas un pixel qui appelle la maison. Une source `http(s)`
n'est conservée qu'avec `images` (opt-in du lecteur). Avant ammonia, `drop_refused_images` retire
les balises que le filtre refuserait de toute façon (pixel de tracking en lecture par défaut,
source qui n'est pas une image `data:` connue, `<img>` sans `src`) : le corps stocké ne garde donc
**aucune** trace d'un pixel de tracking, pas même une balise vide.

**Attributs conservés**, tous validés valeur par valeur (`attribute_filter`) :

| Élément | Attributs |
| --- | --- |
| tous | `title`, `class`, `style` (filtré, voir plus bas) |
| `a` | `href` — schémas `http`, `https`, `mailto` seulement ; `rel="noopener noreferrer"` et `target="_blank"` ajoutés |
| `table` | `width`, `align` (`left`/`center`/`right`), `cellpadding`, `cellspacing`, `border` |
| `td`, `th` | `colspan`, `rowspan`, `width`, `align` (`left`/`center`/`right`/`justify`), `valign` (`top`/`middle`/`bottom`/`baseline`), `bgcolor` |
| `tr` | `align`, `valign`, `bgcolor` |
| `font` | `color`, `face` (noms de police), `size` (échelle 1-7) |
| `img` | `src` (image `data:` de `INLINE_IMAGE_TYPES`, ou URL absolue `http(s)` avec `images` ; jamais `mailto:`/relative/`javascript:`), `alt`, `width`, `height` |

`width`/`height`/`cellpadding`/`cellspacing`/`border` : chiffres ou pourcentage de 4 chiffres au
plus, sinon l'attribut disparaît. `bgcolor`/`font color` : `#rgb`, `#rrggbb`, `rgb()`/`rgba()`
numériques, ou un nom de couleur CSS de la liste fermée `CSS_COLORS`.

Ces attributs dépréciés ne sont pas convertis en CSS : les navigateurs les honorent encore, et le
mail garde exactement la géométrie (largeurs, gouttières, fonds de cellule) que son auteur a écrite.

**`style` inline** : les déclarations sont découpées puis **re-sérialisées** depuis leurs tokens
(`cssparser`), propriété par propriété. Whitelist :

```
background background-color border* border-collapse border-spacing box-shadow clear color
direction display float font-family font-size font-style font-weight height letter-spacing
line-height list-style* margin* max-height max-width min-height min-width opacity overflow-wrap
padding* table-layout text-align text-decoration text-indent text-transform vertical-align
white-space width word-break word-spacing
```

(`*` = n'importe quel longhand : `padding-top`, `margin-left`, `border-bottom-left-radius`, …)
`display` n'accepte que `block inline inline-block flex table table-row table-cell list-item none`.

Une déclaration est **rejetée** (les autres survivent) si :

- la propriété n'est pas dans la whitelist — donc `position`, `z-index`, `overflow`, `inset`,
  `clip`, `cursor`, `behavior`, `-moz-binding`, `content`, `filter`, `animation`… sont refusées ;
- la valeur contient un `url(`, un `expression(`, `javascript:`, `vbscript:`, `behavior`,
  `-moz-binding` — la recherche porte sur les tokens **décodés**, donc `u\72 l(…)` (échappement
  CSS) et `url/**/(…)` (commentaire intercalé) tombent aussi ;
- la valeur contient un `@`, un `<`, un `>`, une accolade ou une chaîne/URL malformée
  (`BadString`, `BadUrl`), ou une déclaration mal fermée. Ce refus est ce qui empêche une
  évasion de la balise `<style>`.

Les commentaires CSS sont retirés **avant** l'analyse (hors chaînes), et `!important` est conservé.

**Blocs `<style>`** : extraits du HTML brut **avant** ammonia (l'extraction va jusqu'au premier
`</style`, donc le contenu ne peut pas refermer l'élément), assainis par le même filtre, puis
réinjectés en tête du corps nettoyé :

```html
<style>.promo{background-color:#8b7cf6;color:#fff}</style><table width="600" …>…
```

Le document du lecteur met sa feuille de repli dans le `<head>` (`src/components/mail-body.tsx`) :
les blocs du mail arrivent **après** dans l'ordre du document et gagnent donc à spécificité égale,
comme dans Gmail. Un bloc est assaini règle par règle : chaque règle qualifiée garde son sélecteur
(validé : identifiants, classes, attributs, pseudo-classes, combinateurs) et ses déclarations
filtrées ; `@media` est conservé avec ses règles internes (3 niveaux) ; `@import`, `@font-face`,
`@charset`, `@supports` et tout autre at-rule sont supprimés en bloc. Toute séquence `</` de la
sortie est neutralisée en `<\/`, et un mail réduit à un bloc `<style>` n'a pas de corps (aucun
texte visible).

**Toujours retirés** : scripts et `on*`, `srcset`, images de tracking (à l'ingestion), `iframe`,
`form`/`input`/`button`, `meta`/`link`/`base`, `svg`/`object`/`embed`, tout `url()` y compris dans
`background`, `position`/`z-index`/`overflow` (redressing), et les schémas d'URL autres que
`http`/`https` (et `mailto` pour les liens). Le schéma `data:` n'est ouvert que pour le `src` d'une
image : un `href="data:…"` est refusé dans les deux modes.

**Images `cid:`** : `inline_cid_images(html, message)` tourne **avant** le sanitizer, dans
`parse_message` comme dans `html_with_images` : chaque part qui porte un `Content-ID` et un type de
`INLINE_IMAGE_TYPES` (sous `MAX_INLINE_IMAGE_BYTES`, 10 Mio) devient un `data:{mime};base64,…` à la
place du `src="cid:…"` correspondant. L'image collée par l'expéditeur s'affiche donc sans clic, et
« Afficher les images » ne la casse pas. Un `cid:` sans part, un type hors liste ou une image trop
grosse laisse la balise telle quelle, et le sanitizer retire alors son `src`.

**Aperçu** : `html_to_text` ignore le contenu de `style` et `script`, donc le CSS réinjecté ne
pollue ni `body_text` ni `preview`. Une URL entre chevrons (`<https://…>`, `<mailto:…>`) n'est pas
une balise : `unwrap_autolinks` la remet nue **avant** ammonia (sinon le lecteur HTML la prend pour
une balise inconnue et la supprime avec son texte), donc `body_html`, `body_text` et `preview`
gardent l'URL. Les entités `&lt;` ne sont pas touchées.

Côté front, `htmlImagesOf(source, encrypted)` ne refuse que le couple *message chiffré + compte dont
l'interrupteur PGP est fermé* : un message en clair n'a besoin d'aucune clé, sa politique de compte
ne le concerne pas.

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

pub async fn import_headers(
    session: &mut ImapSession, store: &Store, account_id: &str,
    folder_path: &str, uidvalidity: u32, uids: &[u32],
) -> Result<usize, MailError>;

pub async fn select_and_search(
    session: &mut ImapSession, folder_path: &str, query: &str,
) -> Result<Vec<u32>, MailError>;
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
  6. La **métadonnée** des nouveaux UID est demandée **par lots de 500** (`IMPORT_BATCH`), **du plus
     récent au plus ancien** : `UID FETCH uid1,…,uidN (UID BODY.PEEK[HEADER])` (en-têtes seuls,
     **jamais le corps**), puis `mime::parse_headers` (sujet, expéditeur, destinataires, date,
     `Message-ID`, `In-Reply-To`/`References`, état PGP ; corps, aperçu, pièces jointes et détail PGP
     vides), `store.upsert_message` et `store.relink_replies` sur le `Message-ID`. Un UID que le
     serveur rend sans en-têtes est ignoré, pas fatal. L'upsert ne touche **que** l'enveloppe et les
     flags : un corps, un aperçu ou des pièces jointes déjà chargés survivent à la resynchronisation.
  7. Les **aperçus** des 50 plus récents (`SNIPPET_BATCH`) sont chargés à part, sur une **connexion
     dédiée** (`fetch_previews`) : `UID FETCH … (UID BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.1024>)`,
     `mime::parse_headers_with_snippet` → `store.set_preview`, sans jamais stocker de corps. Une
     réponse partielle illisible empoisonne la session qui la reçoit : la connexion dédiée garantit
     que la synchro principale n'en voit rien. Best-effort : PGP chiffré, base64, boundary MIME ou
     serveur muet → aperçu vide, jamais d'erreur de synchro.
  8. `store.upsert_folder` avec `uidvalidity`, `uidnext` et `last_sync_at = now()`.
  9. En fin de synchro de compte, **éviction** : les corps chargés depuis plus de 30 jours
     (`EVICT_BODY_DAYS`) repassent à NULL (`store.evict_bodies_before`), aperçu conservé, favoris et
     brouillons exclus ; les lignes touchées sont **réindexées sans leur corps** (un mot du corps
     évincé ne matche plus), et les rouvrir les relit du serveur (`fetch_body`).
  Coût réseau : `SELECT` + la passe métadonnées (linéaire en nombre de messages du dossier) +
  ⌈nouveaux / 500⌉ requêtes d'en-têtes ; un dossier inchangé ne coûte que la passe métadonnées, sans
  un octet de corps. `SyncReport` ne compte que les lignes réellement touchées.
- Le `role` stocké est conservé s'il n'est pas `Other`, sinon déduit de `FolderMapping`, sinon
  `Other`.
- `fetch_body` = `UID FETCH <uid> (BODY.PEEK[])` puis `store.set_body` : le corps, l'aperçu, les
  pièces jointes et l'état PGP sont réécrits ensemble (ni les drapeaux ni le reste ne bougent).
  C'est le seul chemin qui télécharge un corps ; la synchro ne le fait jamais.
- `set_flags` ne pousse que `\Seen` (inversé depuis `unread`) et `\Flagged` ; `\Answered` est lu
  mais **jamais écrit**. Deux `UID STORE` séparés : `+FLAGS` puis `-FLAGS`.
- `move_message` : `UID MOVE` si la capacité `MOVE` est annoncée, sinon `UID COPY` +
  `+FLAGS (\Deleted)` + `UID EXPUNGE` (le flux d'`EXPUNGE` est consommé jusqu'au bout). Ce repli
  exige `UIDPLUS` : sans lui, l'appel est refusé **avant** la copie (voir les limites). Côté base, la
  ligne source tombe **avant la commande** (`imap::drop_locally` : tombstone puis
  `store.delete_messages`), sinon la liste relue par le front pendant la connexion et le `MOVE` sert
  encore le message que l'utilisateur vient de supprimer. Une commande que le serveur refuse
  **restaure** la ligne (`store.forget_tombstones` puis réconciliation best-effort de la source,
  l'erreur d'origine remontant telle quelle ; une session morte laisse la restauration à la synchro
  suivante). Le dossier destination est ensuite **réconcilié** (`reconcile(…, None)`) : la ligne
  locale de la destination est réinsérée avec l'UID réellement attribué par le serveur (GreenMail
  réattribue l'UID au `MOVE`, vérifié en réseau), corps compris. Aucun UID n'est supposé conservé,
  aucune ligne n'est déplacée à la main.
- `delete_message` : `UIDPLUS` est vérifié **avant** de poser `\Deleted` ; sans lui, `MailError::Imap`
  (502 côté API) et rien n'est modifié, ni côté serveur ni en base. Avec lui : la ligne locale tombe
  **avant la marque** (`drop_locally`), puis `STORE +FLAGS (\Deleted)` et `UID EXPUNGE <uid>` ; un
  expunge refusé restaure la ligne au lieu de la perdre.
- `empty_folder` : `UID STORE 1:*` + expunge du dossier, et `removed` est le nombre de réponses
  `EXPUNGE` réellement reçues du serveur — la seule mesure de ce que le dossier a perdu. Le
  nettoyage local est `store.clear_folder` (lignes et pièces jointes du dossier, ligne du dossier
  gardée) : un dossier jamais synchronisé est vidé côté serveur sans qu'aucun UID local ne soit
  connu. Serveur d'abord, store ensuite : un échec IMAP laisse la base intacte.
- `create_folder` : un dossier déjà existant n'est pas une erreur (détection par le mot `exist` dans
  le message d'erreur).
- `import_headers` : `UID FETCH uid1,…,uidN (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])` — les flags viennent du
  même fetch, pas d'une passe métadonnées — puis le même contrat que l'import de synchro
  (`parse_headers`, `upsert_message`, `relink_replies`) : en-têtes seuls, **jamais de corps**. Sert
  au repli serveur de la recherche ; `&[]` → `0`, aucune requête.
- `select_and_search` : `SELECT` puis `UID SEARCH CHARSET UTF-8 TEXT "…"`, UID du plus récent au plus
  ancien. La requête est échappée pour la chaîne entre guillemets (`\` → `\\`, `"` → `\"`, CR/LF →
  espace) ; l'UTF-8 passe tel quel. async-imap **avale le `BAD`/`NO` étiqueté** et rend un ensemble
  vide : une réponse vide à une requête ASCII est donc rejouée sans `CHARSET UTF-8` avant d'être
  tenue pour « aucun résultat ».

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
- **Images collées** : chaque `<img src="data:image/…">` du corps sort de `sanitize_outgoing_html`
  intact puis devient une part `multipart/related` (`Content-ID`, `Content-Disposition: inline`), le
  `src` du HTML passant en `cid:<Content-ID>`. Types de `INLINE_IMAGE_TYPES`, plafond
  `MAX_INLINE_IMAGE_BYTES` (10 Mio) au-delà duquel l'image est retirée du corps. À la relecture,
  `inline_cid_images` la rend en `data:` : l'image collée revient telle quelle (voir le contrat
  d'assainissement HTML).
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
    pub fn pgp_enabled(&self, account_id: &str) -> Result<bool, MailError>;
    pub fn set_pgp_enabled(&self, account_id: &str, enabled: bool) -> Result<(), MailError>;
    pub fn close_encrypted_bodies(&self, account_id: &str) -> Result<usize, MailError>;
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
        &self, account_id: &str, folder_path: &str, uid: u32, parsed: &ParsedMessage,
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
- `migrate` est idempotent, piloté par `PRAGMA user_version` (`SCHEMA_VERSION = 7`). Il faut
  l'appeler une fois à l'ouverture : il applique `schema.sql` (`CREATE TABLE IF NOT EXISTS`) puis
  `add_missing_columns`, qui ajoute à une base existante les colonnes apparues depuis
  (`messages.pgp_detail`, `messages.has_attachment`, `folders.modseq`, `folders.delimiter`,
  `accounts.pgp`) après un `PRAGMA table_info`, sans toucher aux données. Une base antérieure à la
  v7 reçoit en plus le remplissage de l'index de recherche (`backfill_search_index`, par lots de
  5000 `rowid`, pour ne pas bloquer le démarrage du démon ni le widget Android) et de
  `has_attachment` depuis la table `attachments` (`backfill_attachment_flags`).
- **Interrupteur PGP par compte** : `accounts.pgp` (`INTEGER NOT NULL DEFAULT 1`). `pgp_enabled`
  rend `true` pour un compte que la base ne connaît pas (défaut ouvert, jamais de fermeture
  silencieuse) ; `set_pgp_enabled` remonte `InvalidData("account not found")` si la ligne n'existe
  pas. `upsert_account` ne touche pas à la colonne : une synchro ne rallume pas un compte fermé.
  `close_encrypted_bodies` efface `body_text`, `body_html`, `preview` et `pgp_detail` des messages
  `pgp = 'encrypted'` du compte et rend le nombre de messages fermés ; l'état PGP du message reste
  `encrypted`, et `fetch_body` reconstruit le corps une fois l'interrupteur rouvert.
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
    email TEXT,
    pgp INTEGER NOT NULL DEFAULT 1   -- interrupteur PGP du compte (1 = activé)
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
  passage réussi. `migrate` ne touche pas aux données, `user_version = 7` sert de garde.
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
- La recherche : `searchMails` (`src/lib/store.tsx`) appelle déjà
  `/api/accounts/{id}/search` pour chaque compte (`mailApi.search(id, query)`, `src/lib/api.ts`).
  Les filtres structurés du démon (`folder`, `from`, `to`, `subject`, `unread`, `starred`,
  `has_attachment`, `before`, `after`) et la pagination (`offset`) ne sont pas encore exposés côté
  TS : `api.ts` n'envoie que `q` et `limit`.

## Contrat HTTP du démon local (implémenté)

Le crate `crates/mail-api` (binaire `lavande-maild`, lib `lavande_mail_api`) expose le moteur en JSON
sur la boucle locale. Le front l'appelle via `/api` (proxy Vite en développement, nginx du portail
sinon), la coquille Tauri embarque le même routeur dans son processus (voir plus bas).

Configuration, par variables d'environnement uniquement :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LAVANDE_MAIL_BIND` | `127.0.0.1:8790` | adresse d'écoute (loopback + jeton Bearer, voir plus bas) |
| `LAVANDE_MAIL_DATA_DIR` | `$XDG_DATA_HOME/lavande` | `mail.db` (SQLite), `accounts.json`, `daemon-token`, `secrets.key`/`secrets.enc` (tous 0600) |
| `LAVANDE_MAIL_EXTRA_ROOTS` | — | PEM ajouté aux racines TLS (serveur de test auto-signé) |
| `LAVANDE_MAIL_SECRETS` | `auto` | stockage des secrets : `keychain` (trousseau système, échoue s'il est injoignable), `file` (fichier chiffré), `auto` (trousseau sinon fichier) |

Erreurs : `{ "error": "message lisible", "kind": "config|auth|imap|smtp|tls|oauth|store|mime" }`.
`MailError::Config` → 400, `Auth` → 401, `InvalidData` → 404, réseau/TLS/IMAP/SMTP/OAuth → 502,
`Store`/`Mime` → 500.

### Authentification du démon

Le démon n'est plus ouvert à quiconque atteint le port : chaque requête porte un jeton Bearer
(`Authorization: Bearer …`), comparé à temps constant. Le jeton (32 octets aléatoires, base64url)
est créé au premier lancement dans `daemon-token` (0600) du répertoire de données, puis réutilisé ;
il n'est jamais journalisé. Réponse sans jeton valide : 401 `kind: auth`.

Trois exceptions, assumées :

- `GET /api/health` : sonde des scripts, ne révèle que version et `public_url` ;
- `GET /api/oauth/callback` : retour du navigateur du système, qui ne peut pas porter le jeton ;
  la route est protégée par le `state` PKCE aléatoire à usage unique ;
- `GET /api/events` : `EventSource` ne sait pas porter d'en-tête, le jeton est accepté en
  `?token=…` (boucle locale uniquement).

Où chaque client prend le jeton :

| Client | Injection |
| --- | --- |
| Coquille Tauri (desktop/mobile) | commande `mail_daemon_token` (lit/crée le même fichier), le front porte le jeton ; SSE en `?token=` |
| Web dev (`npm run dev`) | proxy Vite : lit `daemon-token` au démarrage et l'injecte, le navigateur ne le voit jamais |
| Portail nginx (`/lavande/api/`) | `dev-proxy.sh` génère `deploy/nginx/lavande-token.inc` (gitignoré, **0600**) que `portal.conf` inclut ; l'emplacement n'accepte que les requêtes émises par le SPA du portail (voir `deploy/README.md`) |

Si le démon démarre après Vite ou nginx, relancez le proxy pour qu'il lise le jeton. Un processus
du même utilisateur peut lire le fichier : le jeton protège contre les autres utilisateurs et toute
exposition réseau, pas contre un processus déjà compromis sur le compte.

### Stockage des secrets

Mots de passe IMAP/SMTP et jetons OAuth2 (`client_secret`, `refresh_token`) ne sont plus écrits dans
`accounts.json`. Le fichier ne porte que la configuration ; les secrets vivent dans un stockage
séparé, choisi au démarrage (`LAVANDE_MAIL_SECRETS`) :

- **Trousseau système** (desktop Linux, Secret Service via D-Bus, crate `keyring` en pur Rust) :
  une entrée `lavande-mail` par compte. C'est le backend par défaut quand le trousseau répond.
- **Fichier chiffré** (Android, headless, trousseau injoignable) : `secrets.enc`, JSON des secrets
  chiffré XChaCha20-Poly1305 avec une clé aléatoire `secrets.key` (0600). Sur Android, l'ensemble
  reste dans le stockage privé de l'application ; un Keystore matériel reste à faire.

Le choix est journalisé au démarrage ; `keychain` forcé échoue si le trousseau est injoignable
(pas de repli silencieux). Un `accounts.json` ancien format (secrets inline) est migré à
l'ouverture : les secrets partent dans le stockage choisi et le fichier est réécrit sans eux.
Supprimer un compte supprime son secret. Un fichier de secrets corrompu est une erreur explicite,
jamais un reset silencieux.


| Méthode | Chemin | Corps | Réponse |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ "status": "ok", "version": "0.1.0", "public_url": "http://127.0.0.1:8790" }` |
| GET | `/api/accounts` | — | `[AccountSummary]` (jamais de secret) |
| POST | `/api/accounts` | `AccountConfig` | 201 `AccountSummary`, 400 config, 409 id pris, 401/502 connexion refusée |
| DELETE | `/api/accounts/{id}` | — | 204 (purge base + `accounts.json`), 404 |
| PATCH | `/api/accounts/{id}/sync-folders` | `{ "folders": ["INBOX"] \| null }` | 200 `AccountSummary` (`null` = tous les dossiers à rôle connu, `[]` = aucun), 400 dossier inconnu, 404 |
| PATCH | `/api/accounts/{id}/pgp` | `{ "enabled": bool }` | 200 `AccountSummary` (`pgp`), 404 compte inconnu |
| GET | `/api/discover?email=…` | — | 200 `Discovery` (`found: false` si rien publié), 400 adresse invalide |
| GET | `/api/accounts/{id}/folders` | — | `[Folder]` |
| POST | `/api/accounts/{id}/sync` | `{ "folder_path"? }` | `{ "reports": [{ folder_path, inserted, flags_updated, removed, uidvalidity_changed, uidnext }] }` |
| GET | `/api/accounts/{id}/folders/{path}/threads?limit=50&offset=0` | — | `[Thread]` (limit plafonné à 200) |
| GET | `/api/accounts/{id}/search?q=…&limit=50&offset=0&folder=…&from=…&to=…&subject=…&unread=…&starred=…&has_attachment=…&before=…&after=…` | — | `[Message]` : recherche locale FTS5 + filtres + page, complétée par le serveur si elle ne remplit pas la page (limit plafonné à 200) |
| GET | `/api/accounts/{id}/folders/{path}/messages/{uid}?fetch_body=true` | — | `Message` (corps rapatrié à la demande) |
| POST | `/api/accounts/{id}/flags` | `{ folder_path, uid, unread, starred }` | 204 (serveur d'abord, store ensuite) |
| POST | `/api/accounts/{id}/move` | `{ from_path, uid, to_path }` | 204 (UID local réaligné sur celui du serveur) |
| POST | `/api/accounts/{id}/delete` | `{ folder_path, uid }` | 204 (serveur d'abord, store ensuite) ; 502 si le serveur n'annonce pas `UIDPLUS` (rien n'est modifié) |
| POST | `/api/accounts/{id}/purge` | `{ folder_path }` | 200 `{ removed }`, `removed` = nombre de messages **expurgés côté serveur** (dossier vidé des deux côtés) |
| POST | `/api/accounts/{id}/send` | `SendRequest` | 204 |
| POST | `/api/oauth/start` | `OAuthStartRequest` | 201 `{ session, auth_url, redirect_uri }` |
| GET | `/api/oauth/callback?code=…&state=…` | — | page HTML autonome (jamais de jeton) ; enregistre seulement le code, **aucun appel réseau** |
| POST | `/api/oauth/complete` | `{ session }` | `{ status: pending\|code_received\|done\|failed, account_id?, error? }` : échange le code (au retour au premier plan) |
| GET | `/api/oauth/status?session=…` | — | `{ status: pending\|code_received\|done\|failed, account_id?, error? }` |
| GET | `/api/events` | — | flux SSE `event: mail` (`folder-updated`, rapport de synchro) |

`POST /api/accounts` **teste la connexion IMAP et liste les dossiers avant d'écrire quoi que ce soit** :
rien n'est persisté si le serveur refuse. Les corps et réponses sont les types de
`crates/mail-core/src/model.rs` sérialisés tels quels (`folder_path`, `uid`, `flags.unread`, etc.) ;
`{path}` doit être percent-encodé.

### Recherche (`GET /api/accounts/{id}/search`)

Tous les paramètres sont optionnels ; la réponse est toujours un `[Message]`, trié
`date DESC, uid DESC`.

| Paramètre | Sémantique |
| --- | --- |
| `q` | texte libre, **littéral** (aucune grammaire d'opérateurs côté serveur : le front la parsera lui-même) |
| `limit` | défaut 50, borné à `1..=200` |
| `offset` | défaut 0 |
| `folder` | chemin exact de dossier |
| `from`, `to`, `subject` | restreint le champ correspondant (`to` couvre `to` **et** `cc`) |
| `unread`, `starred`, `has_attachment` | booléens (`true`/`false`/`1`/`0`, vide = pas de filtre) ; `unread=true` ne garde que les non-lus, `false` que les lus (idem `starred`) |
| `before`, `after` | `AAAA-MM-JJ`, sur la date d'en-tête UTC : `after` garde `date >= jour 00:00:00Z`, `before` garde `date < jour 00:00:00Z` |

Une valeur invalide (`before=2026-13-01`, `unread=oui`) est un **400** `kind: "search"`, jamais un
filtre silencieusement ignoré. `q` vide avec des filtres = listing filtré ; aucun paramètre = page
des messages les plus récents du compte.

1. **Index FTS5 local d'abord**. `store.search` interroge `messages_fts` (table FTS5
   *contentless* : `content=''`, `contentless_delete=1`,
   `tokenize="unicode61 remove_diacritics 2"`), dont le `rowid` est celui de `messages`. Colonnes
   indexées : `subject`, `sender` (« nom email » de `from_json`), `recipients` (`to_json` +
   `cc_json` aplatis) et `body` (= `body_text`, **jamais** `body_html`). Casse et accents sont donc
   repliés des deux côtés (`zèbre` ↔ `ZEBRE`).
2. **Requête construite, jamais concaténée brute** : chaque mot de l'utilisateur (suite de
   caractères alphanumériques) devient une phrase FTS5 citée et préfixée (`"fact"*`), les mots sont
   joints par `AND`. Aucun caractère saisi n'atteint la grammaire FTS5 : `%`, `"`, `(`, `NEAR(` ou
   `AND` ne peuvent pas produire d'erreur SQL (donc jamais de 500). `from`, `to` et `subject`
   passent par les filtres de colonne de FTS5 (`subject : ("mars"*)`), `folder`, les booléens et les
   dates par du SQL sur `messages`, le tout dans la même requête. Un `q` non vide **sans aucun mot**
   (ponctuation seule, `%`, `"`) rend une liste vide, sans repli.
3. **Pagination en SQL** (`LIMIT ? OFFSET ?`), après le tri.
4. **Repli serveur** seulement si `offset == 0`, que la page locale n'est pas pleine, que `q` fait
   au moins 3 caractères (comptés en `chars`) **et** qu'aucun `has_attachment` n'est demandé (aucun
   équivalent IMAP fiable : le repli est simplement désactivé pour ce filtre).
5. Une **seule** session (`imap::connect_with`), puis pour chaque dossier **connu en base**
   (`store.list_folders`, donc le périmètre déjà synchronisé, restreint à `folder` s'il est donné) :
   `SELECT` puis `UID SEARCH CHARSET UTF-8 …` (`imap::select_and_search`). Aucun `LIST` : un dossier
   jamais vu par la synchro n'est pas cherché.
6. **Grammaire IMAP** (`imap::SearchCriteria`) : `q` → `TEXT`, `from` → `FROM`, `to` → `TO`,
   `subject` → `SUBJECT`, `unread` → `UNSEEN` (ou `SEEN` si `false`), `starred` → `FLAGGED` (ou
   `UNFLAGGED`), `before` → `BEFORE 04-Mar-2026`, `after` → `SINCE 04-Mar-2026` ; rien → `ALL`.
7. **Échappement** de chaque valeur pour la chaîne entre guillemets IMAP : `\` → `\\`,
   `"` → `\"`, CR/LF → espace ; l'UTF-8 passe tel quel.
8. **Repli CHARSET** : async-imap avale le `BAD`/`NO` étiqueté et rend un ensemble **vide**, pas une
   erreur. Une réponse vide à une requête ASCII est donc rejouée sans `CHARSET UTF-8` avant d'être
   tenue pour « aucun résultat » ; une requête non ASCII n'a pas ce repli.
9. **Bornes** : au plus `2 × limit` UID serveur traités au total, dossiers parcourus dans l'ordre de
   `list_folders` (par chemin) ; le budget s'épuise, la boucle s'arrête. Un
   `tokio::time::timeout(10 s)` global entoure tout le repli : passé ce délai, les résultats locaux
   sont rendus tels quels.
10. **Import des inconnus seulement** : pour chaque UID trouvé, `store.flags_in_folder` dit s'il est
    déjà en base. Les absents passent par `imap::import_headers`
    (`UID FETCH … (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])` → `parse_headers` →
    `upsert_message_with_attachment` + `relink_replies`) : **en-têtes seuls, jamais de corps**, même
    contrat que la synchro. Puis `fetch_previews` (best-effort) sur ces UID, pour que les résultats
    aient un aperçu.
11. **Fusion** : chaque UID trouvé est relu en base (`store.get_message`) et fusionné avec les
    résultats locaux — dédoublonnage par `message_id` (repli `(folder_path, uid)` quand le message
    n'en a pas), la ligne locale gagne (elle porte son corps et ses pièces jointes), tri
    `date DESC, uid DESC`, troncature à `limit`.
12. **Best-effort de bout en bout** : compte illisible, connexion impossible, `SELECT`/`SEARCH`
    refusé, dossier en erreur, délai dépassé → `tracing::warn` et les résultats locaux sont rendus
    tels quels ; jamais d'erreur HTTP pour ça. Un dossier en échec laisse la session désalignée : le
    suivant repart d'une connexion neuve (même pattern que `sync_account`).
13. **Aucun corps, aucun déchiffrement** : ce chemin ne télécharge que des en-têtes, donc le gate PGP
    reste intact et les résultats du repli arrivent avec `body_text: null` — le corps se relit à
    l'ouverture (`?fetch_body=true`). Un mot qui ne vit que dans un corps chiffré reste introuvable.

**Limites assumées de l'index**

- **Corps évincés** : `evict_bodies_before` (corps > 30 jours, non étoilés, hors brouillons) remet
  `body_text`/`body_html` à `NULL` **et réindexe la ligne sans son corps** — un mot qui ne vivait
  que dans ce corps cesse de matcher, le sujet et les correspondants restent trouvables. Rouvrir le
  message réindexe son corps.
- **Pièces jointes des messages jamais ouverts** : la synchro ne lit que les en-têtes et ne fait
  aucun `BODYSTRUCTURE`. `has_attachment` est donc dérivé à l'import de l'en-tête `Content-Type`
  (`multipart/mixed` ⇒ 1) — heuristique : une pièce jointe portée par un `multipart/alternative`
  pur, ou un message jamais ouvert sans `multipart/mixed` visible, peut être manqué. `set_body`
  réécrit la colonne depuis la liste réelle des pièces jointes dès que le message est ouvert.
- **Pas de sous-chaîne** : FTS5 est un index de mots, pas un `LIKE '%…%'`. La recherche porte sur
  des mots entiers ou des **préfixes** (`fact` trouve `facture`), pas sur un fragment interne
  (`acture` ne trouve rien). `preview` n'est pas indexé (il est dérivé du corps).
- **Le repli serveur reste un enrichissement** : il ne couvre que les dossiers déjà connus en base,
  il est borné (`2 × limit` UID, 10 s) et il ne voit pas dans un corps chiffré : `UID SEARCH TEXT`
  cherche dans le texte que le serveur stocke, donc le ciphertext PGP.

### Découverte des serveurs (`GET /api/discover`)

Chaîne exécutée côté service (le navigateur ne peut ni interroger l'ISPDB ni faire du DNS) :

1. **ISPDB Thunderbird** `https://autoconfig.thunderbird.net/v1.1/<domaine>` — base centrale ;
2. **autoconfig du domaine** `https://autoconfig.<domaine>/mail/config-v1.1.xml?emailaddress=…`,
   puis `https://<domaine>/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=…`, puis HTTP
   en clair sur `autoconfig.<domaine>` ;
3. **sondage** : `imap.`/`mail.`/`<domaine>` sur 993 (TLS), `smtp.`/`mail.`/`<domaine>` sur 465 puis
   587, retenus seulement si le handshake TLS et la bannière (`* OK` / `220`) répondent.

Les quatre documents sont interrogés **en parallèle** puis choisis par priorité ; sinon un domaine
dont `autoconfig.<domaine>` ne résout pas consommait le délai et retombait sur le sondage. Parsing de
`clientConfig v1.1` : `socketType` (`SSL` → `tls`, `STARTTLS` → `start_tls`), `authentication`
(`password-cleartext` → `password`, `OAuth2` → `oauth2`), substitution de `%EMAILADDRESS%`,
`%EMAILLOCALPART%`, `%EMAILDOMAIN%`. Cache mémoire par domaine (1 h, échec 5 min), délai 3 s par
tentative.

```json
{
  "found": true, "source": "ispdb",
  "url": "https://autoconfig.thunderbird.net/v1.1/gmail.com",
  "provider": "Google Mail", "display_name": "Google Mail",
  "incoming": { "host": "imap.gmail.com", "port": 993, "encryption": "tls", "username": "roman@gmail.com" },
  "outgoing": { "host": "smtp.gmail.com", "port": 465, "encryption": "tls", "username": "roman@gmail.com" },
  "auth": ["password", "oauth2"]
}
```

`source` ∈ `ispdb` \| `autoconfig` \| `well_known` \| `guess`. Un domaine inconnu renvoie
`{ "found": false, "source": null, "reason": "aucune configuration publiée pour « … »" }` — ce n'est
pas une erreur.

### OAuth2 (`/api/oauth`)

Parcours « application installée » : PKCE (S256), `state` aléatoire, retour sur le **même port** que
le démon (`http://127.0.0.1:8790/api/oauth/callback`, surchargeable par `LAVANDE_MAIL_PUBLIC_URL`).

1. `POST /api/oauth/start` avec `provider` (`google`, `microsoft` ou `custom`), `email`, `label`, les
   endpoints `imap`/`smtp` (typiquement ceux renvoyés par `/api/discover`), `client_id` et
   `client_secret` (facultatifs si `LAVANDE_MAIL_<PROVIDER>_CLIENT_ID` / `*_CLIENT_SECRET` sont définis).
   Réponse : `{ session, auth_url, redirect_uri }`.
2. Le client ouvre `auth_url` dans le navigateur ; l'utilisateur consent. Ouverture côté front :
   `window.open` dans une page web (l'onglet est pré-ouvert **avant** la requête, sinon le bloqueur de
   pop-ups le refuse), et le plugin Tauri `opener` dans la coquille packagée, où `window.open` ne fait
   rien. Un lien de secours (« Ouvrir la page de consentement ») reste affiché dans la carte pendant
   l'attente du consentement.
3. Le fournisseur redirige le navigateur vers `redirect_uri` ; le démon **n'enregistre que le code**
   (`status: code_received`) et ne fait aucun appel réseau : le navigateur occupe le premier plan et
   Android refuse alors les sockets de l'application en arrière-plan (`EPERM`).
4. Au retour de l'application au premier plan, le front appelle `POST /api/oauth/complete` : le démon
   échange le code (`grant_type=authorization_code` + `code_verifier`), obtient le `refresh_token`,
   **teste la connexion IMAP** (XOAUTH2 + `LIST`) puis enregistre le compte comme `POST /api/accounts`.
   L'échange est idempotent (passage atomique `code_received` → en cours). Un **refus réseau** de
   l'échange (`EPERM`, connexion impossible) est réessayé, pas un refus du fournisseur : Android refuse
   les sockets d'un UID en arrière-plan ou juste après le retour au premier plan, la levée de la
   restriction suivant `ActivityManager` avec des dizaines à des centaines de millisecondes de retard.
   Le démon remet alors l'issue à `code_received` (plafond de 20 tentatives, ≈ 30 s), et c'est
   l'interrogation suivante du front qui relance l'échange ; un refus définitif (`invalid_grant`, aucun
   `refresh_token`, autorisation refusée) rend la session `failed` sans aucune tentative supplémentaire.
5. `GET /api/oauth/status?session=…` permet au front de suivre l'issue sans voir de jeton ; c'est lui
   qui déclenche l'étape 4 quand il lit `code_received`, y compris pour chaque réessai.

Sessions en mémoire, TTL 10 minutes, `state` à usage unique.

L'identifiant d'application Microsoft est **livré dans le build** (`.env.production`,
`VITE_OAUTH_CLIENT_ID`) : inscription « Lavande », comptes « Any Entra ID Tenant + Personal Microsoft
accounts », plateforme *Public client/native*, redirection
`http://127.0.0.1:8790/api/oauth/callback`, *public client flows* autorisés, permissions déléguées
`IMAP.AccessAsUser.All` + `SMTP.Send`. Un client public PKCE n'a pas de secret : l'identifiant est
visible sur l'écran de consentement, seul le `refresh_token` reste dans le démon.

Google est livré aussi, client « Application de bureau » (installed) : `VITE_GOOGLE_CLIENT_ID` et le
secret du client `VITE_GOOGLE_CLIENT_SECRET`, que Google **exige** à l'échange de jetons (sans lui, il
répond `client_secret is missing`). Ce secret n'est pas confidentiel : le modèle « application
installée » de Google veut qu'il soit visible dans le binaire, comme le `client_id`.

Pour livrer d'autres identifiants (une inscription à vous), reconstruisez avec
`VITE_OAUTH_CLIENT_ID=…`, `VITE_GOOGLE_CLIENT_ID=…` et `VITE_GOOGLE_CLIENT_SECRET=…` ; sans
identifiant livré, l'écran de connexion réaffiche les champs (identifiant et, si requis, secret) et le
guide d'inscription.

Le `redirect_uri` est `public_url` du démon : le port livré (`8790`) est celui de l'inscription. Changer
`LAVANDE_MAIL_BIND` ou `LAVANDE_MAIL_PUBLIC_URL` impose d'enregistrer la même adresse chez le
fournisseur, sinon il répond `AADSTS50011`.

### Événements (`/api/events`)

La veille **IMAP IDLE** tourne dans le démon (une par compte, sur INBOX) : à chaque notification du
serveur elle lance une réconciliation du dossier, et ne publie un événement SSE que si cette
réconciliation a réellement changé quelque chose (`inserted`, `removed` ou `flags_updated` non nuls,
`UIDVALIDITY` changée). Un événement sans changement ferait relire au front la liste entière — donc
réapparaître un message dont la suppression est encore en vol, la veille se réveillant aussi sur le
`\Deleted`/`EXPUNGE` de cette suppression.

```text
event: mail
data: {"type":"folder-updated","account_id":"perso","folder_path":"INBOX",
       "report":{"folder_path":"INBOX","inserted":1,"flags_updated":0,"removed":0,
                 "uidvalidity_changed":false,"uidnext":1208}}
```

Le front s'y abonne (`EventSource`) et rafraîchit la liste sans clic ; le flux se reconnecte seul et
un `keep-alive` de 20 s maintient la connexion. La veille se reconnecte 30 s après une coupure.
Sur le web, le proxy injecte le jeton ; dans la coquille, l'URL porte `?token=…` (voir
« Authentification du démon »).

### Interrupteur PGP par compte (`PATCH /api/accounts/{id}/pgp`)

Le réglage vit dans la base (`accounts.pgp`, défaut `1`) et non dans `accounts.json` : c'est une
politique de stockage, lue à chaque déchiffrement. `PATCH /api/accounts/{id}/pgp` avec
`{ "enabled": false }` ferme le compte, `{ "enabled": true }` le rouvre ; la réponse est un
`AccountSummary` dont le champ `pgp` porte l'état (comme `synced_folders` pour la sélection de
dossiers). Un compte inconnu d'`accounts.json` répond 404 ; un compte connu mais jamais synchronisé
voit sa ligne d'identité écrite au passage, pour que l'interrupteur soit stockable.

Côté démon, **tous les chemins qui déchiffrent** passent par `AppState::keyring_for(account_id)` :
trousseau complet quand l'interrupteur est ouvert, `PgpKeyring::new()` **vide** sinon. Avec un
trousseau vide, `pgp::mime::open` ne trouve aucune clé secrète (« Clé secrète manquante ») et
`mime::parse_message_with_keys` laisse le message fermé : `body_text`/`body_html` nuls, pièces
jointes vidées, aperçu vide, `pgp` toujours `encrypted`. Sites gatés :

| Chemin | Ce qu'il faisait |
| --- | --- |
| `POST /api/accounts/{id}/sync` (dossier et compte) | la synchro ne lit que les en-têtes : plus de déchiffrement à l'ingestion |
| `GET /api/accounts/{id}/folders/{path}/messages/{uid}?fetch_body=true` | `imap::fetch_body` réécrivait le corps déchiffré |
| `GET …/messages/{uid}/attachments/{index}` | `imap::fetch_attachment` ouvrait le message pour la pièce jointe |
| `GET …/messages/{uid}/html-images` | `imap::fetch_html_with_images` ouvrait le message (sans clé : 404, pas de HTML) |
| `POST /api/accounts/{id}/move` | la réconciliation de la destination réimporte les en-têtes du message déplacé |
| `POST /api/accounts/{id}/send` (copie « Envoyés »), `POST …/drafts` | `imap::append_sent`/`append_draft` réconcilient « Envoyés »/« Brouillons » (en-têtes seuls) |
| veille IDLE (`events::sync_and_publish`) | même réconciliation que la synchro |

Fermer l'interrupteur **efface aussi ce qui était déjà déchiffré** : la route appelle
`Store::close_encrypted_bodies`, qui vide corps, aperçu et détail PGP des messages `encrypted` du
compte. Rouvrir ne restaure pas ces corps : `fetch_body` les relit sur le serveur, message par
message, comme avant la première lecture.

L'**envoi** (`submit`, signer/chiffrer) garde le trousseau complet : la composition est déjà gatée
côté front par les drapeaux du brouillon (`resolvePgp`), et un message signé ou chiffré doit l'être
pour de vrai, quel que soit l'état de la réception.

### Exemples de payloads

`POST /api/accounts` :

```json
{
  "id": "perso", "label": "Perso", "email": "roman@mail.lanro.eu", "username": "roman@mail.lanro.eu",
  "imap": { "host": "mail.lanro.eu", "port": 993, "encryption": "tls" },
  "smtp": { "host": "mail.lanro.eu", "port": 587, "encryption": "start_tls" },
  "auth": { "kind": "password", "password": "…" }
}
```

Variante OAuth2 (`auth`) : `{ "kind": "oauth2", "client_id": "…", "client_secret": "…",
"refresh_token": "…", "token_endpoint": "https://oauth2.googleapis.com/token" }` — acceptée par
l'API, mais l'écran de connexion ne propose encore que le mot de passe.

`POST /api/accounts/{id}/send` (pièces jointes en base64) :

```json
{
  "to": [{ "name": "Camille", "email": "camille@studio-lilas.fr" }],
  "cc": [], "bcc": [],
  "subject": "Re: Maquettes", "text": "Bonjour…",
  "in_reply_to": "c@studio-lilas.fr", "references": ["a@studio-lilas.fr", "c@studio-lilas.fr"],
  "attachments": [{ "filename": "plan.pdf", "mime": "application/pdf", "data_base64": "JVBERi0…" }]
}
```

Les identifiants de message (`message_id`, `in_reply_to`, `references`) sont stockés **sans chevrons**.

### Front et coquille Tauri

- `src/lib/api.ts` : client typé, `ApiError { kind, status }`, délais 15 s (appels courts) et 180 s
  (synchro, corps, envoi). Base = `${BASE_URL}api`, ou `http://127.0.0.1:8790/api` quand
  `window.isTauri` est présent (démon embarqué). Dans la coquille, le jeton Bearer vient de la
  commande `mail_daemon_token` ; sur le web, le proxy l'injecte.
- `src/lib/mail-backend.ts` : traduction `Message`/`Thread` → `Mail`/`Thread` du store, rôles de
  dossiers → `FolderId`, formatage des dates. `setAccountDecryptPolicy` y tient un instantané
  module des comptes ouverts, poussé par `MailStoreProvider` ; `htmlImagesOf` refuse un compte fermé
  (défense en profondeur, le démon est déjà gaté) avec le message
  « PGP désactivé pour ce compte · message chiffré laissé fermé ».
- `src/lib/store.tsx` : `resolvePgp(prefs, compte).enabled` est poussé au démon
  (`mailApi.setAccountPgp`) et à cet instantané au chargement des comptes et à chaque changement de
  `pgpAccounts`/`pgpEncrypt`/`pgpSign`. Une valeur déjà transmise n'est pas renvoyée (pas de boucle) ;
  un échec est notifié et retenté au rendu suivant.
- `VITE_MAIL_BACKEND=demo` garde les fixtures (calendrier, planning, MCP) ; `api` (défaut) branche la
  vraie boîte. Si le démon est absent, un bandeau propose de le démarrer ou de passer en démo.
- Coquille Tauri (`src-tauri/src/lib.rs`) : `lavande_mail_api::serve()` démarre le routeur sur
  `127.0.0.1:8790` avec `app_data_dir()` au lancement, dans le processus de l'app (pas de sidecar).
  Le routeur n'accepte en CORS que les origines de la coquille (`tauri://localhost`,
  `http://tauri.localhost`, `https://tauri.localhost`), le dev server (`http://localhost:1420`,
  `http://127.0.0.1:1420`) ; méthodes `GET/POST/PUT/PATCH/DELETE/OPTIONS`, en-têtes
  `authorization` et `content-type`. Toute autre origine ne reçoit aucun en-tête CORS. L'APK
  autorise le trafic local en clair.

## Modes de fonctionnement

| Mode | Mise en place | Données |
| --- | --- | --- |
| `api` (défaut) | démon local (`scripts/mail-service.sh`) ou coquille Tauri | vraie boîte, SQLite locale |
| `demo` | `VITE_MAIL_BACKEND=demo` | fixtures `src/lib/mail.ts` |

Les écrans calendrier, planning et MCP restent sur leurs fixtures quel que soit le mode. Si le démon
est absent, `BackendBanner` l'explique et propose « Réessayer » ou « Voir la démo » — jamais d'écran
blanc.

Coquille Tauri : le processus démarre le routeur sur `127.0.0.1:8790` (`app_data_dir()`), le webview
appelle cette base (origine différente, d'où le CORS limité aux origines de la coquille et du dev
server, `tests/cors.rs`). L'APK autorise le trafic local en clair (`usesCleartextTraffic`), le démon
n'écoutant que sur la boucle locale.

## Tests

### Hors-ligne (437 tests, `cargo test --workspace`)

Presque tout est dans `tests/`, sans réseau ; les `#[cfg(test)] mod tests` de `src/` couvrent le
store (pièces jointes emportées par `delete_messages`, `Store: Send + Sync`, migrations de colonnes),
le MIME (assainissement HTML), `sync::auto_syncs` et le `Content-Disposition` des pièces jointes.

| Fichier | Tests | Couverture |
| --- | --- | --- |
| `tests/config.rs` | 9 | SPECIAL-USE prioritaire sur le nom, noms anglais/français, `Other`, `path_for`, `validate` (TLS/STARTTLS acceptés, `plain` refusé, champs vides), `Debug` sans secret |
| `tests/mime.rs` | 29 | message texte simple, quoted-printable, repli HTML → texte, préférence `text/plain`, métadonnées de pièces jointes, `PgpState`, aperçu compacté/tronqué, en-têtes de threading, en-têtes absents, autolien `<https://…>` conservé dans `body_html`/`body_text`/`preview` (URL seule, entités `&lt;` intactes), image `cid:` d'un `multipart/related` rendue en `src="data:image/png;base64,…"` (et refus : `cid:` sans part, part d'un autre type) |
| `tests/sanitize.rs` | 18 | `style` inline préservé et normalisé, valeurs qui chargent/exécutent refusées (`url(`, `expression(`, `position`, `behavior`, `-moz-binding`, `javascript:`), obfuscation (échappements CSS, commentaires intercalés, casse mixte, `image-set(url())`), déclarations mal fermées, `display` restreint, blocs `<style>` assainis et hissés avant le corps, `@media` conservé, `@import`/`@font-face`/`@supports` supprimés, évasion `</style>` neutralisée, attributs de table conservés/validés, `center`/`font`/`caption`, fixture « mail marketing » (table 600 px, styles inline, bloc `<style>`, `bgcolor`) et pixel de tracking toujours retiré du corps stocké |
| `tests/threading.rs` | 7 | `References` prioritaire, repli `In-Reply-To`, repli sujet (préfixes + accents), isolation par compte, `Message-ID` de repli, `split_ids` |
| `tests/oauth.rs` | 4 | payload XOAUTH2, cache de l'access token, rafraîchissement après expiration, message d'erreur lisible sans secret (serveur HTTP local) |
| `tests/store.rs` | 48 | upsert idempotent, recherche FTS (accents/casse, destinataires, filtres dossier/non-lu/étoilé/PJ/dates, dédoublonnage, offset, corps évincé, requête de ponctuation, `has_attachment` en-têtes puis corps, suppression nettoyant l'index), flags/corps/`delete_message`, `flags_in_folder`, `delete_messages` (vide → 0, UID inconnus ignorés, pièces jointes emportées), `set_flags_batch`, `list_accounts`/`list_folders`/`delete_account`, tri `date DESC` + pagination, agrégation des threads, absence de préfixe expéditeur dans `Sent`, migration rejouable, `relink_replies`, `clear_folder`, interrupteur PGP (défaut ouvert, par compte, survit à `upsert_account`, compte inconnu refusé) et `close_encrypted_bodies` (messages chiffrés seuls, état PGP conservé) |
| `src/store/mod.rs` (`mod tests`) | 8 | pièces jointes emportées par `delete_messages`, `Store: Send + Sync`, migration `folders.modseq`, `folders.delimiter` et `accounts.pgp` sur une base ancienne, FTS5 compilé (`ENABLE_FTS5` + `contentless_delete`), migration 6→7 (backfill de l'index et de `has_attachment`, plusieurs lots) |
| `crates/mail-api/tests/http.rs` | 70 | routeur sans socket : `/api/health`, 400 config/JSON invalide, 409 id déjà pris, aucun secret dans `GET /api/accounts`, connexion échouée n'écrit rien, 404 inconnus, chemin de dossier percent-encodé, mapping `MailError` → statut, sélection de dossiers, `PATCH /api/accounts/{id}/pgp` (défaut ouvert, bascule par compte, corps chiffrés déjà déchiffrés effacés, 404 compte inconnu), `GET /search` (400 sur date ou booléen invalide, page filtrée de l'index local) |
| `crates/mail-api/tests/pgp_gate.rs` | 3 | gate du trousseau, hors réseau : compte ouvert → `keyring_for` complet et corps déchiffré ; compte fermé → trousseau vide, corps/HTML/aperçu/pièces jointes fermés (`Clé secrète manquante`), `html_with_images` → `None` ; l'interrupteur est lu par compte |
| `crates/mail-api/tests/discovery.rs` | 10 (+2 réseau) | parsing ISPDB Gmail/LaPoste et autoconfig lanro.eu, `SSL`/`STARTTLS`, `%EMAILADDRESS%`/`%EMAILLOCALPART%`, chaîne HTTP avec serveur local (`source: ispdb`), adresse invalide, domaine inconnu |
| `tests/live.rs` (mail-core + mail-api) | 27 | réseau GreenMail, `#[ignore]` (voir ci-dessous) |

Sur cette machine (pas de compilateur C système, `rusqlite`/`ring` en ont besoin) :

```sh
export PATH=/home/roman/.local/opt/lavande-cc:$PATH
export CC=/home/roman/.local/opt/lavande-cc/cc
export CXX=/home/roman/.local/opt/lavande-cc/c++
npm run mail:test          # cargo test --workspace
```

### Réseau (`tests/live.rs`, 27 scénarios ignorés par défaut)

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
| `delete_reaches_the_server` | `delete_message` sur un message synchronisé : la ligne locale disparaît et une session brute ne voit plus l'UID côté serveur ; un second appel sur le même UID reste `Ok` (message déjà absent des deux côtés) |
| `empty_folder_clears_both_sides` | `empty_folder` sur un dossier dédié (message déplacé par `move_message`) : `removed >= 1` (réponses `EXPUNGE` du serveur), store vide et aucune UID côté serveur |
| `empty_folder_counts_a_never_synced_folder` | message copié par une session brute dans un dossier **jamais synchronisé** (aucune ligne locale), puis `empty_folder` : `removed >= 1` (un compte basé sur le store rendrait `0`) et le dossier est vide côté serveur |
| `unchanged_folder_reports_nothing` | deux synchros d'affilée sans changement : `inserted`, `flags_updated` et `removed` à 0 et `uidvalidity_changed == false` (la réconciliation est idempotente) |
| `move_keeps_store_in_step_with_server` | `create_folder` deux fois (idempotent), `move_message` INBOX → Archive (capacité `MOVE`) : la ligne INBOX disparaît, la ligne Archive réapparaît **avec l'UID réattribué par le serveur** et son corps, `fetch_body` fonctionne dessus, et une session neuve confirme que tous les UID locaux d'Archive existent côté serveur |
| `move_to_a_missing_folder_restores_the_source_row` | `move_message` vers un dossier absent (`Aucun/Dossier`) : le serveur refuse, et la ligne source est **revenue** en base (`get_message` → `Some`) sans tombstone — la restauration qui suit un échec après `drop_locally` |
| `reply_joins_the_thread` | une réponse (`In-Reply-To` + `References` = `Message-ID` du parent) rejoint le thread du parent : `thread_id` identique, un seul thread de `count == 2` |
| `xoauth2_authenticates_with_refresh_token` | échange refresh token contre un endpoint HTTP local (mock), puis `AUTHENTICATE XOAUTH2` (SASL-IR) sur GreenMail |
| `a_word_only_in_the_body_is_found_by_the_server_search` (mail-api) | mot unique **uniquement dans le corps**, au-delà des 1 024 premiers octets : après un sync INBOX (en-têtes seuls, `body_text`/`body_html` à `null`), `GET /api/accounts/{id}/search?q=<mot>` le trouve par le repli `UID SEARCH TEXT` (GreenMail honore `TEXT` et `CHARSET UTF-8`, insensible à la casse) et le message revient **sans corps** |
| `a_search_query_with_quotes_and_backslashes_does_not_break` (mail-api) | requête `a"b\c` : l'échappement de la chaîne IMAP ne casse ni la session ni la réponse (200, tableau vide) |
| `the_pgp_gate_closes_and_reopens_an_encrypted_body_on_the_server` (mail-api) | envoi chiffré + signé, `sync` INBOX, puis `GET …/messages/{uid}?fetch_body=true` : corps en clair, `pgp_detail.decrypted` et `verified` à `true` ; `PATCH /api/accounts/{id}/pgp {enabled:false}` puis lecture **sans** `fetch_body` : `body_text`/`body_html` à `null`, `preview` vide et `pgp_detail` à `null` (la purge a vidé la ligne, pas seulement bloqué le déchiffrement) ; `PATCH {enabled:true}` puis `fetch_body=true` : le corps revient déchiffré ; `GET /api/accounts` : l'autre compte du démon garde son interrupteur ouvert |

**État de l'environnement (GreenMail 2.1.15, image `greenmail/standalone:latest`)** : l'IMAP
n'annonce que `AUTH=XOAUTH2` et répond `NO` à `AUTHENTICATE PLAIN` ; `connect_with` retombe sur la
commande `LOGIN` sur `BAD` **ou `NO`**, ce qui débloque les scénarios à mot de passe. Aucun tag de
l'image n'accepte `PLAIN` (1.6.15, 2.0.1, 2.1.8 → 2.1.15 essayés). Deux incompatibilités restent :
la réponse au fetch partiel des aperçus est non conforme (littéral sans espace, pas de CRLF après le
littéral) — illisible par `async-imap`, mais sans effet sur la synchro depuis que les aperçus passent
par une connexion dédiée (aperçus vides sur ce serveur) ; et aucun dossier n'est marqué `\Drafts`
(SPECIAL-USE), ce qui fait échouer `a_composition_saved_as_a_draft_lands_in_the_drafts_folder`
(scénario mail-api, limité par le serveur de test).

Côté recherche, GreenMail **honore** `UID SEARCH TEXT` (sous-chaîne, insensible à la casse, corps et
en-têtes) et `CHARSET UTF-8` (aucun `BAD`) : le repli sans `CHARSET` n'est donc pas exercé en réseau, seul le
côté unitaire le couvre. Une requête accentuée ne rend rien : le corps est stocké encodé
(quoted-printable/base64) et le serveur ne décode pas le charset MIME avant de chercher — d'où le
choix d'un mot ASCII dans le scénario live.

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
- **IDLE sur INBOX seulement.** La veille surveille le dossier de réception de chaque compte ; les
  autres dossiers ne se rafraîchissent qu'à la demande, et il n'y a rien côté serveur pour pousser
  vers un appareil éteint (pas de service de notification type UnifiedPush).
- **Images distantes retirées à l'ingestion.** Le corps stocké ne garde aucun `img` dont le `src`
  est `http(s)` (pixels de tracking) ; elles ne reviennent que sur demande, message par message, via
  `html-images`. Les images `data:` (dont les `cid:` rendues en `data:`) sont conservées. Le
  reste du rendu suit le mail : styles inline et blocs `<style>` filtrés, attributs de table,
  `center`/`font`. Ce qui n'est pas dans la whitelist CSS (positionnements absolus, `url()`,
  `@font-face`) est perdu : un mail qui découpe sa mise en page en `position:absolute` retombe sur
  un flux normal.
- **OAuth2 sans identifiant embarqué** : un `client_id` doit être enregistré (ou fourni par
  l'environnement). Le parcours n'est validé qu'avec un fournisseur factice et GreenMail, pas contre
  Google/Microsoft en vrai.
- **Suppression définitive : refus sans `UIDPLUS` pour un message, `EXPUNGE` dossier-wide assumé
  pour un dossier.** `imap::delete_message` exige `UIDPLUS` et le vérifie **avant** de marquer quoi
  que ce soit : sans lui, l'`EXPUNGE` disponible emporte *tous* les messages déjà marqués `\Deleted`
  du dossier, y compris ceux qu'un autre client a marqués, et l'IMAP ne permet pas de restreindre
  l'expunge à un seul message. La suppression d'un message est donc refusée (`MailError::Imap`,
  502 côté API) plutôt que de risquer d'en détruire plusieurs. `imap::empty_folder` garde le
  `EXPUNGE` dossier-wide : vider le dossier est précisément l'intention, y compris pour les
  messages marqués par un autre client. Les deux sont exposés par le démon
  (`/api/accounts/{id}/delete`, `/api/accounts/{id}/purge`) ; `removed` sur `/purge` compte les
  réponses `EXPUNGE` du serveur. Un message déjà absent côté serveur ne fait pas échouer `delete_message`
  (`STORE` et `UID EXPUNGE` répondent `OK` sur un UID inconnu) et la ligne locale est supprimée
  quand même ; une ligne locale déjà absente est tolérée de la même façon.
- **Pas de reprise réseau.** Aucun retry, aucun timeout applicatif sur `TcpStream::connect`, pas de
  reconnexion : une coupure remonte en `MailError::Imap`/`Io` et l'appelant doit réessayer.
- **Un seul dossier par appel de `sync_folder`.** `sync_account` se limite à `Inbox` + `Sent` ; les
  autres dossiers (Archive, Trash, Spam, dossiers personnels) ne sont synchronisés que si on les
  demande un par un. `move_message` en réconcilie un second (la destination).
- **Aperçu et pièces jointes vides avant la première ouverture.** La synchro ne télécharge que les
  en-têtes : `preview` reste vide et `attachments` vide tant qu'`fetch_body` n'a pas relu le message
  (l'endpoint `?fetch_body=true` le fait à l'ouverture). Un message sans corps texte ni HTML
  (pièces jointes seules) est donc relu à chaque ouverture.
- **Pas de pool, pas de PGP réel, pas de flux navigateur OAuth2.** Voir la vue d'ensemble. Le
  trousseau système existe (desktop Linux) ; Android utilise le fichier chiffré en attendant un
  Keystore matériel.
- **L'index local est un index de mots** (FTS5, voir « Recherche ») : pas de sous-chaîne interne,
  `preview` non indexé, corps évincés (> 30 j) désindexés. **Le repli serveur est un
  enrichissement, pas un index** : dossiers déjà connus en base seulement, borné (`2 × limit` UID,
  10 s), et il ne voit pas dans un corps chiffré (`UID SEARCH TEXT` cherche le ciphertext PGP).
- **`Store` incomplet pour l'IPC** : ni `list_accounts`, ni liste des dossiers d'un compte, ni
  suppression de compte.
- **`OutgoingMessage`/`OutgoingAttachment` ne sont pas `Deserialize`** : le DTO Tauri est à écrire
  (pièces jointes en base64, donc une étape de décodage).
- **`set_flags` n'écrit que `\Seen` et `\Flagged`** ; `answered` est purement indicatif.
- **Threading heuristique** : repli sur le sujet normalisé quand aucun identifiant n'existe (deux
  conversations au même sujet fusionnent), et `relink_replies` matche `references_json` par
  sous-chaîne.
- **Migration par colonnes ajoutées, pas par étapes numérotées** : `schema.sql` (dont le
  `CREATE TABLE IF NOT EXISTS`) puis `add_missing_columns` (`PRAGMA table_info` + `ALTER TABLE`)
  amènent une base ancienne à `user_version = 7`. Une colonne renommée, une contrainte changée ou
  une donnée à réécrire demanderont une vraie étape de migration.
- **L'interrupteur PGP ne couvre que la réception.** Fermer un compte n'empêche pas le démon de
  signer ou chiffrer à l'envoi (`submit` garde le trousseau complet) : la composition est gatée côté
  front (`resolvePgp`), pas par la route `/send`. Un message déjà déchiffré avant la fermeture est
  effacé de la base, mais rien ne garantit la disparition des copies hors base (sauvegardes,
  `mail.db` copié).
