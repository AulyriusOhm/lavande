//! Live network tests against the GreenMail container started by
//! `scripts/mail-test-server.sh`.
//!
//! Ignored by default so a plain `cargo test` stays offline. Run them with:
//!
//! ```sh
//! scripts/mail-test-server.sh start
//! MAIL_TEST_TLS_DIR=$HOME/.cache/lavande/mail-test \
//!   cargo test -p lavande-mail --test live -- --ignored --test-threads=1
//! scripts/mail-test-server.sh stop
//! ```
//!
//! `--test-threads=1` is mandatory: every scenario reads and writes the same
//! INBOX, and each one prefixes its subjects with `[live-<name>]` so it only
//! looks at the messages it sent itself.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::TryStreamExt;
use lavande_mail::config::{AccountConfig, AuthConfig, Encryption, Endpoint, FolderMapping};
use lavande_mail::imap::{self, ImapSession};
use lavande_mail::model::{Address, Flags, FolderRole, Message, PgpState};
use lavande_mail::pgp::{self, PgpKeyring};
use lavande_mail::smtp::{self, OutgoingMessage};
use lavande_mail::tls::TlsOptions;
use lavande_mail::{MailError, Store};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ACCOUNT: &str = "live";
const INBOX: &str = "INBOX";

fn env_or(variable: &str, default: &str) -> String {
    env::var(variable).unwrap_or_else(|_| default.to_string())
}

fn tls_dir() -> PathBuf {
    match env::var("MAIL_TEST_TLS_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => PathBuf::from(env::var("HOME").expect(
            "neither MAIL_TEST_TLS_DIR nor HOME is set: point MAIL_TEST_TLS_DIR at the server certificate",
        ))
        .join(".cache/lavande/mail-test"),
    }
}

fn tls_options() -> TlsOptions {
    let path = tls_dir().join("cert.pem");
    let pem = fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read the test certificate {}: {error}",
            path.display()
        )
    });
    TlsOptions {
        extra_roots_pem: vec![pem],
    }
}

fn endpoint(variable: &str, default: &str) -> Endpoint {
    let value = env_or(variable, default);
    let (host, port) = value
        .rsplit_once(':')
        .unwrap_or_else(|| panic!("{variable} must be written host:port, got {value}"));
    Endpoint {
        host: host.to_string(),
        port: port
            .parse()
            .unwrap_or_else(|_| panic!("{variable} carries no valid port: {value}")),
        encryption: Encryption::Tls,
    }
}

fn account() -> AccountConfig {
    AccountConfig {
        id: ACCOUNT.to_string(),
        label: "GreenMail".to_string(),
        email: env_or("MAIL_TEST_USER", "roman@lavande.test"),
        username: env_or("MAIL_TEST_USER", "roman@lavande.test"),
        imap: endpoint("MAIL_TEST_IMAP", "localhost:3993"),
        smtp: endpoint("MAIL_TEST_SMTP", "localhost:3465"),
        synced_folders: None,
        auth: AuthConfig::Password {
            password: env_or("MAIL_TEST_PASSWORD", "secret"),
        },
    }
}

fn checked<T>(what: &str, result: Result<T, MailError>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{what}: {error}"),
    }
}

fn store(cfg: &AccountConfig) -> Store {
    let store = checked("open the store", Store::open_in_memory());
    checked("migrate the store", store.migrate());
    checked(
        "store the account",
        store.upsert_account(ACCOUNT, "GreenMail", &cfg.email),
    );
    store
}

async fn connect(cfg: &AccountConfig) -> ImapSession {
    checked(
        "imap connect",
        imap::connect_with(cfg, &tls_options()).await,
    )
}

async fn sync(cfg: &AccountConfig, store: &Store, folder: &str) -> imap::SyncReport {
    let mut session = connect(cfg).await;
    checked(
        &format!("sync {folder}"),
        imap::sync_folder(
            &mut session,
            store,
            ACCOUNT,
            folder,
            &FolderMapping::default(),
        )
        .await,
    )
}

async fn send(cfg: &AccountConfig, subject: &str, body: &str, reply_to: Option<&str>) {
    let message = OutgoingMessage {
        from: Address {
            name: Some("Live".to_string()),
            email: cfg.email.clone(),
        },
        to: vec![Address {
            name: None,
            email: cfg.email.clone(),
        }],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: subject.to_string(),
        text: body.to_string(),
        html: None,
        in_reply_to: reply_to.map(str::to_string),
        references: reply_to.map(|id| vec![id.to_string()]).unwrap_or_default(),
        attachments: Vec::new(),
        pgp_sign: false,
        pgp_encrypt: false,
    };
    checked(
        "smtp send",
        smtp::send_with(cfg, &message, &tls_options()).await,
    );
}

