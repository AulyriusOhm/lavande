//! IMAP transport: TLS (implicit or STARTTLS), folder listing and folder sync.
//!
//! Every network operation takes an already authenticated session: the caller
//! opens and closes it, there is no pool and no automatic reconnection.

use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

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
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use crate::config::{self, AccountConfig, AuthConfig, Encryption, FolderMapping};
use crate::error::MailError;
use crate::mime;
use crate::model::{Flags, Folder, FolderRole, Message};
use crate::oauth::{xoauth2_payload, OAuth2Provider, XOAuth2Authenticator};
use crate::store::Store;
use crate::threading;
use crate::tls::TlsOptions;

pub type ImapSession = Session<TlsStream<TcpStream>>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub inserted: usize,
    pub flags_updated: usize,
    pub removed: usize,
    pub uidvalidity_changed: bool,
    pub uidnext: u32,
}

const BODY_BATCH: usize = 500;

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
    let tcp = TcpStream::connect((cfg.imap.host.as_str(), cfg.imap.port))
        .await
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
        AuthConfig::Password { password } => client
            .login(&cfg.username, password)
            .await
            .map_err(|(error, _)| MailError::Auth(error.to_string())),
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
        let label = config::leaf_name(&path).to_string();
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
        });
    }
    Ok(folders)
}

/// Syncs one folder against the server state.
pub async fn sync_folder(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    mapping: &FolderMapping,
) -> Result<SyncReport, MailError> {
    reconcile(session, store, account_id, folder_path, Some(mapping)).await
}

/// Brings one folder in step with the server: one metadata pass decides what
/// vanished, what changed flags and what is new; bodies are then pulled for the
/// new uids only, in batches. `mapping` only names the role of a folder the
/// store has never seen.
async fn reconcile(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    mapping: Option<&FolderMapping>,
) -> Result<SyncReport, MailError> {
    let mailbox = session.select(folder_path).await.map_err(imap_error)?;
    let uidvalidity = uidvalidity_of(&mailbox, account_id)?;
    let uidnext = uidnext_of(&mailbox, account_id)?;

    let stored = store.get_folder(account_id, folder_path)?;
    let uidvalidity_changed = stored
        .as_ref()
        .is_some_and(|folder| folder.uidvalidity != uidvalidity);
    if uidvalidity_changed {
        store.clear_folder(account_id, folder_path)?;
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
    new_uids.sort_unstable();

    let mut report = SyncReport {
        uidvalidity_changed,
        uidnext,
        removed: store.delete_messages(account_id, folder_path, &vanished)?,
        flags_updated: store.set_flags_batch(account_id, folder_path, &changed)?,
        ..SyncReport::default()
    };

    for batch in new_uids.chunks(BODY_BATCH) {
        report.inserted += import_bodies(
            session,
            store,
            account_id,
            folder_path,
            uidvalidity,
            batch,
            &server,
        )
        .await?;
    }

    let role = stored
        .as_ref()
        .map(|folder| folder.role)
        .filter(|role| *role != FolderRole::Other)
        .or_else(|| mapping.and_then(|mapping| mapped_role(mapping, folder_path)))
        .unwrap_or(FolderRole::Other);
    store.upsert_folder(&Folder {
        account_id: account_id.to_string(),
        path: folder_path.to_string(),
        name: config::leaf_name(folder_path).to_string(),
        role,
        uidvalidity,
        uidnext,
        last_sync_at: Some(Utc::now()),
    })?;
    Ok(report)
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
    Ok(fetches
        .iter()
        .filter_map(|fetch| {
            Some((
                fetch.uid?,
                (flags_of(fetch), fetch.size.unwrap_or_default()),
            ))
        })
        .collect())
}

/// Reads and stores the bodies of `uids` only. A uid the server answers
/// without a body is skipped, not fatal.
async fn import_bodies(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uidvalidity: u32,
    uids: &[u32],
    server: &HashMap<u32, (Flags, u32)>,
) -> Result<usize, MailError> {
    let selector = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let fetches: Vec<Fetch> = session
        .uid_fetch(selector, "(UID BODY.PEEK[])")
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;

    let mut inserted = 0;
    for fetch in fetches {
        let (Some(uid), Some(raw)) = (fetch.uid, fetch.body()) else {
            continue;
        };
        let Some((flags, size)) = server.get(&uid) else {
            continue;
        };
        let parsed = mime::parse_message(raw)?;
        let message = Message {
            account_id: account_id.to_string(),
            folder_path: folder_path.to_string(),
            uid,
            uidvalidity,
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
            flags: *flags,
            size: *size,
            pgp: parsed.pgp,
            preview: parsed.preview,
            body_text: parsed.body_text,
            body_html: parsed.body_html,
            attachments: parsed.attachments,
        };
        store.upsert_message(&message)?;
        if let Some(message_id) = &message.message_id {
            store.relink_replies(account_id, message_id, &message.thread_id)?;
        }
        inserted += 1;
    }
    Ok(inserted)
}

/// Re-reads one message body and stores it.
pub async fn fetch_body(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uid: u32,
) -> Result<(), MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    let fetches: Vec<Fetch> = session
        .uid_fetch(uid.to_string(), "(BODY.PEEK[])")
        .await
        .map_err(imap_error)?
        .try_collect()
        .await
        .map_err(imap_error)?;
    let raw = fetches
        .iter()
        .find_map(|fetch| fetch.body())
        .ok_or_else(|| MailError::Imap(format!("uid {uid} carries no body")))?;
    let parsed = mime::parse_message(raw)?;
    store.set_body(
        account_id,
        folder_path,
        uid,
        parsed.body_text.as_deref(),
        parsed.body_html.as_deref(),
    )
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

/// Pushes `\Seen` and `\Flagged`; `\Answered` is read from the server but
/// never written.
pub async fn set_flags(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
    flags: &Flags,
) -> Result<(), MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
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
    store_flags(session, uid, "+FLAGS", &add).await?;
    store_flags(session, uid, "-FLAGS", &remove).await
}

