//! IMAP transport: TLS (implicit or STARTTLS), folder listing and folder sync.
//!
//! Every network operation takes an already authenticated session: the caller
//! opens and closes it, there is no pool and no automatic reconnection.

use std::collections::{HashMap, HashSet};
use std::fmt::Debug;
use std::sync::Arc;
use std::time::Duration;

use async_imap::error::Error;
use async_imap::imap_proto::types::NameAttribute;
use async_imap::types::{Fetch, Flag, Name};
use async_imap::{Client, Session};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use futures::TryStreamExt;
use rustls::pki_types::ServerName;
use rustls::RootCertStore;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use crate::config::{self, AccountConfig, AuthConfig, Encryption, FolderMapping};
use crate::error::MailError;
use crate::mime;
use crate::model::{Flags, Folder, FolderRole, Message};
use crate::oauth::{xoauth2_payload, OAuth2Provider, XOAuth2Authenticator};
use crate::pgp::PgpKeyring;
use crate::store::Store;
use crate::threading;
use crate::tls::TlsOptions;
use crate::utf7;

pub type ImapSession = Session<TlsStream<TcpStream>>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub inserted: usize,
    pub flags_updated: usize,
    pub removed: usize,
    pub uidvalidity_changed: bool,
    pub uidnext: u32,
    /// Uids dont l'aperçu reste à charger, du plus récent au plus ancien.
    pub preview_uids: Vec<u32>,
}

const IMPORT_BATCH: usize = 500;

/// Combien des messages les plus récents d'un dossier reçoivent un aperçu dès
/// la synchronisation, sans que leur corps soit stocké.
const SNIPPET_BATCH: usize = 50;

/// Un serveur qui ne répond pas ne doit pas retenir la requête indéfiniment.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

/// SASL PLAIN responder: empty authzid, authcid then password.
struct PlainAuthenticator {
    username: String,
    password: String,
}

impl PlainAuthenticator {
    fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            password: password.into(),
        }
    }
}

impl async_imap::Authenticator for PlainAuthenticator {
    type Response = Vec<u8>;

    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        format!("\0{}\0{}", self.username, self.password).into_bytes()
    }
}

/// Opens a TLS connection and authenticates against the webpki roots.
pub async fn connect(cfg: &AccountConfig) -> Result<ImapSession, MailError> {
    connect_with(cfg, &TlsOptions::default()).await
}

/// Opens a TLS connection and authenticates. Implicit TLS and STARTTLS both
/// end up as a `TlsStream<TcpStream>` session.
pub async fn connect_with(
    cfg: &AccountConfig,
    tls_options: &TlsOptions,
) -> Result<ImapSession, MailError> {
    let tcp = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((cfg.imap.host.as_str(), cfg.imap.port)),
    )
    .await
    .map_err(|_| {
        MailError::Imap(format!(
            "délai dépassé en contactant {}:{}",
            cfg.imap.host, cfg.imap.port
        ))
    })?
    .map_err(|error| {
        MailError::Imap(format!(
            "cannot reach {}:{}: {error}",
            cfg.imap.host, cfg.imap.port
        ))
    })?;

    let client = match cfg.imap.encryption {
        Encryption::Tls => {
            let mut client = Client::new(tls_handshake(&cfg.imap.host, tcp, tls_options).await?);
            read_greeting(&mut client).await?;
            client
        }
        Encryption::StartTls => {
            let mut client = Client::new(tcp);
            read_greeting(&mut client).await?;
            client
                .run_command_and_check_ok("STARTTLS", None)
                .await
                .map_err(imap_error)?;
            Client::new(tls_handshake(&cfg.imap.host, client.into_inner(), tls_options).await?)
        }
        Encryption::Plain => {
            return Err(MailError::Config(
                "plaintext imap connection is forbidden with stored credentials".to_string(),
            ))
        }
    };

    match &cfg.auth {
        AuthConfig::Password { password } => {
            let plain = client
                .authenticate("PLAIN", PlainAuthenticator::new(&cfg.username, password))
                .await;
            let client = match plain {
                Ok(session) => return Ok(session),
                Err((Error::Bad(_) | Error::No(_), client)) => client,
                Err((error, _)) => return Err(MailError::Auth(error.to_string())),
            };
            client
                .login(&cfg.username, password)
                .await
                .map_err(|(error, _)| MailError::Auth(error.to_string()))
        }
        AuthConfig::OAuth2 {
            client_id,
            client_secret,
            refresh_token,
            token_endpoint,
        } => {
            let mut provider = OAuth2Provider::new(
                client_id.clone(),
                client_secret.clone(),
                refresh_token.clone(),
                token_endpoint.clone(),
            );
            let access_token = provider.access_token().await?;
            let initial_response = format!(
                "XOAUTH2 {}",
                BASE64.encode(xoauth2_payload(&cfg.email, &access_token))
            );
            let inline = client
                .authenticate(
                    initial_response,
                    XOAuth2Authenticator::new(&cfg.email, access_token.clone()),
                )
                .await;
            let client = match inline {
                Ok(session) => return Ok(session),
                Err((Error::Bad(_), client)) => client,
                Err((error, _)) => return Err(MailError::Auth(error.to_string())),
            };
            client
                .authenticate(
                    "XOAUTH2",
                    XOAuth2Authenticator::new(&cfg.email, access_token),
                )
                .await
                .map_err(|(error, _)| MailError::Auth(error.to_string()))
        }
    }
}

/// Display name of a folder: the leaf of its `path`, decoded out of the
/// modified UTF-7 servers label mailboxes with. The `path` stays raw, it is
/// what the IMAP commands take.
fn folder_label(path: &str) -> String {
    utf7::decode_modified_utf7(config::leaf_name(path))
}

/// `LIST "" "*"`, with `UIDVALIDITY`/`UIDNEXT` read by `STATUS`, ready for
/// `Store::upsert_folder`. Non-selectable names are skipped.
pub async fn list_folders(
    session: &mut ImapSession,
    account_id: &str,
) -> Result<Vec<Folder>, MailError> {
    let names: Vec<Name> = session
        .list(None, Some("*"))
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;

    let mut folders = Vec::new();
    for name in names {
        if name
            .attributes()
            .iter()
            .any(|attribute| matches!(attribute, NameAttribute::NoSelect))
        {
            continue;
        }
        let path = name.name().to_string();
        let flags: Vec<String> = name
            .attributes()
            .iter()
            .map(|attribute| attribute_label(attribute).to_string())
            .collect();
        let label = folder_label(&path);
        let delimiter = name.delimiter().map(str::to_string);
        let status = session
            .status(&path, "(UIDVALIDITY UIDNEXT)")
            .await
            .map_err(imap_error)?;
        folders.push(Folder {
            account_id: account_id.to_string(),
            role: config::folder_role(&path, &label, &flags),
            path,
            name: label,
            uidvalidity: uidvalidity_of(&status, account_id)?,
            uidnext: uidnext_of(&status, account_id)?,
            last_sync_at: None,
            modseq: None,
            delimiter,
        });
    }
    Ok(folders)
}