/// The single message whose subject is exactly `subject`; the nanosecond
/// suffix keeps it unique on a shared INBOX.
fn find(store: &Store, folder: &str, subject: &str) -> Message {
    let messages = checked(
        &format!("read {folder} from the store"),
        store.messages_in_folder(ACCOUNT, folder, -1, 0),
    );
    messages
        .into_iter()
        .find(|message| message.subject == subject)
        .unwrap_or_else(|| panic!("{folder} does not hold the message '{subject}'"))
}

fn unique(name: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is before 1970")
        .as_nanos();
    format!("{name} {nanos}")
}

async fn select(session: &mut ImapSession, folder: &str) {
    session
        .select(folder)
        .await
        .unwrap_or_else(|error| panic!("select {folder}: {error}"));
}

async fn uid_store(session: &mut ImapSession, uid: u32, query: &str) {
    let stored = session
        .uid_store(uid.to_string(), query)
        .await
        .unwrap_or_else(|error| panic!("uid store {query} on {uid}: {error}"));
    let mut stored = Box::pin(stored);
    while stored
        .try_next()
        .await
        .unwrap_or_else(|error| panic!("uid store {query} on {uid}: {error}"))
        .is_some()
    {}
}

async fn uid_expunge(session: &mut ImapSession, uid: u32) {
    let expunged = session
        .uid_expunge(uid.to_string())
        .await
        .unwrap_or_else(|error| panic!("uid expunge {uid}: {error}"));
    let mut expunged = Box::pin(expunged);
    while expunged
        .try_next()
        .await
        .unwrap_or_else(|error| panic!("uid expunge {uid}: {error}"))
        .is_some()
    {}
}