/// `UID MOVE` when the server has the capability, `UID COPY` + `\Deleted` +
/// `UID EXPUNGE` otherwise; the fallback needs `UIDPLUS` and is refused before
/// the copy when the server does not announce it. The source row is dropped,
/// then the destination is reconciled so it carries the uid the server actually
/// gave the message.
pub async fn move_message(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    from_path: &str,
    uid: u32,
    to_path: &str,
) -> Result<(), MailError> {
    session.select(from_path).await.map_err(imap_error)?;
    let capabilities = session.capabilities().await.map_err(imap_error)?;
    if capabilities.has_str("MOVE") {
        session
            .uid_mv(uid.to_string(), to_path)
            .await
            .map_err(imap_error)?;
    } else {
        if !capabilities.has_str("UIDPLUS") {
            return Err(uidplus_required());
        }
        session
            .uid_copy(uid.to_string(), to_path)
            .await
            .map_err(imap_error)?;
        store_flags(session, uid, "+FLAGS", &["\\Deleted"]).await?;
        expunge(session, &uid.to_string(), ExpungeMode::Strict).await?;
    }
    store.delete_message(account_id, from_path, uid)?;
    reconcile(session, store, account_id, to_path, None).await?;
    Ok(())
}

/// Drops the message from the server and from the store. The store row is
/// dropped even when it was already gone: the server is the source of truth and
/// a missing row must not turn a successful expunge into an error.
///
/// `UIDPLUS` is required and checked before `\Deleted` is set: without it the
/// only expunge available is folder-wide and would destroy every message
/// another client already flagged, so the call refuses and changes nothing.
pub async fn delete_message(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
    uid: u32,
) -> Result<(), MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    if !supports_uidplus(session).await? {
        return Err(uidplus_required());
    }
    store_flags(session, uid, "+FLAGS", &["\\Deleted"]).await?;
    expunge(session, &uid.to_string(), ExpungeMode::Strict).await?;
    store.delete_messages(account_id, folder_path, &[uid])?;
    Ok(())
}

/// Empties a folder on the server and in the store, returning how many messages
/// the server reported expunged. Emptying the folder is precisely the intent, so
/// the folder-wide `EXPUNGE` fallback is used here; the local rows are cleared
/// without trusting the uids known locally, since a never-synced folder is
/// emptied on the server too.
pub async fn empty_folder(
    session: &mut ImapSession,
    store: &Store,
    account_id: &str,
    folder_path: &str,
) -> Result<usize, MailError> {
    session.select(folder_path).await.map_err(imap_error)?;
    {
        let stored = session
            .uid_store("1:*", "+FLAGS (\\Deleted)")
            .await
            .map_err(imap_error)?;
        let mut stored = Box::pin(stored);
        while stored.try_next().await.map_err(imap_error)?.is_some() {}
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
    if flags.is_empty() {
        return Ok(());
    }
    let query = format!("{operation} ({})", flags.join(" "));
    let updated = session
        .uid_store(uid.to_string(), query)
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
    TlsConnector::from(Arc::new(config))
        .connect(server_name, tcp)
        .await
        .map_err(|error| MailError::Tls(error.to_string()))
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