/// Syncs one folder against the server state. A server that advertises
/// CONDSTORE gets the incremental pass, every other server — and every
/// CONDSTORE failure — the full one.
pub async fn sync_folder(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    mapping: &FolderMapping,
) -> Result<SyncReport, MailError> {
    reconcile(session, store, account_id, folder_path, Some(mapping)).await
}

/// Brings one folder in step with the server. When the store holds the
/// `HIGHESTMODSEQ` of the mailbox, a `CHANGEDSINCE` fetch is enough to see the
/// new messages and the flag changes; anything the server refuses, and any
/// mailbox whose counts do not add up (a message vanished), falls back to the
/// full pass: one metadata pass decides what vanished, what changed flags and
/// what is new, then the metadata of the new uids is imported in batches — no
/// body is ever downloaded here, `fetch_body` pulls one when a message is
/// opened. `mapping` only names the role of a folder the store has never seen.
async fn reconcile(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    mapping: Option<&FolderMapping>,
) -> Result<SyncReport, MailError> {
    let condstore = condstore_ready(session).await;
    let (mailbox, condstore) = select_folder(session, folder_path, condstore).await?;
    let uidvalidity = uidvalidity_of(&mailbox, account_id)?;
    let uidnext = uidnext_of(&mailbox, account_id)?;

    let stored = store.get_folder(account_id, folder_path)?;
    let uidvalidity_changed = stored
        .as_ref()
        .is_some_and(|folder| folder.uidvalidity != uidvalidity);
    if uidvalidity_changed {
        store.clear_folder(account_id, folder_path)?;
    }

    let target = Target {
        account_id,
        folder_path,
        uidvalidity,
    };

    if let (true, Some(baseline), Some(highest)) = (
        condstore,
        resumable_modseq(stored.as_ref(), uidvalidity_changed),
        mailbox.highest_modseq,
    ) {
        match incremental(session, store, &target, &mailbox, baseline).await {
            Ok(Some(report)) => {
                tracing::debug!(
                    account = account_id,
                    folder = folder_path,
                    baseline,
                    highest,
                    "synchronisation incrémentale"
                );
                record_sync(
                    store,
                    &target,
                    stored.as_ref(),
                    mapping,
                    uidnext,
                    Some(highest),
                )?;
                return Ok(report);
            }
            Ok(None) => {
                tracing::debug!(
                    account = account_id,
                    folder = folder_path,
                    baseline,
                    "état local irréconciliable, synchronisation complète"
                );
            }
            Err(error) => {
                tracing::warn!(account = account_id, folder = folder_path, %error, "CHANGEDSINCE refusé, synchronisation complète");
            }
        }
    }

    let local = store.flags_in_folder(account_id, folder_path)?;
    let server = server_state(session).await?;

    let vanished: Vec<u32> = local
        .keys()
        .filter(|uid| !server.contains_key(uid))
        .copied()
        .collect();
    let mut changed = Vec::new();
    let mut new_uids = Vec::new();
    for (uid, (flags, _)) in &server {
        match local.get(uid) {
            Some(known) if known != flags => changed.push((*uid, *flags)),
            Some(_) => {}
            None => new_uids.push(*uid),
        }
    }
    changed.sort_unstable_by_key(|(uid, _)| *uid);
    new_uids.sort_unstable_by(|a, b| b.cmp(a));

    let mut report = SyncReport {
        uidvalidity_changed,
        uidnext,
        removed: store.delete_messages(account_id, folder_path, &vanished)?,
        flags_updated: store.set_flags_batch(account_id, folder_path, &changed)?,
        ..SyncReport::default()
    };

    for batch in new_uids.chunks(IMPORT_BATCH) {
        report.inserted += import_metadata(session, store, &target, batch, &server).await?;
    }
    report.preview_uids = newest(&new_uids).to_vec();

    record_sync(
        store,
        &target,
        stored.as_ref(),
        mapping,
        uidnext,
        mailbox.highest_modseq,
    )?;
    Ok(report)
}

/// Writes the folder row a finished sync leaves behind. `modseq` is the
/// `HIGHESTMODSEQ` read by the `SELECT` of this sync, never one read later: a
/// change the server made in between is fetched again next time instead of
/// being skipped.
fn record_sync(
    store: &Store,
    target: &Target<'_>,
    stored: Option<&Folder>,
    mapping: Option<&FolderMapping>,
    uidnext: u32,
    modseq: Option<u64>,
) -> Result<(), MailError> {
    let role = stored
        .map(|folder| folder.role)
        .filter(|role| *role != FolderRole::Other)
        .or_else(|| mapping.and_then(|mapping| mapped_role(mapping, target.folder_path)))
        .unwrap_or(FolderRole::Other);
    store.upsert_folder(&Folder {
        account_id: target.account_id.to_string(),
        path: target.folder_path.to_string(),
        name: folder_label(target.folder_path),
        role,
        uidvalidity: target.uidvalidity,
        uidnext,
        last_sync_at: Some(Utc::now()),
        modseq,
        delimiter: stored.and_then(|folder| folder.delimiter.clone()),
    })
}

/// Whether the server can serve a `CHANGEDSINCE` refresh. A probe that fails is
/// a server without CONDSTORE as far as the sync is concerned: the full pass is
/// the one path that cannot lose anything.
async fn condstore_ready(session: &mut ImapSession) -> bool {
    // Incremental pass not yet validated against a real CONDSTORE server: it is
    // opt-in (LAVANDE_MAIL_CONDSTORE=1) until then; the full pass is the safe default.
    if !condstore_opt_in() {
        return false;
    }
    match supports_condstore(session).await {
        Ok(supported) => supported,
        Err(error) => {
            tracing::warn!(%error, "CAPABILITY illisible, synchronisation complète");
            false
        }
    }
}