/// Every uid of the currently selected folder, as the server sees them.
async fn server_uids(session: &mut ImapSession) -> Vec<u32> {
    let fetches = session
        .uid_fetch("1:*", "(UID)")
        .await
        .unwrap_or_else(|error| panic!("fetch uids: {error}"))
        .try_collect::<Vec<_>>()
        .await
        .unwrap_or_else(|error| panic!("fetch uids: {error}"));
    fetches.iter().filter_map(|fetch| fetch.uid).collect()
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn implicit_tls_lists_inbox_with_role() {
    let cfg = account();
    let mut session = connect(&cfg).await;
    let folders = checked(
        "list folders",
        imap::list_folders(&mut session, ACCOUNT).await,
    );
    let inbox = folders
        .iter()
        .find(|folder| folder.path.eq_ignore_ascii_case(INBOX))
        .unwrap_or_else(|| {
            panic!(
                "no INBOX among {:?}",
                folders
                    .iter()
                    .map(|folder| &folder.path)
                    .collect::<Vec<_>>()
            )
        });
    assert_eq!(inbox.role, FolderRole::Inbox);
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn smtp_send_then_sync_parses_message() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-sync] parcours");
    send(&cfg, &subject, "corps du message", None).await;

    let mut session = connect(&cfg).await;
    let report = checked(
        "first sync",
        imap::sync_folder(
            &mut session,
            &store,
            ACCOUNT,
            INBOX,
            &FolderMapping::default(),
        )
        .await,
    );
    assert!(
        report.inserted >= 1,
        "first sync inserted {}",
        report.inserted
    );

    let message = find(&store, INBOX, &subject);
    assert_eq!(message.from.email, cfg.email);
    assert!(message.flags.unread);
    assert!(!message.preview.is_empty());
    assert!(!message.thread_id.is_empty());

    let report = checked(
        "second sync",
        imap::sync_folder(
            &mut session,
            &store,
            ACCOUNT,
            INBOX,
            &FolderMapping::default(),
        )
        .await,
    );
    assert_eq!(report.inserted, 0);
    assert_eq!(report.flags_updated, 0);
    assert_eq!(report.removed, 0);
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn a_pgp_message_comes_back_decrypted_and_verified() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-pgp] scelle");
    let key = pgp::generate_key("Live", &cfg.email).expect("keygen");
    let secret = key
        .secret()
        .expect("secret half")
        .to_armored_string(Default::default())
        .expect("armor");

    let message = OutgoingMessage {
        from: Address {
            name: Some("Live".to_string()),
            email: cfg.email.clone(),
        },
        to: vec![Address {
            name: None,
            email: cfg.email.clone(),
        }],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: subject.clone(),
        text: "corps chiffre".to_string(),
        html: None,
        in_reply_to: None,
        references: Vec::new(),
        attachments: Vec::new(),
        pgp_sign: true,
        pgp_encrypt: true,
    };
    let sealed = pgp::mime::seal(&message, key.secret(), &[key.public()]).expect("seal");
    checked(
        "smtp send sealed",
        smtp::send_raw_with(&cfg, &sealed.raw, &sealed.envelope, &tls_options()).await,
    );

    let mut keyring = PgpKeyring::new();
    keyring.insert_armored(&secret).expect("import secret");
    let mut session = connect(&cfg).await;
    checked(
        "sync sealed",
        imap::sync_folder(
            &mut session,
            &store,
            ACCOUNT,
            INBOX,
            &FolderMapping::default(),
        )
        .await,
    );

    let stored = find(&store, INBOX, &subject);
    assert_eq!(stored.pgp, PgpState::Encrypted);
    assert!(
        stored.body_text.is_none(),
        "corps non téléchargé par la synchro"
    );
    checked(
        "fetch sealed body",
        imap::fetch_body(&mut session, &store, ACCOUNT, INBOX, stored.uid, &keyring).await,
    );

    let stored = find(&store, INBOX, &subject);
    assert_eq!(stored.body_text.as_deref(), Some("corps chiffre"));
    let detail = stored.pgp_detail.expect("pgp detail");
    assert!(detail.decrypted, "{detail:?}");
    assert_eq!(detail.verified, Some(true), "{detail:?}");
    assert_eq!(detail.signer.as_deref(), Some(key.info().user_id.as_str()));
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn flags_reach_the_server() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-flags] etoile");
    send(&cfg, &subject, "corps des drapeaux", None).await;

    let mut session = connect(&cfg).await;
    checked(
        "sync",
        imap::sync_folder(
            &mut session,
            &store,
            ACCOUNT,
            INBOX,
            &FolderMapping::default(),
        )
        .await,
    );
    let uid = find(&store, INBOX, &subject).uid;

    checked(
        "set flags",
        imap::set_flags(
            &mut session,
            INBOX,
            uid,
            &Flags {
                unread: false,
                starred: true,
                answered: false,
            },
        )
        .await,
    );

    let mut fresh = connect(&cfg).await;
    let flags = checked(
        "fetch flags",
        imap::fetch_flags(&mut fresh, INBOX, uid).await,
    );
    assert!(!flags.unread, "the message is still unread on the server");
    assert!(flags.starred, "the message is not flagged on the server");

    checked(
        "unstar",
        imap::set_flags(
            &mut fresh,
            INBOX,
            uid,
            &Flags {
                unread: false,
                starred: false,
                answered: false,
            },
        )
        .await,
    );
    let flags = checked(
        "fetch flags",
        imap::fetch_flags(&mut fresh, INBOX, uid).await,
    );
    assert!(!flags.unread);
    assert!(!flags.starred, "the star survived an unstar");
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn expunged_message_disappears_locally() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-expunge] suppression");
    send(&cfg, &subject, "corps supprime", None).await;
    sync(&cfg, &store, INBOX).await;
    let uid = find(&store, INBOX, &subject).uid;

    let mut raw = connect(&cfg).await;
    select(&mut raw, INBOX).await;
    uid_store(&mut raw, uid, "+FLAGS (\\Deleted)").await;
    uid_expunge(&mut raw, uid).await;

    let report = sync(&cfg, &store, INBOX).await;
    assert!(report.removed >= 1, "removed {}", report.removed);
    assert!(
        checked("inbox lookup", store.get_message(ACCOUNT, INBOX, uid)).is_none(),
        "uid {uid} survived the server expunge"
    );
    let inbox = checked(
        "inbox listing",
        store.messages_in_folder(ACCOUNT, INBOX, -1, 0),
    );
    assert!(
        inbox.iter().all(|message| message.subject != subject),
        "'{subject}' is still in the local INBOX"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn delete_reaches_the_server() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-delete] suppression definitive");
    send(&cfg, &subject, "corps supprime", None).await;
    sync(&cfg, &store, INBOX).await;
    let uid = find(&store, INBOX, &subject).uid;

    let mut session = connect(&cfg).await;
    checked(
        "delete",
        imap::delete_message(&mut session, &store, ACCOUNT, INBOX, uid).await,
    );
    assert!(
        checked("inbox lookup", store.get_message(ACCOUNT, INBOX, uid)).is_none(),
        "uid {uid} survived the local delete"
    );
    let inbox = checked(
        "inbox listing",
        store.messages_in_folder(ACCOUNT, INBOX, -1, 0),
    );
    assert!(
        inbox.iter().all(|message| message.subject != subject),
        "'{subject}' is still in the local INBOX"
    );

    let mut raw = connect(&cfg).await;
    select(&mut raw, INBOX).await;
    let server = server_uids(&mut raw).await;
    assert!(
        !server.contains(&uid),
        "the server still exposes uid {uid}: {server:?}"
    );

    checked(
        "delete again",
        imap::delete_message(&mut session, &store, ACCOUNT, INBOX, uid).await,
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn empty_folder_clears_both_sides() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-purge] dossier vide");
    send(&cfg, &subject, "corps purge", None).await;

    let mut session = connect(&cfg).await;
    checked(
        "create Purge",
        imap::create_folder(&mut session, "Purge").await,
    );
    checked(
        "sync",
        imap::sync_folder(
            &mut session,
            &store,
            ACCOUNT,
            INBOX,
            &FolderMapping::default(),
        )
        .await,
    );
    let uid = find(&store, INBOX, &subject).uid;
    checked(
        "move to Purge",
        imap::move_message(&mut session, &store, ACCOUNT, INBOX, uid, "Purge").await,
    );

    let removed = checked(
        "empty Purge",
        imap::empty_folder(&mut session, &store, ACCOUNT, "Purge").await,
    );
    assert!(removed >= 1, "removed {removed}");
    let left = checked(
        "purge listing",
        store.messages_in_folder(ACCOUNT, "Purge", -1, 0),
    );
    assert!(left.is_empty(), "the local Purge still holds {left:?}");

    let mut raw = connect(&cfg).await;
    select(&mut raw, "Purge").await;
    let server = server_uids(&mut raw).await;
    assert!(
        server.is_empty(),
        "the server still exposes {server:?} in Purge"
    );
}

