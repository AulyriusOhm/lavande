//! Live HTTP tests against the GreenMail container started by
//! `scripts/mail-test-server.sh`.
//!
//! Ignored by default so a plain `cargo test` stays offline. Run them with:
//!
//! ```sh
//! scripts/mail-test-server.sh start
//! LAVANDE_MAIL_EXTRA_ROOTS=$HOME/.cache/lavande/mail-test/cert.pem \
//!   cargo test -p lavande-mail-api --test live -- --ignored --test-threads=1
//! scripts/mail-test-server.sh stop
//! ```
//!
//! `--test-threads=1` is mandatory: every scenario reads and writes the same
//! INBOX, and each one prefixes its subjects with `[live-api-<name>]` so it only
//! looks at the messages it sent itself.

use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::TryStreamExt;
use lavande_mail::config::{AccountConfig, AuthConfig, Encryption, Endpoint};
use lavande_mail::imap;
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::net::TcpListener;

const ACCOUNT: &str = "live-api";
const INBOX: &str = "INBOX";
const ARCHIVE: &str = "Archive";

fn env_or(variable: &str, default: &str) -> String {
    env::var(variable).unwrap_or_else(|_| default.to_string())
}

fn certificate() -> PathBuf {
    if let Ok(path) = env::var("LAVANDE_MAIL_EXTRA_ROOTS") {
        return PathBuf::from(path);
    }
    let directory = match env::var("MAIL_TEST_TLS_DIR") {
        Ok(directory) => PathBuf::from(directory),
        Err(_) => PathBuf::from(env::var("HOME").expect(
            "ni LAVANDE_MAIL_EXTRA_ROOTS ni HOME : pointez LAVANDE_MAIL_EXTRA_ROOTS sur le certificat",
        ))
        .join(".cache/lavande/mail-test"),
    };
    directory.join("cert.pem")
}

fn tls_options() -> TlsOptions {
    let path = certificate();
    let pem = fs::read(&path).unwrap_or_else(|error| {
        panic!("certificat de test illisible {} : {error}", path.display())
    });
    TlsOptions {
        extra_roots_pem: vec![pem],
    }
}

fn endpoint(variable: &str, default: &str) -> Endpoint {
    let value = env_or(variable, default);
    let (host, port) = value
        .rsplit_once(':')
        .unwrap_or_else(|| panic!("{variable} doit être écrit host:port, reçu {value}"));
    Endpoint {
        host: host.to_string(),
        port: port
            .parse()
            .unwrap_or_else(|_| panic!("{variable} ne porte pas de port valide : {value}")),
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

fn unique(name: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("l'horloge est antérieure à 1970")
        .as_nanos();
    format!("{name} {nanos}")
}

/// The daemon on a loopback port of its own, with a throw-away data directory.
struct Daemon {
    base: String,
    directory: TempDir,
    _state: Arc<AppState>,
}

impl Daemon {
    async fn start() -> Self {
        let directory = tempfile::tempdir().expect("répertoire temporaire");
        let state = Arc::new(
            AppState::open_with(
                directory.path(),
                tls_options(),
                Default::default(),
                SecretBackend::File,
            )
            .await
            .expect("ouverture de l'état"),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("port libre");
        let address = listener.local_addr().expect("adresse locale");
        let served = state.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app(served)).await;
        });
        Self {
            base: format!("http://{address}"),
            directory,
            _state: state,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// Client HTTP portant le jeton Bearer du démon.
    fn client(&self) -> Client {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", self._state.token())
                .parse()
                .expect("en-tête d'authentification"),
        );
        Client::builder()
            .default_headers(headers)
            .build()
            .expect("client HTTP")
    }
}

async fn add_account(client: &Client, daemon: &Daemon) -> Value {
    let response = client
        .post(daemon.url("/api/accounts"))
        .json(&account())
        .send()
        .await
        .expect("POST /api/accounts");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::CREATED, "{body}");
    serde_json::from_str(&body).expect("compte")
}

async fn sync(client: &Client, daemon: &Daemon, folder_path: Option<&str>) -> Value {
    let request = client.post(daemon.url(&format!("/api/accounts/{ACCOUNT}/sync")));
    let request = match folder_path {
        Some(path) => request.json(&json!({ "folder_path": path })),
        None => request,
    };
    let response = request.send().await.expect("POST sync");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str(&body).expect("rapports")
}