fn condstore_opt_in() -> bool {
    matches!(
        std::env::var("LAVANDE_MAIL_CONDSTORE").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// Whether the server serves the incremental pass: `CONDSTORE`, or `QRESYNC`
/// which RFC 7162 makes a superset of it.
pub async fn supports_condstore(session: &mut ImapSession) -> Result<bool, MailError> {
    let capabilities = session.capabilities().await.map_err(imap_error)?;
    Ok(capabilities.has_str("CONDSTORE") || capabilities.has_str("QRESYNC"))
}

/// RFC 5161 `ENABLE CONDSTORE`, which only means the server also sends the
/// `MODSEQ` of its unsolicited flag updates — this sync never reads those, it
/// takes `HIGHESTMODSEQ` from `SELECT` and asks for `CHANGEDSINCE` itself. So a
/// server without `ENABLE`, and a server that refuses the command, lose
/// nothing: both are logged and the sync carries on.
///
/// RFC 5161 only allows `ENABLE` outside a selected mailbox: this must be
/// called once on a fresh session, before the first `SELECT`.
pub async fn enable_condstore(session: &mut ImapSession) {
    let capabilities = match session.capabilities().await {
        Ok(capabilities) => capabilities,
        Err(error) => {
            tracing::warn!(%error, "CAPABILITY illisible, ENABLE CONDSTORE ignoré");
            return;
        }
    };
    if !capabilities.has_str("ENABLE")
        || !(capabilities.has_str("CONDSTORE") || capabilities.has_str("QRESYNC"))
    {
        return;
    }
    if let Err(error) = session.run_command_and_check_ok("ENABLE CONDSTORE").await {
        tracing::debug!(%error, "ENABLE CONDSTORE refusé");
    }
}

/// Selects the mailbox, asking for `HIGHESTMODSEQ` when `condstore` is set. A
/// server that refuses the parameter leaves no mailbox selected, so the plain
/// `SELECT` that follows puts the session back where the full pass expects it.
async fn select_folder(
    session: &mut ImapSession,
    folder_path: &str,
    condstore: bool,
) -> Result<(async_imap::types::Mailbox, bool), MailError> {
    if condstore {
        match session.select_condstore(folder_path).await {
            Ok(mailbox) => return Ok((mailbox, true)),
            Err(error) => {
                tracing::warn!(folder = folder_path, %error, "SELECT (CONDSTORE) refusé, synchronisation complète");
            }
        }
    }
    let mailbox = session.select(folder_path).await.map_err(imap_error)?;
    Ok((mailbox, false))
}

/// The modseq an incremental pass may resume from: `None` when the store never
/// completed a full pass of the folder, and `None` when the mailbox came back
/// with another `UIDVALIDITY` (the old uids, and so the old modseq, mean
/// nothing).
fn resumable_modseq(stored: Option<&Folder>, uidvalidity_changed: bool) -> Option<u64> {
    if uidvalidity_changed {
        return None;
    }
    stored.and_then(|folder| folder.modseq)
}

/// One `CHANGEDSINCE` pass: the server answers the messages it touched since
/// `baseline` only, so the flag updates, the metadata of the new uids and the
/// `None` the caller turns into a full pass are all decided by `diff_since`.
async fn incremental(
    session: &mut ImapSession,
    store: &Store,
    target: &Target<'_>,
    mailbox: &async_imap::types::Mailbox,
    baseline: u64,
) -> Result<Option<SyncReport>, MailError> {
    let touched = changes_since(session, baseline).await?;
    let local = store.flags_in_folder(target.account_id, target.folder_path)?;
    let Some(plan) = diff_since(&local, &touched, mailbox.exists) else {
        return Ok(None);
    };

    let mut report = SyncReport {
        flags_updated: store.set_flags_batch(
            target.account_id,
            target.folder_path,
            &plan.changed,
        )?,
        uidnext: uidnext_of(mailbox, target.account_id)?,
        ..SyncReport::default()
    };
    for batch in plan.new_uids.chunks(IMPORT_BATCH) {
        report.inserted += import_metadata(session, store, target, batch, &touched).await?;
    }
    report.preview_uids = newest(&plan.new_uids).to_vec();
    Ok(Some(report))
}

/// The writes a `CHANGEDSINCE` pass has to make: the uids the store has never
/// seen (their metadata is imported) and the known uids whose flags moved.
#[derive(Debug, Default, PartialEq, Eq)]
struct IncrementalPlan {
    new_uids: Vec<u32>,
    changed: Vec<(u32, Flags)>,
}

/// What a `CHANGEDSINCE` answer means for the local folder: `None` when the
/// counts cannot be reconciled, which happens as soon as a message vanished
/// since the last sync — `CHANGEDSINCE` does not report an expunge, and running
/// on would leave a ghost row behind. The caller then runs the full pass, which
/// names the vanished uids through `UID FETCH 1:*`.
fn diff_since(
    local: &HashMap<u32, Flags>,
    touched: &HashMap<u32, (Flags, u32)>,
    exists: u32,
) -> Option<IncrementalPlan> {
    let mut new_uids = Vec::new();
    let mut changed = Vec::new();
    for (uid, (flags, _)) in touched {
        match local.get(uid) {
            Some(known) if known != flags => changed.push((*uid, *flags)),
            Some(_) => {}
            None => new_uids.push(*uid),
        }
    }
    new_uids.sort_unstable_by(|a, b| b.cmp(a));
    changed.sort_unstable_by_key(|(uid, _)| *uid);

    (local.len() + new_uids.len() == exists as usize)
        .then_some(IncrementalPlan { new_uids, changed })
}

/// `UID FETCH 1:* (UID FLAGS RFC822.SIZE) (CHANGEDSINCE <modseq>)`: the touched
/// messages only, in the shape `server_state` returns. The data items are the
/// ones of the full pass, so `import_metadata` reads the same map either way.
async fn changes_since(
    session: &mut ImapSession,
    baseline: u64,
) -> Result<HashMap<u32, (Flags, u32)>, MailError> {
    let fetches: Vec<Fetch> = session
        .uid_fetch("1:*", changes_since_query(baseline).as_str())
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;
    Ok(by_uid(&fetches))
}

/// The fetch modifiers of RFC 7162, which async-imap passes through verbatim
/// after the data items: a misplaced parenthesis is a `BAD` from the server, not
/// a silent miss, but it is also the one wire detail this crate spells itself.
fn changes_since_query(baseline: u64) -> String {
    format!("(UID FLAGS RFC822.SIZE) (CHANGEDSINCE {baseline})")
}

/// `UID FETCH 1:* (UID FLAGS RFC822.SIZE)`: the whole folder in one round trip.
async fn server_state(session: &mut ImapSession) -> Result<HashMap<u32, (Flags, u32)>, MailError> {
    let fetches: Vec<Fetch> = session
        .uid_fetch("1:*", "(UID FLAGS RFC822.SIZE)")
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;
    Ok(by_uid(&fetches))
}

/// The `(flags, size)` of every fetch the server answered, by uid.
fn by_uid(fetches: &[Fetch]) -> HashMap<u32, (Flags, u32)> {
    fetches
        .iter()
        .filter_map(|fetch| {
            Some((
                fetch.uid?,
                (flags_of(fetch), fetch.size.unwrap_or_default()),
            ))
        })
        .collect()
}

/// Where the bodies being imported go.
struct Target<'a> {
    account_id: &'a str,
    folder_path: &'a str,
    uidvalidity: u32,
}

/// Writes one envelope read from the server: headers only, never a body. `false`
/// when the headers are unreadable — the message is skipped, not fatal.
fn store_header(
    store: &Store,
    target: &Target<'_>,
    uid: u32,
    flags: Flags,
    size: u32,
    raw: &[u8],
) -> Result<bool, MailError> {
    let account_id = target.account_id;
    let folder_path = target.folder_path;
    if store.is_tombstoned(account_id, folder_path, uid) {
        return Ok(false);
    }
    let parsed = match mime::parse_headers(raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            tracing::warn!(account = account_id, folder = folder_path, uid, %error, "message illisible, ignoré");
            return Ok(false);
        }
    };
    let message = Message {
        account_id: account_id.to_string(),
        folder_path: folder_path.to_string(),
        uid,
        uidvalidity: target.uidvalidity,
        thread_id: threading::thread_id(
            account_id,
            &parsed.subject,
            parsed.message_id.as_deref(),
            parsed.in_reply_to.as_deref(),
            &parsed.references,
        ),
        message_id: parsed.message_id,
        in_reply_to: parsed.in_reply_to,
        references: parsed.references,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        date: parsed.date,
        flags,
        size,
        pgp: parsed.pgp,
        pgp_detail: parsed.pgp_detail,
        preview: parsed.preview,
        body_text: parsed.body_text,
        body_html: parsed.body_html,
        attachments: parsed.attachments,
    };
    store.upsert_message(&message)?;
    let thread_id = match message.in_reply_to.as_deref() {
        Some(in_reply_to) => match store.thread_of_message(account_id, in_reply_to)? {
            Some(parent_thread) if parent_thread != message.thread_id => {
                store.rethread(account_id, folder_path, uid, &parent_thread)?;
                parent_thread
            }
            _ => message.thread_id.clone(),
        },
        None => message.thread_id.clone(),
    };
    if let Some(message_id) = &message.message_id {
        store.relink_replies(account_id, message_id, &thread_id)?;
    }
    Ok(true)
}