/// A folder the store has never seen is still emptied on the server, so
/// `removed` has to come from the server's `EXPUNGE` responses: a store-driven
/// count reports 0 there and the ui would claim the folder was already empty.
#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn empty_folder_counts_a_never_synced_folder() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-purge-unsynced] dossier jamais synchronise");
    let folder = unique("Purge-unsynced").replace(' ', "-");
    send(&cfg, &subject, "corps purge", None).await;

    let mut session = connect(&cfg).await;
    checked(
        "create the unsynced folder",
        imap::create_folder(&mut session, &folder).await,
    );
    checked(
        "sync inbox",
        imap::sync_folder(
            &mut session,
            &store,
            ACCOUNT,
            INBOX,
            &FolderMapping::default(),
        )
        .await,
    );
    let uid = find(&store, INBOX, &subject).uid;

    select(&mut session, INBOX).await;
    session
        .uid_copy(uid.to_string(), &folder)
        .await
        .unwrap_or_else(|error| panic!("uid copy {uid} to {folder}: {error}"));
    let local = checked(
        "unsynced listing",
        store.messages_in_folder(ACCOUNT, &folder, -1, 0),
    );
    assert!(
        local.is_empty(),
        "'{folder}' must stay unsynced, the store already holds {local:?}"
    );

    let removed = checked(
        "empty the unsynced folder",
        imap::empty_folder(&mut session, &store, ACCOUNT, &folder).await,
    );
    assert!(
        removed >= 1,
        "the server held one message but the purge counted {removed}"
    );

    let left = checked(
        "purge listing",
        store.messages_in_folder(ACCOUNT, &folder, -1, 0),
    );
    assert!(left.is_empty(), "the local '{folder}' still holds {left:?}");

    select(&mut session, &folder).await;
    let server = server_uids(&mut session).await;
    assert!(
        server.is_empty(),
        "the server still exposes {server:?} in '{folder}'"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn flags_from_another_client_are_pulled() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-other-client] drapeaux");
    send(&cfg, &subject, "corps distant", None).await;
    sync(&cfg, &store, INBOX).await;
    let uid = find(&store, INBOX, &subject).uid;
    assert!(
        find(&store, INBOX, &subject).flags.unread,
        "the fresh message is already read locally"
    );

    let mut raw = connect(&cfg).await;
    select(&mut raw, INBOX).await;
    uid_store(&mut raw, uid, "+FLAGS (\\Seen \\Flagged)").await;

    let report = sync(&cfg, &store, INBOX).await;
    assert!(
        report.flags_updated >= 1,
        "flags_updated {}",
        report.flags_updated
    );
    let stored = checked("inbox lookup", store.get_message(ACCOUNT, INBOX, uid))
        .unwrap_or_else(|| panic!("uid {uid} vanished"));
    assert!(!stored.flags.unread, "the local copy stayed unread");
    assert!(stored.flags.starred, "the local copy lost the star");
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn unchanged_folder_reports_nothing() {
    let cfg = account();
    let store = store(&cfg);
    sync(&cfg, &store, INBOX).await;

    let report = sync(&cfg, &store, INBOX).await;
    assert_eq!(report.inserted, 0, "{report:?}");
    assert_eq!(report.flags_updated, 0, "{report:?}");
    assert_eq!(report.removed, 0, "{report:?}");
    assert!(!report.uidvalidity_changed, "{report:?}");
}