async fn send(client: &Client, daemon: &Daemon, subject: &str) {
    let payload = json!({
        "to": [{ "name": "Live", "email": account().email }],
        "cc": [], "bcc": [],
        "subject": subject,
        "text": "corps du message",
        "html": null,
        "references": [],
        "attachments": [
            { "filename": "note.txt", "mime": "text/plain", "data_base64": "aGVsbG8=" }
        ]
    });
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/send")))
        .json(&payload)
        .send()
        .await
        .expect("POST send");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
}

async fn threads(client: &Client, daemon: &Daemon, folder_path: &str) -> Vec<Value> {
    let uri = format!("/api/accounts/{ACCOUNT}/folders/{folder_path}/threads?limit=200&offset=0");
    let response = client
        .get(daemon.url(&uri))
        .send()
        .await
        .expect("GET threads");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str(&body).expect("fils")
}

async fn message(client: &Client, daemon: &Daemon, folder_path: &str, uid: u32) -> Value {
    let uri = format!("/api/accounts/{ACCOUNT}/folders/{folder_path}/messages/{uid}");
    let response = client
        .get(daemon.url(&uri))
        .send()
        .await
        .expect("GET message");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str(&body).expect("message")
}

fn find(messages: &[Value], subject: &str) -> u32 {
    messages
        .iter()
        .flat_map(|thread| thread["messages"].as_array().expect("messages"))
        .find(|message| message["subject"] == subject)
        .map(|message| message["uid"].as_u64().expect("uid") as u32)
        .unwrap_or_else(|| panic!("« {subject} » est absent du dossier"))
}

fn subjects(messages: &[Value]) -> Vec<String> {
    messages
        .iter()
        .flat_map(|thread| thread["messages"].as_array().expect("messages"))
        .map(|message| message["subject"].as_str().unwrap_or_default().to_string())
        .collect()
}

async fn create_folder(path: &str) {
    let config = account();
    let mut session = imap::connect_with(&config, &tls_options())
        .await
        .unwrap_or_else(|error| panic!("connexion imap : {error}"));
    imap::create_folder(&mut session, path)
        .await
        .unwrap_or_else(|error| panic!("création de {path} : {error}"));
    let _ = session.logout().await;
}