/// Reads and stores the metadata of `uids` only: `BODY.PEEK[HEADER]`, never the
/// body. The body, the preview and the attachments arrive with `fetch_body`
/// when the message is opened. A uid the server answers without headers is
/// skipped, not fatal.
async fn import_metadata(
    session: &mut ImapSession,
    store: &Store,
    target: &Target<'_>,
    uids: &[u32],
    server: &HashMap<u32, (Flags, u32)>,
) -> Result<usize, MailError> {
    let fetches = fetch_headers(session, uids).await?;
    let mut inserted = 0;
    for fetch in fetches {
        let (Some(uid), Some(raw)) = (fetch.uid, fetch.header()) else {
            continue;
        };
        let Some((flags, size)) = server.get(&uid) else {
            continue;
        };
        if store_header(store, target, uid, *flags, *size, raw)? {
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// The `uid1,uid2,…` set a `UID FETCH` selector takes.
fn uid_selector(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

async fn fetch_headers(session: &mut ImapSession, uids: &[u32]) -> Result<Vec<Fetch>, MailError> {
    session
        .uid_fetch(uid_selector(uids), "(UID BODY.PEEK[HEADER])")
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)
}

/// Imports the headers of `uids` a server-side search just found, with the flags
/// the same fetch carries: `UID FETCH … (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])`, never a
/// body. Same contract as the sync import: envelope, flags and threading only.
pub async fn import_headers(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uidvalidity: u32,
    uids: &[u32],
) -> Result<usize, MailError> {
    if uids.is_empty() {
        return Ok(0);
    }
    let target = Target {
        account_id,
        folder_path,
        uidvalidity,
    };
    let fetches: Vec<Fetch> = session
        .uid_fetch(
            uid_selector(uids),
            "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])",
        )
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;
    let mut inserted = 0;
    for fetch in fetches {
        let (Some(uid), Some(raw)) = (fetch.uid, fetch.header()) else {
            continue;
        };
        let size = fetch.size.unwrap_or_default();
        if store_header(store, &target, uid, flags_of(&fetch), size, raw)? {
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// `SELECT` then `UID SEARCH TEXT` on one folder: the server matches bodies and
/// headers, which the local store cannot do for a message whose body was never
/// downloaded. The uids come back newest first.
pub async fn select_and_search(
    session: &mut ImapSession,
    folder_path: &str,
    query: &str,
) -> Result<Vec<u32>, MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    let escaped = escape_search(query);
    let uids = session
        .uid_search(format!("CHARSET UTF-8 TEXT \"{escaped}\""))
        .await
        .map_err(imap_error)?;
    // Un serveur qui refuse CHARSET rend une réponse vide, pas une erreur :
    // async-imap avale le BAD/NO étiqueté. Une requête ASCII vide repart donc
    // sans le préfixe avant d'être tenue pour « aucun résultat ».
    let uids = if uids.is_empty() && query.is_ascii() {
        session
            .uid_search(format!("TEXT \"{escaped}\""))
            .await
            .map_err(imap_error)?
    } else {
        uids
    };
    Ok(descending(uids))
}

fn descending(uids: HashSet<u32>) -> Vec<u32> {
    let mut uids: Vec<u32> = uids.into_iter().collect();
    uids.sort_unstable_by(|left, right| right.cmp(left));
    uids
}

/// A quoted IMAP string escapes `\` and `"`; CR and LF cannot appear in a quoted
/// string at all and become spaces.
fn escape_search(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len());
    for character in query.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\r' | '\n' => escaped.push(' '),
            other => escaped.push(other),
        }
    }
    escaped
}

/// The uids that get an aperçu: the newest `SNIPPET_BATCH` of a descending list.
fn newest(uids: &[u32]) -> &[u32] {
    &uids[..uids.len().min(SNIPPET_BATCH)]
}

/// Fills the aperçu of `uids` from the first kilobyte of their body, which is
/// never stored: the body itself still arrives with `fetch_body`. Best-effort
/// by design — a server that refuses the partial fetch, or answers it in a
/// shape this client cannot read, leaves the aperçus empty and the sync that
/// already wrote the headers untouched.
async fn import_previews(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uids: &[u32],
) {
    if uids.is_empty() {
        return;
    }
    let fetches: Vec<Fetch> = match session
        .uid_fetch(
            uid_selector(uids),
            "(UID BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.1024>)",
        )
        .await
    {
        Ok(stream) => match stream.try_collect().await {
            Ok(fetches) => fetches,
            Err(error) => {
                tracing::warn!(%error, "aperçus illisibles, synchronisation sans aperçu");
                return;
            }
        },
        Err(error) => {
            tracing::warn!(%error, "aperçu refusé par le serveur, synchronisation sans aperçu");
            return;
        }
    };
    for fetch in fetches {
        let (Some(uid), Some(raw), Some(snippet)) = (fetch.uid, fetch.header(), fetch.text())
        else {
            continue;
        };
        let Ok(parsed) = mime::parse_headers_with_snippet(raw, snippet) else {
            continue;
        };
        if parsed.preview.is_empty() {
            continue;
        }
        if let Err(error) = store.set_preview(account_id, folder_path, uid, &parsed.preview) {
            tracing::warn!(uid, %error, "aperçu non enregistré");
        }
    }
}

/// Aperçus sur une connexion dédiée : une réponse partielle que le client ne
/// sait pas lire empoisonne la session qui l'a reçue, et la synchro principale
/// n'en voit alors rien. Best-effort : tout échec laisse les aperçus vides.
pub async fn fetch_previews(
    cfg: &AccountConfig,
    tls_options: &TlsOptions,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uids: &[u32],
) {
    if uids.is_empty() {
        return;
    }
    let mut session = match connect_with(cfg, tls_options).await {
        Ok(session) => session,
        Err(error) => {
            tracing::warn!(%error, "aperçus : connexion impossible");
            return;
        }
    };
    if let Err(error) = session.select(folder_path).await {
        tracing::warn!(%error, "aperçus : dossier inaccessible");
        return;
    }
    import_previews(&mut session, store, account_id, folder_path, uids).await;
    if let Err(error) = session.logout().await {
        tracing::warn!(%error, "fermeture de la session imap (aperçus)");
    }
}

/// Re-reads one message and stores its body, its preview, its attachments and
/// its PGP state in one write.
pub async fn fetch_body(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uid: u32,
    keys: &PgpKeyring,
) -> Result<(), MailError> {
    let raw = raw_message(session, folder_path, uid).await?;
    let parsed = mime::parse_message_with_keys(&raw, keys)?;
    store.set_body(account_id, folder_path, uid, &parsed)
}

/// Re-reads one attachment. The bytes are never stored: they come from the
/// server on demand. `index` is the position `mime::parse_message` lists the
/// part at, which is what the stored `AttachmentMeta` rows carry.
pub async fn fetch_attachment(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
    index: usize,
    keys: &PgpKeyring,
) -> Result<Option<mime::AttachmentBody>, MailError> {
    let raw = raw_message(session, folder_path, uid).await?;
    mime::attachment_body(&raw, index, keys)
}

/// Re-reads one message and hands back its HTML with the remote images kept,
/// sanitized by `mime::sanitize_html_with_images`. The markup is never stored:
/// it only exists for a reader who asked for the images of this message.
/// `None` when the message has no HTML part, or when its encrypted body cannot
/// be opened.
pub async fn fetch_html_with_images(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
    keys: &PgpKeyring,
) -> Result<Option<String>, MailError> {
    let raw = raw_message(session, folder_path, uid).await?;
    mime::html_with_images(&raw, keys)
}

/// The RFC 5322 bytes of one message, as the server holds them.
async fn raw_message(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
) -> Result<Vec<u8>, MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    let fetches: Vec<Fetch> = session
        .uid_fetch(uid.to_string(), "(BODY.PEEK[])")
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;
    fetches
        .into_iter()
        .find_map(|fetch| fetch.body().map(<[u8]>::to_vec))
        .ok_or_else(|| MailError::Imap(format!("uid {uid} carries no body")))
}

/// Reads the flags one message carries on the server.
pub async fn fetch_flags(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
) -> Result<Flags, MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    let fetches: Vec<Fetch> = session
        .uid_fetch(uid.to_string(), "(FLAGS)")
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;
    let fetch = fetches
        .first()
        .ok_or_else(|| MailError::Imap(format!("uid {uid} is not in {folder_path}")))?;
    Ok(flags_of(fetch))
}