/// GreenMail 2.1.15 advertises `IMAP4rev1 LITERAL+ UIDPLUS SORT IDLE MOVE
/// SASL-IR AUTH=XOAUTH2 QUOTA`: no CONDSTORE, so every sync here takes the full
/// pass. This pins the fallback: the probe says no, `ENABLE CONDSTORE` is a
/// no-op, and the full pass keeps seeing new messages, other clients' flags and
/// expunges. The `CHANGEDSINCE` path itself cannot be exercised against this
/// server — it needs a CONDSTORE server (Dovecot, Gmail, ...).
#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn a_server_without_condstore_keeps_the_full_pass() {
    let cfg = account();
    let store = store(&cfg);

    let mut session = connect(&cfg).await;
    assert!(
        !checked(
            "capability probe",
            imap::supports_condstore(&mut session).await
        ),
        "this server advertises CONDSTORE: the fallback scenario no longer applies"
    );
    imap::enable_condstore(&mut session).await;

    let subject = unique("[live-fallback] repli complet");
    send(&cfg, &subject, "corps repli", None).await;
    let first = sync(&cfg, &store, INBOX).await;
    assert!(first.inserted >= 1, "{first:?}");
    let folder =
        checked("folder", store.get_folder(ACCOUNT, INBOX)).expect("the sync stored the INBOX row");
    assert_eq!(
        folder.modseq, None,
        "a server without CONDSTORE left a modseq behind"
    );

    let again = sync(&cfg, &store, INBOX).await;
    assert_eq!(again.inserted, 0, "{again:?}");
    assert_eq!(again.flags_updated, 0, "{again:?}");
    assert_eq!(again.removed, 0, "{again:?}");

    let uid = find(&store, INBOX, &subject).uid;
    let mut raw = connect(&cfg).await;
    select(&mut raw, INBOX).await;
    uid_store(&mut raw, uid, "+FLAGS (\\Seen \\Flagged)").await;

    let flags = sync(&cfg, &store, INBOX).await;
    assert!(flags.flags_updated >= 1, "{flags:?}");
    let stored = checked("lookup", store.get_message(ACCOUNT, INBOX, uid)).expect("message");
    assert!(
        !stored.flags.unread && stored.flags.starred,
        "{:?}",
        stored.flags
    );
    assert_eq!(
        checked("folder", store.get_folder(ACCOUNT, INBOX))
            .expect("row")
            .modseq,
        None
    );

    let doomed = unique("[live-fallback] message supprime");
    send(&cfg, &doomed, "corps supprime", None).await;
    let kept = unique("[live-fallback] message garde");
    send(&cfg, &kept, "corps garde", None).await;
    sync(&cfg, &store, INBOX).await;
    let doomed_uid = find(&store, INBOX, &doomed).uid;
    let kept_uid = find(&store, INBOX, &kept).uid;

    let mut raw = connect(&cfg).await;
    select(&mut raw, INBOX).await;
    uid_store(&mut raw, doomed_uid, "+FLAGS (\\Deleted)").await;
    uid_expunge(&mut raw, doomed_uid).await;

    let report = sync(&cfg, &store, INBOX).await;
    assert!(report.removed >= 1, "{report:?}");
    assert_eq!(report.inserted, 0, "{report:?}");
    assert!(
        checked(
            "doomed lookup",
            store.get_message(ACCOUNT, INBOX, doomed_uid)
        )
        .is_none(),
        "uid {doomed_uid} survived the server expunge"
    );
    assert!(
        checked("kept lookup", store.get_message(ACCOUNT, INBOX, kept_uid)).is_some(),
        "uid {kept_uid} vanished from the store"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn move_keeps_store_in_step_with_server() {
    let cfg = account();
    let store = store(&cfg);
    let subject = unique("[live-archive] deplacement");
    send(&cfg, &subject, "corps archive", None).await;

    let mut session = connect(&cfg).await;
    checked(
        "create Archive",
        imap::create_folder(&mut session, "Archive").await,
    );
    checked(
        "create Archive again",
        imap::create_folder(&mut session, "Archive").await,
    );
    checked(
        "sync",
        imap::sync_folder(
            &mut session,
            &store,
            ACCOUNT,
            INBOX,
            &FolderMapping::default(),
        )
        .await,
    );
    let uid = find(&store, INBOX, &subject).uid;

    checked(
        "move to Archive",
        imap::move_message(&mut session, &store, ACCOUNT, INBOX, uid, "Archive").await,
    );
    assert!(
        checked("inbox lookup", store.get_message(ACCOUNT, INBOX, uid)).is_none(),
        "uid {uid} is still in INBOX"
    );
    let inbox = checked(
        "inbox listing",
        store.messages_in_folder(ACCOUNT, INBOX, -1, 0),
    );
    assert!(
        inbox.iter().all(|message| message.subject != subject),
        "'{subject}' is still in the local INBOX"
    );

    let archived = find(&store, "Archive", &subject);
    assert!(
        archived
            .body_text
            .as_deref()
            .is_some_and(|text| text.contains("corps archive")),
        "the reconciled Archive copy has no body: {:?}",
        archived.body_text
    );
    checked(
        "fetch body",
        imap::fetch_body(
            &mut session,
            &store,
            ACCOUNT,
            "Archive",
            archived.uid,
            &PgpKeyring::new(),
        )
        .await,
    );

    let mut raw = connect(&cfg).await;
    select(&mut raw, "Archive").await;
    let server = server_uids(&mut raw).await;
    assert!(
        server.contains(&archived.uid),
        "local Archive holds uid {} while the server exposes {server:?}",
        archived.uid
    );
    for message in checked(
        "archive listing",
        store.messages_in_folder(ACCOUNT, "Archive", -1, 0),
    ) {
        assert!(
            server.contains(&message.uid),
            "local Archive holds uid {} the server does not expose ({server:?})",
            message.uid
        );
    }
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn reply_joins_the_thread() {
    let cfg = account();
    let store = store(&cfg);
    let question = unique("[live-thread] question");
    send(&cfg, &question, "corps question", None).await;
    sync(&cfg, &store, INBOX).await;
    let original = find(&store, INBOX, &question);
    let message_id = original
        .message_id
        .clone()
        .unwrap_or_else(|| panic!("'{question}' carries no Message-ID"));

    let answer = format!("Re: {question}");
    send(&cfg, &answer, "corps reponse", Some(&message_id)).await;
    sync(&cfg, &store, INBOX).await;

    let reply = find(&store, INBOX, &answer);
    assert_eq!(reply.thread_id, original.thread_id);
    assert_eq!(reply.in_reply_to.as_deref(), Some(message_id.as_str()));

    let threads = checked(
        "read threads",
        store.threads_in_folder(ACCOUNT, INBOX, -1, 0),
    );
    let ours: Vec<_> = threads
        .iter()
        .filter(|thread| {
            thread
                .messages
                .iter()
                .any(|message| message.subject == question || message.subject == answer)
        })
        .collect();
    assert_eq!(ours.len(), 1, "question and reply are in separate threads");
    assert_eq!(ours[0].count, 2);
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn xoauth2_authenticates_with_refresh_token() {
    let cfg = account();
    let password = env_or("MAIL_TEST_PASSWORD", "secret");
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the mock token endpoint");
    let address = listener.local_addr().expect("mock token endpoint address");

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request).await;
            let body = format!("{{\"access_token\":\"{password}\",\"expires_in\":3600}}");
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });

    let mut cfg = cfg.clone();
    cfg.auth = AuthConfig::OAuth2 {
        client_id: "lavande-live".to_string(),
        client_secret: "unused".to_string(),
        refresh_token: "refresh-token".to_string(),
        token_endpoint: format!("http://{address}/token"),
    };

    let mut session = connect(&cfg).await;
    let folders = checked(
        "list folders with XOAUTH2",
        imap::list_folders(&mut session, ACCOUNT).await,
    );
    assert!(
        folders
            .iter()
            .any(|folder| folder.path.eq_ignore_ascii_case(INBOX)),
        "XOAUTH2 session sees no INBOX"
    );
}