/// The uids a fresh session sees in `folder_path`: the server's own view.
async fn server_uids(folder_path: &str) -> Vec<u32> {
    let config = account();
    let mut session = imap::connect_with(&config, &tls_options())
        .await
        .unwrap_or_else(|error| panic!("connexion imap : {error}"));
    session
        .select(folder_path)
        .await
        .unwrap_or_else(|error| panic!("SELECT {folder_path} : {error}"));
    let uids = session
        .uid_fetch("1:*", "(UID)")
        .await
        .unwrap_or_else(|error| panic!("UID FETCH {folder_path} : {error}"))
        .try_collect::<Vec<_>>()
        .await
        .unwrap_or_else(|error| panic!("UID FETCH {folder_path} : {error}"))
        .iter()
        .filter_map(|fetch| fetch.uid)
        .collect();
    let _ = session.logout().await;
    uids
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn account_is_added_and_synced() {
    let daemon = Daemon::start().await;
    let client = daemon.client();

    let summary = add_account(&client, &daemon).await;
    assert_eq!(summary["id"], ACCOUNT);
    assert_eq!(summary["email"], account().email);
    assert!(
        summary["auth"].is_null(),
        "la réponse expose l'authentification"
    );
    assert!(
        summary["folders"].as_u64().expect("folders") >= 1,
        "{summary}"
    );

    let accounts_path = daemon.directory.path().join("accounts.json");
    let mode = fs::metadata(&accounts_path)
        .expect("accounts.json")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "accounts.json n'est pas en 0600");

    let response = client
        .get(daemon.url("/api/accounts"))
        .send()
        .await
        .expect("GET /api/accounts");
    assert_eq!(response.status(), StatusCode::OK);
    let listing = response.text().await.expect("corps");
    assert!(
        !listing.contains("secret"),
        "la liste expose un secret : {listing}"
    );
    assert!(
        !listing.contains("password"),
        "la liste expose un secret : {listing}"
    );

    let response = client
        .get(daemon.url(&format!("/api/accounts/{ACCOUNT}/folders")))
        .send()
        .await
        .expect("GET folders");
    assert_eq!(response.status(), StatusCode::OK);
    let folders: Vec<Value> = response.json().await.expect("dossiers");
    assert!(
        folders
            .iter()
            .any(|folder| folder["path"] == INBOX && folder["role"] == "inbox"),
        "aucun INBOX parmi {folders:?}"
    );

    let reports = sync(&client, &daemon, None).await;
    let reports = reports["reports"].as_array().expect("reports");
    assert!(!reports.is_empty(), "aucun rapport de synchro");
    assert!(
        reports.iter().any(|report| report["folder_path"] == INBOX),
        "{reports:?}"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn sent_message_is_found_by_a_sync() {
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;

    let subject = unique("[live-api-sync] parcours");
    send(&client, &daemon, &subject).await;
    sync(&client, &daemon, Some(INBOX)).await;

    let inbox = threads(&client, &daemon, INBOX).await;
    let uid = find(&inbox, &subject);
    let stored = message(&client, &daemon, INBOX, uid).await;
    assert_eq!(stored["subject"], subject);
    assert_eq!(stored["from"]["email"], account().email);
    assert_eq!(stored["flags"]["unread"], true);
    assert!(
        stored["attachments"]
            .as_array()
            .expect("pièces jointes")
            .iter()
            .any(|attachment| attachment["filename"] == "note.txt"),
        "{stored}"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn an_attachment_comes_back_from_the_server() {
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;

    let subject = unique("[live-api-attachment] telechargement");
    send(&client, &daemon, &subject).await;
    sync(&client, &daemon, Some(INBOX)).await;
    let uid = find(&threads(&client, &daemon, INBOX).await, &subject);
    let stored = message(&client, &daemon, INBOX, uid).await;
    assert_eq!(stored["attachments"][0]["filename"], "note.txt", "{stored}");

    let uri = format!("/api/accounts/{ACCOUNT}/folders/{INBOX}/messages/{uid}/attachments/0");
    let response = client
        .get(daemon.url(&uri))
        .send()
        .await
        .expect("GET attachment");
    assert_eq!(response.status(), StatusCode::OK);
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    assert_eq!(header("content-type"), "text/plain", "{uid}");
    let disposition = header("content-disposition");
    assert!(disposition.contains("note.txt"), "{disposition}");
    let bytes = response.bytes().await.expect("octets");
    assert_eq!(bytes.as_ref(), b"hello", "le corps ne correspond pas");

    let missing = format!("/api/accounts/{ACCOUNT}/folders/{INBOX}/messages/{uid}/attachments/9");
    let response = client
        .get(daemon.url(&missing))
        .send()
        .await
        .expect("GET attachment");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn an_encrypted_attachment_comes_back_cleartext() {
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;
    generate_key(&client, &daemon, &account().email).await;

    let subject = unique("[live-api-attachment] chiffre");
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/send")))
        .json(&json!({
            "to": [{ "email": account().email }],
            "cc": [], "bcc": [],
            "subject": subject,
            "text": "corps chiffre",
            "pgp_sign": true,
            "pgp_encrypt": true,
            "attachments": [
                { "filename": "note.txt", "mime": "text/plain", "data_base64": "aGVsbG8=" }
            ]
        }))
        .send()
        .await
        .expect("POST send");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    sync(&client, &daemon, Some(INBOX)).await;
    let uid = find(&threads(&client, &daemon, INBOX).await, &subject);
    let stored = message(&client, &daemon, INBOX, uid).await;
    assert_eq!(stored["pgp"], "encrypted", "{stored}");
    assert_eq!(stored["attachments"][0]["filename"], "note.txt", "{stored}");

    let uri = format!("/api/accounts/{ACCOUNT}/folders/{INBOX}/messages/{uid}/attachments/0");
    let response = client
        .get(daemon.url(&uri))
        .send()
        .await
        .expect("GET attachment");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.bytes().await.expect("octets");
    assert_eq!(
        bytes.as_ref(),
        b"hello",
        "la pièce jointe d'un message chiffré n'est pas rendue en clair"
    );
}

async fn generate_key(client: &Client, daemon: &Daemon, email: &str) -> Value {
    let response = client
        .post(daemon.url("/api/pgp/keys/generate"))
        .json(&json!({ "name": "Live", "email": email }))
        .send()
        .await
        .expect("POST /api/pgp/keys/generate");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str(&body).expect("clé")
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn a_pgp_message_is_decrypted_and_verified_by_the_daemon() {
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;

    let key = generate_key(&client, &daemon, &account().email).await;
    let fingerprint = key["key"]["fingerprint"].as_str().expect("empreinte");
    let listed = client
        .get(daemon.url("/api/pgp/keys"))
        .send()
        .await
        .expect("GET keys")
        .json::<Value>()
        .await
        .expect("clés");
    assert_eq!(listed["keys"][0]["fingerprint"], fingerprint);

    let subject = unique("[live-api-pgp] scelle");
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/send")))
        .json(&json!({
            "to": [{ "email": account().email }],
            "cc": [], "bcc": [],
            "subject": subject,
            "text": "corps chiffre",
            "pgp_sign": true,
            "pgp_encrypt": true,
        }))
        .send()
        .await
        .expect("POST send");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    sync(&client, &daemon, Some(INBOX)).await;
    let inbox = threads(&client, &daemon, INBOX).await;
    let uid = find(&inbox, &subject);
    let stored = message(&client, &daemon, INBOX, uid).await;
    assert_eq!(stored["pgp"], "encrypted", "{stored}");
    assert_eq!(stored["body_text"], "corps chiffre", "{stored}");
    let detail = &stored["pgp_detail"];
    assert_eq!(detail["decrypted"], true, "{stored}");
    assert_eq!(detail["verified"], true, "{stored}");
    assert_eq!(detail["signer"], key["key"]["user_id"].clone(), "{stored}");
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn flags_reach_the_server() {
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;

    let subject = unique("[live-api-flags] etoile");
    send(&client, &daemon, &subject).await;
    sync(&client, &daemon, Some(INBOX)).await;
    let uid = find(&threads(&client, &daemon, INBOX).await, &subject);

    let payload = json!({ "folder_path": INBOX, "uid": uid, "unread": false, "starred": true });
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/flags")))
        .json(&payload)
        .send()
        .await
        .expect("POST flags");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let stored = message(&client, &daemon, INBOX, uid).await;
    assert_eq!(stored["flags"]["unread"], false);
    assert_eq!(stored["flags"]["starred"], true);

    sync(&client, &daemon, Some(INBOX)).await;
    let refreshed = message(&client, &daemon, INBOX, uid).await;
    assert_eq!(
        refreshed["flags"]["starred"], true,
        "l'étoile n'a pas atteint le serveur : {refreshed}"
    );
    assert_eq!(
        refreshed["flags"]["unread"], false,
        "le message est encore non lu sur le serveur : {refreshed}"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn message_moves_to_archive() {
    create_folder(ARCHIVE).await;
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;

    let subject = unique("[live-api-archive] deplacement");
    send(&client, &daemon, &subject).await;
    sync(&client, &daemon, Some(INBOX)).await;
    let uid = find(&threads(&client, &daemon, INBOX).await, &subject);

    let payload = json!({ "from_path": INBOX, "uid": uid, "to_path": ARCHIVE });
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/move")))
        .json(&payload)
        .send()
        .await
        .expect("POST move");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let inbox = subjects(&threads(&client, &daemon, INBOX).await);
    assert!(
        !inbox.iter().any(|known| known == &subject),
        "« {subject} » est encore dans INBOX : {inbox:?}"
    );

    sync(&client, &daemon, Some(ARCHIVE)).await;
    let archived = subjects(&threads(&client, &daemon, ARCHIVE).await);
    assert!(
        archived.iter().any(|known| known == &subject),
        "« {subject} » n'est pas dans Archive : {archived:?}"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn message_is_deleted_permanently() {
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;

    let witness = unique("[live-api-delete] temoin");
    let target = unique("[live-api-delete] suppression definitive");
    send(&client, &daemon, &witness).await;
    send(&client, &daemon, &target).await;
    sync(&client, &daemon, Some(INBOX)).await;
    let uid = find(&threads(&client, &daemon, INBOX).await, &target);
    assert!(
        server_uids(INBOX).await.contains(&uid),
        "l'uid {uid} manque côté serveur avant la suppression"
    );

    let payload = json!({ "folder_path": INBOX, "uid": uid });
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/delete")))
        .json(&payload)
        .send()
        .await
        .expect("POST delete");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let response = client
        .get(daemon.url(&format!(
            "/api/accounts/{ACCOUNT}/folders/{INBOX}/messages/{uid}"
        )))
        .send()
        .await
        .expect("GET message");
    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "l'uid {uid} est toujours stocké"
    );

    sync(&client, &daemon, Some(INBOX)).await;
    let inbox = subjects(&threads(&client, &daemon, INBOX).await);
    assert!(
        !inbox.iter().any(|known| known == &target),
        "« {target} » est encore dans INBOX : {inbox:?}"
    );
    assert!(
        inbox.iter().any(|known| known == &witness),
        "« {witness} » est parti avec la suppression : {inbox:?}"
    );

    let server = server_uids(INBOX).await;
    assert!(
        !server.contains(&uid),
        "le serveur expose encore l'uid {uid} : {server:?}"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn folder_is_purged() {
    let folder = unique("Purge").replace(' ', "-");
    create_folder(&folder).await;
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;

    let subject = unique("[live-api-purge] dossier vide");
    send(&client, &daemon, &subject).await;
    sync(&client, &daemon, Some(INBOX)).await;
    let uid = find(&threads(&client, &daemon, INBOX).await, &subject);

    let payload = json!({ "from_path": INBOX, "uid": uid, "to_path": folder });
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/move")))
        .json(&payload)
        .send()
        .await
        .expect("POST move");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    sync(&client, &daemon, Some(folder.as_str())).await;

    let payload = json!({ "folder_path": folder });
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/purge")))
        .json(&payload)
        .send()
        .await
        .expect("POST purge");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::OK, "{body}");
    let removed = serde_json::from_str::<Value>(&body).expect("purge")["removed"]
        .as_u64()
        .expect("removed");
    assert!(
        removed >= 1,
        "la purge n'a rien retiré de « {folder} » : {body}"
    );

    sync(&client, &daemon, Some(folder.as_str())).await;
    let left = subjects(&threads(&client, &daemon, &folder).await);
    assert!(left.is_empty(), "« {folder} » n'est pas vide : {left:?}");
    let server = server_uids(&folder).await;
    assert!(
        server.is_empty(),
        "le serveur expose encore {server:?} dans « {folder} »"
    );
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn a_composition_saved_as_a_draft_lands_in_the_drafts_folder() {
    let daemon = Daemon::start().await;
    let client = daemon.client();
    add_account(&client, &daemon).await;
    sync(&client, &daemon, None).await;

    let response = client
        .get(daemon.url(&format!("/api/accounts/{ACCOUNT}/folders")))
        .send()
        .await
        .expect("GET folders");
    let folders: Vec<Value> = response.json().await.expect("dossiers");
    let drafts = folders
        .iter()
        .find(|folder| folder["role"] == "drafts")
        .expect("dossier Brouillons")["path"]
        .as_str()
        .expect("chemin")
        .to_string();

    let subject = unique("[live-api-draft] brouillon");
    let response = client
        .post(daemon.url(&format!("/api/accounts/{ACCOUNT}/drafts")))
        .json(&json!({
            "to": [{ "email": account().email }],
            "cc": [], "bcc": [],
            "subject": subject,
            "text": "corps du brouillon"
        }))
        .send()
        .await
        .expect("POST drafts");
    let status = response.status();
    let body = response.text().await.expect("corps");
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    sync(&client, &daemon, Some(drafts.as_str())).await;
    let uid = find(&threads(&client, &daemon, &drafts).await, &subject);
    let stored = message(&client, &daemon, &drafts, uid).await;
    assert_eq!(stored["subject"], subject, "{stored}");
}