/// `CREATE`: a folder that already exists is not an error.
pub async fn create_folder(session: &mut ImapSession, path: &str) -> Result<(), MailError> {
    match session.create(path).await {
        Ok(()) => Ok(()),
        Err(error) if already_exists(&error) => Ok(()),
        Err(error) => Err(imap_error(error)),
    }
}

/// `DELETE`: a folder another client already removed is not an error.
pub async fn delete_folder(session: &mut ImapSession, path: &str) -> Result<(), MailError> {
    match session.delete(path).await {
        Ok(()) => Ok(()),
        Err(error) if already_gone(&error) => Ok(()),
        Err(error) => Err(imap_error(error)),
    }
}

/// Pushes `\Seen` and `\Flagged`; `\Answered` is read from the server but
/// never written.
pub async fn set_flags(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
    flags: &Flags,
) -> Result<(), MailError> {
    set_flags_many(session, folder_path, &[uid], flags).await
}

/// Same flags on many messages, in one `UID STORE` per direction: the selector
/// carries every uid, so the server sees two commands whatever the selection
/// holds. An empty selection is a no-op and never touches the connection.
pub async fn set_flags_many(
    session: &mut ImapSession,
    folder_path: &str,
    uids: &[u32],
    flags: &Flags,
) -> Result<(), MailError> {
    if uids.is_empty() {
        return Ok(());
    }
    session.select(folder_path).await.map_err(imap_error)?;
    let selector = uid_selector(uids);
    let (add, remove) = flag_changes(flags);
    store_flags_selector(session, &selector, "+FLAGS", &add).await?;
    store_flags_selector(session, &selector, "-FLAGS", &remove).await
}

/// The flags `set_flags` adds and removes: `unread` drops `\Seen`, `starred`
/// adds `\Flagged`, and each one is undone in the other direction.
fn flag_changes(flags: &Flags) -> (Vec<&'static str>, Vec<&'static str>) {
    let mut add = Vec::new();
    let mut remove = Vec::new();
    if flags.unread {
        remove.push("\\Seen");
    } else {
        add.push("\\Seen");
    }
    if flags.starred {
        add.push("\\Flagged");
    } else {
        remove.push("\\Flagged");
    }
    (add, remove)
}

/// One message: a single uid through `move_messages`.
pub async fn move_message(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    from_path: &str,
    uid: u32,
    to_path: &str,
) -> Result<(), MailError> {
    move_messages(session, store, account_id, from_path, &[uid], to_path).await
}

/// `UID MOVE` when the server has the capability, `UID COPY` + `\Deleted` +
/// `UID EXPUNGE` otherwise; the fallback needs `UIDPLUS` and is refused before
/// the copy when the server does not announce it. One command per step carries
/// every uid. The source uids are tombstoned as soon as the server accepted the
/// move — before the rows are dropped — so a sync that wakes up on the move
/// cannot re-import them, then the source rows are dropped and the destination
/// reconciled so it carries the uids the server actually gave the messages.
pub async fn move_messages(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    from_path: &str,
    uids: &[u32],
    to_path: &str,
) -> Result<(), MailError> {
    if uids.is_empty() {
        return Ok(());
    }
    let selector = uid_selector(uids);
    session.select(from_path).await.map_err(imap_error)?;
    let capabilities = session.capabilities().await.map_err(imap_error)?;
    if capabilities.has_str("MOVE") {
        session
            .uid_mv(selector.clone(), to_path)
            .await
            .map_err(imap_error)?;
    } else {
        if !capabilities.has_str("UIDPLUS") {
            return Err(uidplus_required());
        }
        session
            .uid_copy(selector.clone(), to_path)
            .await
            .map_err(imap_error)?;
        store_flags_selector(session, &selector, "+FLAGS", &["\\Deleted"]).await?;
        expunge(session, &selector, ExpungeMode::Strict).await?;
    }
    for uid in uids {
        store.tombstone_uid(account_id, from_path, *uid);
    }
    store.delete_messages(account_id, from_path, uids)?;
    reconcile(session, store, account_id, to_path, None).await?;
    Ok(())
}

/// APPENDs a sent message to the Sent folder unless the server already holds
/// that `Message-ID` (some providers archive SMTP submissions themselves),
/// then reconciles so the copy is visible immediately.
pub async fn append_sent(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    raw: &[u8],
    message_id: Option<&str>,
) -> Result<(), MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    if let Some(id) = message_id {
        let existing = session
            .uid_search(format!("HEADER Message-ID \"<{id}>\""))
            .await
            .map_err(imap_error)?;
        if !existing.is_empty() {
            return Ok(());
        }
    }
    session
        .append(folder_path, Some("(\\Seen)"), None, raw)
        .await
        .map_err(imap_error)?;
    reconcile(session, store, account_id, folder_path, None).await?;
    Ok(())
}

/// APPENDs a draft to the Drafts folder with the `\Draft` flag, then reconciles
/// so the copy is visible immediately. Unlike a sent copy, a draft is not
/// deduplicated by Message-ID: saving again creates a new draft revision.
pub async fn append_draft(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    raw: &[u8],
) -> Result<(), MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    session
        .append(folder_path, Some("(\\Draft \\Seen)"), None, raw)
        .await
        .map_err(imap_error)?;
    reconcile(session, store, account_id, folder_path, None).await?;
    Ok(())
}

/// Pushes `\Answered` on the message the user replied to.
pub async fn mark_answered(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
) -> Result<(), MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    store_flags(session, uid, "+FLAGS", &["\\Answered"]).await
}

/// One message: a single uid through `delete_messages_many`.
pub async fn delete_message(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uid: u32,
) -> Result<(), MailError> {
    delete_messages_many(session, store, account_id, folder_path, &[uid]).await
}

/// Drops the messages from the server and from the store, one `UID STORE` and
/// one `UID EXPUNGE` for the whole selection. The store rows are dropped even
/// when they were already gone: the server is the source of truth and a missing
/// row must not turn a successful expunge into an error.
///
/// `UIDPLUS` is required and checked before `\Deleted` is set: without it the
/// only expunge available is folder-wide and would destroy every message
/// another client already flagged, so the call refuses and changes nothing.
pub async fn delete_messages_many(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uids: &[u32],
) -> Result<(), MailError> {
    if uids.is_empty() {
        return Ok(());
    }
    let selector = uid_selector(uids);
    session.select(folder_path).await.map_err(imap_error)?;
    if !supports_uidplus(session).await? {
        return Err(uidplus_required());
    }
    store_flags_selector(session, &selector, "+FLAGS", &["\\Deleted"]).await?;
    expunge(session, &selector, ExpungeMode::Strict).await?;
    for uid in uids {
        store.tombstone_uid(account_id, folder_path, *uid);
    }
    store.delete_messages(account_id, folder_path, uids)?;
    Ok(())
}

/// Empties a folder on the server and in the store, returning how many messages
/// the server reported expunged. Emptying the folder is precisely the intent, so
/// the folder-wide `EXPUNGE` fallback is used here; the local rows are cleared
/// without trusting the uids known locally, since a never-synced folder is
/// emptied on the server too. The uids the server lists are tombstoned before
/// the expunge, which covers the ones the store never saw.
pub async fn empty_folder(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
) -> Result<usize, MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    let uids = session.uid_search("ALL").await.map_err(imap_error)?;
    {
        let stored = session
            .uid_store("1:*", "+FLAGS (\\Deleted)")
            .await
            .map_err(imap_error)?;
        let mut stored = Box::pin(stored);
        while stored.try_next().await.map_err(imap_error)?.is_some() {}
    }
    for uid in uids {
        store.tombstone_uid(account_id, folder_path, uid);
    }
    let removed = expunge(session, "1:*", ExpungeMode::FolderWide).await?;
    store.clear_folder(account_id, folder_path)?;
    Ok(removed)
}

/// How far an expunge may reach. Without `UIDPLUS` the only expunge available
/// takes every `\Deleted` message of the folder, whoever flagged it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExpungeMode {
    Strict,
    FolderWide,
}

fn uidplus_required() -> MailError {
    MailError::Imap(
        "suppression définitive impossible : le serveur n'annonce pas UIDPLUS \
         (EXPUNGE emporterait les messages déjà marqués \\Deleted par un autre client)"
            .to_string(),
    )
}

async fn supports_uidplus(session: &mut ImapSession) -> Result<bool, MailError> {
    let capabilities = session.capabilities().await.map_err(imap_error)?;
    Ok(capabilities.has_str("UIDPLUS"))
}

/// Expunges and returns the number of `EXPUNGE` responses the server sent: that
/// count, not the local row count, is what the folder actually lost. `Strict`
/// refuses without `UIDPLUS`; `FolderWide` accepts the folder-wide `EXPUNGE`.
async fn expunge(
    session: &mut ImapSession,
    range: &str,
    mode: ExpungeMode,
) -> Result<usize, MailError> {
    if supports_uidplus(session).await? {
        let expunged = session.uid_expunge(range).await.map_err(imap_error)?;
        let mut expunged = Box::pin(expunged);
        let mut removed = 0;
        while expunged.try_next().await.map_err(imap_error)?.is_some() {
            removed += 1;
        }
        Ok(removed)
    } else if mode == ExpungeMode::Strict {
        Err(uidplus_required())
    } else {
        let expunged = session.expunge().await.map_err(imap_error)?;
        let mut expunged = Box::pin(expunged);
        let mut removed = 0;
        while expunged.try_next().await.map_err(imap_error)?.is_some() {
            removed += 1;
        }
        Ok(removed)
    }
}

async fn store_flags(
    session: &mut ImapSession,
    uid: u32,
    operation: &str,
    flags: &[&str],
) -> Result<(), MailError> {
    store_flags_selector(session, &uid.to_string(), operation, flags).await
}

async fn store_flags_selector(
    session: &mut ImapSession,
    selector: &str,
    operation: &str,
    flags: &[&str],
) -> Result<(), MailError> {
    if flags.is_empty() {
        return Ok(());
    }
    let query = format!("{operation} ({})", flags.join(" "));
    let updated = session
        .uid_store(selector, query)
        .await
        .map_err(imap_error)?;
    let mut updated = Box::pin(updated);
    while updated.try_next().await.map_err(imap_error)?.is_some() {}
    Ok(())
}

async fn tls_handshake(
    host: &str,
    tcp: TcpStream,
    options: &TlsOptions,
) -> Result<TlsStream<TcpStream>, MailError> {
    let mut roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    for certificate in options.extra_roots_der()? {
        roots
            .add(certificate.into())
            .map_err(|error| MailError::Tls(error.to_string()))?;
    }
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|_| MailError::Tls(format!("invalid imap hostname: {host}")))?;
    let peer = tcp
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "adresse inconnue".to_string());
    timeout(
        HANDSHAKE_TIMEOUT,
        TlsConnector::from(Arc::new(config)).connect(server_name, tcp),
    )
    .await
    .map_err(|_| MailError::Tls(format!("{host} ({peer}) : délai dépassé")))?
    .map_err(|error| MailError::Tls(format!("{host} ({peer}) : {error}")))
}

async fn read_greeting<T: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    client: &mut Client<T>,
) -> Result<(), MailError> {
    match client.read_response().await {
        Some(Ok(_)) => Ok(()),
        Some(Err(error)) => Err(MailError::Imap(error.to_string())),
        None => Err(MailError::Imap(
            "server closed the connection before greeting".to_string(),
        )),
    }
}

fn flags_of(fetch: &Fetch) -> Flags {
    Flags {
        unread: !fetch.flags().any(|flag| matches!(flag, Flag::Seen)),
        starred: fetch.flags().any(|flag| matches!(flag, Flag::Flagged)),
        answered: fetch.flags().any(|flag| matches!(flag, Flag::Answered)),
    }
}

fn already_exists(error: &async_imap::error::Error) -> bool {
    error.to_string().to_ascii_lowercase().contains("exist")
}

fn already_gone(error: &async_imap::error::Error) -> bool {
    match error {
        async_imap::error::Error::No(text) => {
            let text = text.to_ascii_lowercase();
            text.contains("exist") || text.contains("not found") || text.contains("no such")
        }
        _ => false,
    }
}

fn uidvalidity_of(
    mailbox: &async_imap::types::Mailbox,
    account_id: &str,
) -> Result<u32, MailError> {
    mailbox
        .uid_validity
        .ok_or_else(|| MailError::Imap(format!("{account_id}: server does not expose UIDVALIDITY")))
}

fn uidnext_of(mailbox: &async_imap::types::Mailbox, account_id: &str) -> Result<u32, MailError> {
    mailbox
        .uid_next
        .ok_or_else(|| MailError::Imap(format!("{account_id}: server does not expose UIDNEXT")))
}

fn mapped_role(mapping: &FolderMapping, folder_path: &str) -> Option<FolderRole> {
    [
        FolderRole::Inbox,
        FolderRole::Sent,
        FolderRole::Drafts,
        FolderRole::Archive,
        FolderRole::Trash,
        FolderRole::Spam,
    ]
    .into_iter()
    .find(|role| config::path_for(mapping, *role) == Some(folder_path))
}

fn attribute_label<'a>(attribute: &'a NameAttribute<'a>) -> &'a str {
    match attribute {
        NameAttribute::NoInferiors => "noinferiors",
        NameAttribute::NoSelect => "noselect",
        NameAttribute::Marked => "marked",
        NameAttribute::Unmarked => "unmarked",
        NameAttribute::All => "all",
        NameAttribute::Archive => "archive",
        NameAttribute::Drafts => "drafts",
        NameAttribute::Flagged => "flagged",
        NameAttribute::Junk => "junk",
        NameAttribute::Sent => "sent",
        NameAttribute::Trash => "trash",
        NameAttribute::Extension(name) => name.as_ref(),
        _ => "unknown",
    }
}

fn imap_error(error: async_imap::error::Error) -> MailError {
    MailError::Imap(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_imap::Authenticator;

    fn unread() -> Flags {
        Flags {
            unread: true,
            starred: false,
            answered: false,
        }
    }

    fn read_starred() -> Flags {
        Flags {
            unread: false,
            starred: true,
            answered: false,
        }
    }

    fn local(uids: &[(u32, Flags)]) -> HashMap<u32, Flags> {
        uids.iter().copied().collect()
    }

    fn touched(uids: &[(u32, Flags)]) -> HashMap<u32, (Flags, u32)> {
        uids.iter()
            .map(|(uid, flags)| (*uid, (*flags, 10)))
            .collect()
    }

    #[test]
    fn plain_payload_is_authzid_authcid_password() {
        let mut auth = PlainAuthenticator::new("user@example.org", "p^ss");
        assert_eq!(auth.process(&[]), b"\0user@example.org\0p^ss".to_vec());
    }

    #[test]
    fn an_unchanged_mailbox_writes_nothing() {
        let plan = diff_since(&local(&[(1, unread()), (2, unread())]), &touched(&[]), 2);
        assert_eq!(plan, Some(IncrementalPlan::default()));
    }

    #[test]
    fn a_new_uid_is_a_body_to_pull() {
        let plan = diff_since(
            &local(&[(1, unread()), (2, unread())]),
            &touched(&[(3, unread())]),
            3,
        );
        assert_eq!(
            plan,
            Some(IncrementalPlan {
                new_uids: vec![3],
                changed: Vec::new(),
            })
        );
    }

    /// Les plus récents passent en premier : le premier lot est celui qui
    /// reçoit un aperçu, et le plus ancien n'arrive qu'après.
    #[test]
    fn new_uids_are_imported_newest_first() {
        let plan = diff_since(
            &local(&[(1, unread())]),
            &touched(&[(2, unread()), (3, unread()), (4, unread())]),
            4,
        );
        assert_eq!(plan.expect("plan").new_uids, vec![4, 3, 2]);
    }

    #[test]
    fn a_known_uid_with_other_flags_is_an_update() {
        let plan = diff_since(
            &local(&[(1, unread()), (2, unread())]),
            &touched(&[(2, read_starred())]),
            2,
        );
        assert_eq!(
            plan,
            Some(IncrementalPlan {
                new_uids: Vec::new(),
                changed: vec![(2, read_starred())],
            })
        );
    }

    #[test]
    fn a_known_uid_with_the_same_flags_is_dropped() {
        let plan = diff_since(
            &local(&[(1, unread()), (2, read_starred())]),
            &touched(&[(2, read_starred())]),
            2,
        );
        assert_eq!(plan, Some(IncrementalPlan::default()));
    }

    /// `CHANGEDSINCE` never reports an expunge: the count is what says a message
    /// vanished, and a vanished message forces the full pass.
    #[test]
    fn a_vanished_message_forces_the_full_pass() {
        assert_eq!(
            diff_since(&local(&[(1, unread()), (2, unread())]), &touched(&[]), 1),
            None
        );
    }

    /// The dangerous case: one message vanished and another arrived, so the
    /// server still answers as many messages as the store holds.
    #[test]
    fn a_vanished_message_hidden_by_a_new_one_forces_the_full_pass() {
        assert_eq!(
            diff_since(
                &local(&[(1, unread()), (2, unread())]),
                &touched(&[(3, unread())]),
                2
            ),
            None
        );
    }

    #[test]
    fn a_mailbox_that_grew_behind_the_baseline_forces_the_full_pass() {
        assert_eq!(diff_since(&local(&[(1, unread())]), &touched(&[]), 2), None);
    }

    #[test]
    fn the_incremental_fetch_carries_the_modseq_as_a_modifier() {
        assert_eq!(
            changes_since_query(90060115205545359),
            "(UID FLAGS RFC822.SIZE) (CHANGEDSINCE 90060115205545359)"
        );
    }

    #[test]
    fn a_missing_or_stale_baseline_never_resumes() {
        let folder = Folder {
            account_id: "perso".to_string(),
            path: "INBOX".to_string(),
            name: "INBOX".to_string(),
            role: FolderRole::Inbox,
            uidvalidity: 7,
            uidnext: 10,
            last_sync_at: None,
            modseq: Some(9),
            delimiter: None,
        };
        assert_eq!(resumable_modseq(None, false), None);
        assert_eq!(resumable_modseq(Some(&folder), true), None);
        assert_eq!(resumable_modseq(Some(&folder), false), Some(9));
    }

    #[test]
    fn a_search_query_escapes_the_quoted_string() {
        assert_eq!(escape_search("facture"), "facture");
        assert_eq!(escape_search("a\"b"), "a\\\"b");
        assert_eq!(escape_search("a\\b"), "a\\\\b");
        assert_eq!(escape_search("ligne\nsuivante"), "ligne suivante");
        assert_eq!(escape_search("héllo"), "héllo");
    }

    #[test]
    fn search_uids_come_back_newest_first() {
        assert_eq!(descending([3, 1, 7].into_iter().collect()), vec![7, 3, 1]);
    }

    #[test]
    fn a_bulk_selector_carries_every_uid() {
        assert_eq!(uid_selector(&[4, 7, 9]), "4,7,9");
        assert_eq!(uid_selector(&[7]), "7");
    }

    #[test]
    fn reading_a_starred_message_adds_both_flags() {
        let (add, remove) = flag_changes(&read_starred());
        assert_eq!(add, vec!["\\Seen", "\\Flagged"]);
        assert!(remove.is_empty(), "{remove:?}");
    }

    #[test]
    fn an_unread_unstarred_message_removes_both_flags() {
        let (add, remove) = flag_changes(&unread());
        assert!(add.is_empty(), "{add:?}");
        assert_eq!(remove, vec!["\\Seen", "\\Flagged"]);
    }

    #[test]
    fn one_flag_moves_in_one_direction_only() {
        let (add, remove) = flag_changes(&Flags {
            unread: true,
            starred: true,
            answered: true,
        });
        assert_eq!(add, vec!["\\Flagged"]);
        assert_eq!(remove, vec!["\\Seen"]);
    }

    #[test]
    fn a_folder_label_decodes_the_leaf_of_its_path() {
        assert_eq!(folder_label("INBOX"), "INBOX");
        assert_eq!(folder_label("&2Dzf5g-"), "🏦");
        assert_eq!(folder_label("[Gmail]/&2Dzf5g- perso"), "🏦 perso");
        assert_eq!(folder_label("Projets/&2Dzf5g-"), "🏦");
    }

    #[test]
    fn a_decoded_label_still_gives_the_folder_its_role() {
        let decoded = folder_label("[Gmail]/&2Dzf5g-");
        assert_eq!(
            config::folder_role("[Gmail]/&2Dzf5g-", &decoded, &[]),
            FolderRole::Other
        );
        let flags: Vec<String> = vec!["\\Trash".to_string()];
        assert_eq!(
            config::folder_role("[Gmail]/&2Dzf5g-", &decoded, &flags),
            FolderRole::Trash
        );
    }
}
