//! Offline HTTP tests: the router is driven directly, no socket, no network.

use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use lavande_mail::error::MailError;
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::error::ApiError;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

async fn state() -> (TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let state = AppState::open_with(
        directory.path(),
        TlsOptions::default(),
        Default::default(),
        SecretBackend::File,
    )
    .await
    .expect("état");
    (directory, Arc::new(state))
}

async fn state_in(directory: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::open_with(
            directory,
            TlsOptions::default(),
            Default::default(),
            SecretBackend::File,
        )
        .await
        .expect("état"),
    )
}

fn account(id: &str) -> Value {
    json!({
        "id": id,
        "label": "Perso",
        "email": "roman@lavande.mail",
        "username": "roman@lavande.mail",
        "imap": { "host": "imap.lavande.mail", "port": 993, "encryption": "tls" },
        "smtp": { "host": "smtp.lavande.mail", "port": 465, "encryption": "tls" },
        "auth": { "kind": "password", "password": "secret-en-clair" }
    })
}

fn seed(directory: &Path, accounts: &[Value]) {
    let bytes = serde_json::to_vec_pretty(accounts).expect("json");
    fs::write(directory.join("accounts.json"), bytes).expect("accounts.json");
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("requête")
}

fn post(uri: &str, payload: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .expect("requête")
}

fn patch(uri: &str, payload: &Value) -> Request<Body> {
    Request::builder()
        .method("PATCH")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .expect("requête")
}

fn folder(path: &str, modseq: Option<u64>) -> lavande_mail::model::Folder {
    lavande_mail::model::Folder {
        account_id: "perso".to_string(),
        path: path.to_string(),
        name: path.to_string(),
        role: lavande_mail::model::FolderRole::Inbox,
        uidvalidity: 1,
        uidnext: 9,
        last_sync_at: None,
        modseq,
        delimiter: None,
    }
}

fn custom_folder(path: &str) -> lavande_mail::model::Folder {
    lavande_mail::model::Folder {
        role: lavande_mail::model::FolderRole::Other,
        ..folder(path, None)
    }
}

fn delete(uri: &str) -> Request<Body> {
    Request::builder()
        .method("DELETE")
        .uri(uri)
        .body(Body::empty())
        .expect("requête")
}

async fn call(state: &Arc<AppState>, mut request: Request<Body>) -> (StatusCode, Bytes) {
    if !request.headers().contains_key("authorization") {
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", state.token())
                .parse()
                .expect("en-tête"),
        );
    }
    call_bare(state, request).await
}

async fn call_bare(state: &Arc<AppState>, request: Request<Body>) -> (StatusCode, Bytes) {
    let response = app(state.clone())
        .oneshot(request)
        .await
        .expect("le routeur répond");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("corps de la réponse");
    (status, body)
}

fn json(body: &Bytes) -> Value {
    serde_json::from_slice(body).expect("corps JSON")
}

#[tokio::test]
async fn health_reports_ok() {
    let (_directory, state) = state().await;
    let (status, body) = call(&state, get("/api/health")).await;
    assert_eq!(status, StatusCode::OK);
    let payload = json(&body);
    assert_eq!(payload["status"], "ok");
    assert_eq!(payload["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn invalid_config_is_a_400() {
    let (_directory, state) = state().await;
    let mut plain = account("perso");
    plain["imap"]["encryption"] = json!("plain");
    let (status, body) = call(&state, post("/api/accounts", &plain)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");

    let mut nameless = account("perso");
    nameless["id"] = json!("  ");
    let (status, body) = call(&state, post("/api/accounts", &nameless)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");
}

#[tokio::test]
async fn malformed_body_is_a_400() {
    let (_directory, state) = state().await;
    let (status, body) = call(&state, post("/api/accounts", &json!({ "id": "perso" }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");
}

#[tokio::test]
async fn duplicate_account_id_is_a_409() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    let (status, body) = call(&state, post("/api/accounts", &account("perso"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(json(&body)["kind"], "config");
}

#[tokio::test]
async fn accounts_list_never_returns_a_secret() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8(body.to_vec()).expect("utf-8");
    assert!(!text.contains("secret-en-clair"), "{text}");
    let payload = json(&body);
    // Le résumé ne transporte ni secret ni configuration d'authentification :
    // seul `auth_kind` en sort, le mot de passe reste au coffre.
    assert!(payload[0].get("auth").is_none(), "{payload}");
    assert!(payload[0].get("password").is_none(), "{payload}");
    assert_eq!(payload[0]["id"], "perso");
    assert_eq!(payload[0]["username"], "roman@lavande.mail");
    assert_eq!(payload[0]["auth_kind"], "password");
    assert_eq!(payload[0]["needs_reauth"], false);
    assert_eq!(payload[0]["imap"]["host"], "imap.lavande.mail");
    assert_eq!(payload[0]["imap"]["encryption"], "tls");
    assert_eq!(payload[0]["smtp"]["port"], 465);
    assert_eq!(payload[0]["folders"], 0);
}

#[tokio::test]
async fn failed_connection_stores_nothing() {
    let (directory, state) = state().await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port libre");
    let port = listener.local_addr().expect("adresse").port();
    drop(listener);

    let mut refused = account("perso");
    refused["imap"]["host"] = json!("127.0.0.1");
    refused["imap"]["port"] = json!(port);
    let (status, body) = call(&state, post("/api/accounts", &refused)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json(&body)["kind"], "imap");

    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body), json!([]));
    assert!(!directory.path().join("accounts.json").exists());
}

#[tokio::test]
async fn preview_rejects_an_invalid_config() {
    let (_directory, state) = state().await;
    let mut plain = account("perso");
    plain["imap"]["encryption"] = json!("plain");
    let (status, body) = call(&state, post("/api/accounts/preview", &plain)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");
}

#[tokio::test]
async fn preview_lists_the_folders_without_creating_the_account() {
    let (directory, state) = state().await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port libre");
    let port = listener.local_addr().expect("adresse").port();
    drop(listener);

    let mut refused = account("perso");
    refused["imap"]["host"] = json!("127.0.0.1");
    refused["imap"]["port"] = json!(port);
    let (status, body) = call(&state, post("/api/accounts/preview", &refused)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json(&body)["kind"], "imap");

    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body), json!([]), "une prévisualisation ne crée rien");
    assert!(!directory.path().join("accounts.json").exists());
}

#[tokio::test]
async fn a_selection_sent_at_creation_is_kept_for_the_first_sync() {
    let (_directory, state) = state().await;
    let config = lavande_mail::config::AccountConfig {
        id: "perso".to_string(),
        label: "Perso".to_string(),
        email: "roman@lavande.mail".to_string(),
        username: "roman@lavande.mail".to_string(),
        imap: lavande_mail::config::Endpoint {
            host: "imap.lavande.mail".to_string(),
            port: 993,
            encryption: lavande_mail::config::Encryption::Tls,
        },
        smtp: lavande_mail::config::Endpoint {
            host: "smtp.lavande.mail".to_string(),
            port: 465,
            encryption: lavande_mail::config::Encryption::Tls,
        },
        auth: lavande_mail::config::AuthConfig::Password {
            password: "secret-en-clair".to_string(),
        },
        synced_folders: Some(vec!["Archive".to_string()]),
        ai_folders: None,
    };

    state
        .add_account(&config, &[folder("INBOX", None), folder("Archive", None)])
        .await
        .expect("compte");

    assert_eq!(
        state.sync_folders("perso").expect("choix"),
        Some(vec!["Archive".to_string()])
    );
    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)[0]["synced_folders"], json!(["Archive"]));
}

#[tokio::test]
async fn unknown_account_delete_is_a_404() {
    let (_directory, state) = state().await;
    let (status, body) = call(&state, delete("/api/accounts/absent")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn known_account_delete_rewrites_the_file() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso"), account("travail")]);
    let (status, _) = call(&state, delete("/api/accounts/perso")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    let payload = json(&body);
    assert_eq!(payload.as_array().expect("liste").len(), 1);
    assert_eq!(payload[0]["id"], "travail");
}

#[tokio::test]
async fn a_removed_account_can_be_added_again() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    let (status, _) = call(&state, delete("/api/accounts/perso")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port libre");
    let port = listener.local_addr().expect("adresse").port();
    drop(listener);

    let mut again = account("perso");
    again["imap"]["host"] = json!("127.0.0.1");
    again["imap"]["port"] = json!(port);
    let (status, body) = call(&state, post("/api/accounts", &again)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "corps : {body:?}");
}

#[tokio::test]
async fn a_failed_account_save_leaves_no_half_created_account() {
    let (directory, mut state) = state().await;
    let config: lavande_mail::config::AccountConfig =
        serde_json::from_value(account("perso")).expect("config");
    Arc::get_mut(&mut state)
        .expect("état exclusif")
        .set_accounts_path(directory.path().join("absent").join("accounts.json"));

    let error = state
        .add_account(&config, &[folder("INBOX", None)])
        .await
        .expect_err("accounts.json impossible à écrire");
    assert_eq!(error.kind(), "config");
    assert!(state.stored_accounts().expect("comptes").is_empty());
    assert!(state
        .store()
        .list_folders("perso")
        .expect("dossiers")
        .is_empty());
    assert_eq!(state.secrets().get("perso").await.expect("secret"), None);
}

#[tokio::test]
async fn unknown_account_folders_is_a_404() {
    let (_directory, state) = state().await;
    let (status, body) = call(&state, get("/api/accounts/absent/folders")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn unknown_message_flags_are_a_404() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let payload = json!({ "folder_path": "INBOX", "uid": 42, "unread": false, "starred": true });
    let (status, body) = call(&state, post("/api/accounts/perso/flags", &payload)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn bulk_flags_refuse_an_empty_uid_list() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let payload = json!({ "folder_path": "INBOX", "uids": [], "unread": false, "starred": true });
    let (status, body) = call(&state, post("/api/accounts/perso/flags-bulk", &payload)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "uids");
    assert_eq!(json(&body)["error"], "liste d'UIDs vide");
}

#[tokio::test]
async fn bulk_move_refuses_an_empty_uid_list() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let payload = json!({ "from_path": "INBOX", "uids": [], "to_path": "Archive" });
    let (status, body) = call(&state, post("/api/accounts/perso/move-bulk", &payload)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "uids");
}

#[tokio::test]
async fn bulk_delete_refuses_an_empty_uid_list() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let payload = json!({ "folder_path": "INBOX", "uids": [] });
    let (status, body) = call(&state, post("/api/accounts/perso/delete-bulk", &payload)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "uids");
}

#[tokio::test]
async fn bulk_flags_refuse_an_oversized_selection() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let uids: Vec<u32> = (1..=501).collect();
    let payload = json!({ "folder_path": "INBOX", "uids": uids, "unread": false, "starred": true });
    let (status, body) = call(&state, post("/api/accounts/perso/flags-bulk", &payload)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "uids");
}

#[tokio::test]
async fn bulk_operations_on_an_unknown_account_are_a_404() {
    let (_directory, state) = state().await;
    let flags = json!({ "folder_path": "INBOX", "uids": [4], "unread": false, "starred": true });
    let (status, body) = call(&state, post("/api/accounts/absent/flags-bulk", &flags)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");

    let moved = json!({ "from_path": "INBOX", "uids": [4], "to_path": "Archive" });
    let (status, body) = call(&state, post("/api/accounts/absent/move-bulk", &moved)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");

    let deleted = json!({ "folder_path": "INBOX", "uids": [4] });
    let (status, body) = call(&state, post("/api/accounts/absent/delete-bulk", &deleted)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn bulk_flags_refuse_a_uid_the_store_does_not_hold() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let payload = json!({ "folder_path": "INBOX", "uids": [42], "unread": false, "starred": true });
    let (status, body) = call(&state, post("/api/accounts/perso/flags-bulk", &payload)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn previews_refuse_an_empty_uid_list() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let payload = json!({ "uids": [] });
    let (status, body) = call(
        &state,
        post("/api/accounts/perso/folders/INBOX/previews", &payload),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "uids");
    assert_eq!(json(&body)["error"], "liste d'UIDs vide");
}

#[tokio::test]
async fn previews_refuse_an_oversized_selection() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let uids: Vec<u32> = (1..=51).collect();
    let payload = json!({ "uids": uids });
    let (status, body) = call(
        &state,
        post("/api/accounts/perso/folders/INBOX/previews", &payload),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "uids");
    assert_eq!(
        json(&body)["error"],
        "sélection trop grande : 50 messages maximum par requête"
    );
}

#[tokio::test]
async fn previews_on_an_unknown_account_are_a_404() {
    let (_directory, state) = state().await;
    let payload = json!({ "uids": [4] });
    let (status, body) = call(
        &state,
        post("/api/accounts/absent/folders/INBOX/previews", &payload),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn encoded_folder_path_is_decoded() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    let uri =
        "/api/accounts/perso/folders/Bo%C3%AEte%20de%20r%C3%A9ception/threads?limit=10&offset=0";
    let (status, body) = call(&state, get(uri)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body), json!([]));
}

#[tokio::test]
async fn threads_of_an_unknown_account_is_a_404() {
    let (_directory, state) = state().await;
    let (status, body) = call(&state, get("/api/accounts/absent/folders/INBOX/threads")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn renaming_an_account_keeps_its_identity() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);

    let (status, body) = call(
        &state,
        patch("/api/accounts/perso", &json!({ "label": "  Maison  " })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let renamed = json(&body);
    assert_eq!(renamed["id"], "perso");
    assert_eq!(renamed["label"], "Maison");
    assert_eq!(renamed["email"], "roman@lavande.mail");
    assert_eq!(renamed["username"], "roman@lavande.mail");

    let (_status, listed) = call(&state, get("/api/accounts")).await;
    assert_eq!(json(&listed)[0]["label"], "Maison");
    let config = state.account("perso").await.expect("compte");
    assert_eq!(config.label, "Maison");
    assert_eq!(config.email, "roman@lavande.mail");
    assert_eq!(
        state.store().list_accounts().expect("comptes")[0].1,
        "Maison"
    );
    assert!(
        state
            .secrets()
            .get("perso")
            .await
            .expect("secret")
            .is_some(),
        "le mot de passe du compte survit au renommage"
    );

    let (status, body) = call(
        &state,
        patch("/api/accounts/perso", &json!({ "label": "   " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");

    let (status, body) = call(
        &state,
        patch("/api/accounts/absent", &json!({ "label": "Maison" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn desyncing_a_folder_purges_it_locally() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    state
        .store()
        .upsert_folder(&folder("INBOX", Some(4242)))
        .expect("dossier");
    state
        .store()
        .upsert_folder(&folder("Archive", None))
        .expect("dossier");
    state
        .store()
        .upsert_message(&text_message())
        .expect("message");
    let mut archived = text_message();
    archived.uid = 8;
    archived.folder_path = "Archive".to_string();
    state.store().upsert_message(&archived).expect("message");

    let (status, body) = call(&state, delete("/api/accounts/perso/folders/INBOX/local")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(body.is_empty());
    assert!(state
        .store()
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("liste")
        .is_empty());
    let inbox = state
        .store()
        .get_folder("perso", "INBOX")
        .expect("dossier")
        .expect("présent");
    assert!(inbox.modseq.is_none(), "modseq réinitialisé");
    assert!(inbox.last_sync_at.is_none(), "last_sync_at réinitialisé");
    assert_eq!(
        state
            .store()
            .messages_in_folder("perso", "Archive", -1, 0)
            .expect("liste")
            .len(),
        1,
        "les autres dossiers sont intacts"
    );

    let (status, body) = call(&state, delete("/api/accounts/perso/folders/Nope/local")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");

    let (status, _) = call(&state, delete("/api/accounts/absent/folders/INBOX/local")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deleting_a_folder_holding_a_role_is_a_400() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    state
        .store()
        .upsert_folder(&folder("INBOX", None))
        .expect("dossier");
    state
        .store()
        .upsert_message(&text_message())
        .expect("message");

    let (status, body) = call(&state, delete("/api/accounts/perso/folders/INBOX")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");
    assert!(
        state
            .store()
            .get_folder("perso", "INBOX")
            .expect("dossier")
            .is_some(),
        "un rôle n'est jamais supprimé"
    );
    assert_eq!(
        state
            .store()
            .messages_in_folder("perso", "INBOX", -1, 0)
            .expect("liste")
            .len(),
        1
    );
}

#[tokio::test]
async fn deleting_an_unknown_folder_is_a_404() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);

    let (status, body) = call(&state, delete("/api/accounts/perso/folders/Nope")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");

    let (status, _) = call(&state, delete("/api/accounts/absent/folders/Nope")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// The server goes first: a refused `DELETE` leaves the local copy alone.
#[tokio::test]
async fn a_refused_server_delete_keeps_the_local_rows() {
    let (_directory, state) = state().await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port libre");
    let port = listener.local_addr().expect("adresse").port();
    drop(listener);
    let mut refused = account("perso");
    refused["imap"]["host"] = json!("127.0.0.1");
    refused["imap"]["port"] = json!(port);
    let config: lavande_mail::config::AccountConfig =
        serde_json::from_value(refused).expect("config");
    state.add_account(&config, &[]).await.expect("compte");
    state
        .store()
        .upsert_folder(&custom_folder("Projets"))
        .expect("dossier");
    state
        .store()
        .upsert_message(&text_message())
        .expect("message");

    let (status, body) = call(&state, delete("/api/accounts/perso/folders/Projets")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json(&body)["kind"], "imap");
    assert!(state
        .store()
        .get_folder("perso", "Projets")
        .expect("dossier")
        .is_some());
    assert_eq!(
        state
            .store()
            .messages_in_folder("perso", "INBOX", -1, 0)
            .expect("liste")
            .len(),
        1
    );
}

#[tokio::test]
async fn an_account_without_a_selection_reads_as_the_default() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);

    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    let listed = json(&body);
    assert_eq!(listed[0]["id"], "perso");
    assert!(
        listed[0]["synced_folders"].is_null(),
        "aucun choix enregistré : tous les dossiers à rôle connu"
    );
    assert_eq!(state.sync_folders("perso").expect("choix"), None);
}

#[tokio::test]
async fn choosing_the_synced_folders_keeps_the_rest_of_the_account() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    state
        .store()
        .upsert_folder(&folder("INBOX", Some(4242)))
        .expect("dossier");
    state
        .store()
        .upsert_folder(&folder("Archive", None))
        .expect("dossier");

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/perso/sync-folders",
            &json!({ "folders": ["Archive", " INBOX ", "Archive", ""] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let summary = json(&body);
    assert_eq!(summary["id"], "perso");
    assert_eq!(summary["label"], "Perso");
    assert_eq!(summary["synced_folders"], json!(["Archive", "INBOX"]));
    assert_eq!(
        state.sync_folders("perso").expect("choix"),
        Some(vec!["Archive".to_string(), "INBOX".to_string()])
    );

    let stored = state.stored_accounts().expect("comptes");
    assert_eq!(stored[0].label, "Perso", "le libellé survit au choix");
    assert_eq!(stored[0].email, "roman@lavande.mail");
    assert!(
        state
            .secrets()
            .get("perso")
            .await
            .expect("secret")
            .is_some(),
        "le mot de passe du compte survit au choix"
    );

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/perso/sync-folders",
            &json!({ "folders": [] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["synced_folders"], json!([]));
    assert_eq!(
        state.sync_folders("perso").expect("choix"),
        Some(Vec::new())
    );

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/perso/sync-folders",
            &json!({ "folders": null }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(json(&body)["synced_folders"].is_null());
    assert_eq!(state.sync_folders("perso").expect("choix"), None);
}

#[tokio::test]
async fn an_account_without_an_ai_selection_reads_as_the_default() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);

    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    let listed = json(&body);
    assert!(
        listed[0]["ai_folders"].is_null(),
        "aucun choix : la réception (INBOX et dossiers personnels)"
    );
    assert_eq!(state.ai_folders("perso").expect("choix"), None);
}

#[tokio::test]
async fn choosing_the_ai_folders_keeps_the_rest_of_the_account() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    state
        .store()
        .upsert_folder(&folder("INBOX", None))
        .expect("dossier");
    state
        .store()
        .upsert_folder(&custom_folder("INBOX/Informatique"))
        .expect("dossier");

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/perso/ai-folders",
            &json!({ "folders": ["INBOX/Informatique", " INBOX ", "INBOX/Informatique", ""] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let summary = json(&body);
    assert_eq!(summary["id"], "perso");
    assert_eq!(summary["label"], "Perso");
    assert_eq!(
        summary["ai_folders"],
        json!(["INBOX/Informatique", "INBOX"])
    );
    assert!(
        summary["synced_folders"].is_null(),
        "le périmètre de synchro reste intact"
    );
    assert_eq!(
        state.ai_folders("perso").expect("choix"),
        Some(vec!["INBOX/Informatique".to_string(), "INBOX".to_string()])
    );

    let stored = state.stored_accounts().expect("comptes");
    assert_eq!(stored[0].label, "Perso", "le libellé survit au choix");
    assert_eq!(
        stored[0].synced_folders, None,
        "les deux choix sont distincts"
    );
    assert!(
        state
            .secrets()
            .get("perso")
            .await
            .expect("secret")
            .is_some(),
        "le mot de passe du compte survit au choix"
    );
    let text = fs::read_to_string(directory.path().join("accounts.json")).expect("fichier");
    assert!(
        text.contains("ai_folders"),
        "le choix est persisté : {text}"
    );
    assert!(
        !text.contains("secret-en-clair"),
        "le secret reste hors du fichier"
    );

    let (status, body) = call(
        &state,
        patch("/api/accounts/perso/ai-folders", &json!({ "folders": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["ai_folders"], json!([]));
    assert_eq!(state.ai_folders("perso").expect("choix"), Some(Vec::new()));

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/perso/ai-folders",
            &json!({ "folders": null }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(json(&body)["ai_folders"].is_null());
    assert_eq!(state.ai_folders("perso").expect("choix"), None);
}

#[tokio::test]
async fn an_unknown_folder_in_the_ai_selection_is_a_400() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    state
        .store()
        .upsert_folder(&folder("INBOX", None))
        .expect("dossier");

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/perso/ai-folders",
            &json!({ "folders": ["INBOX", "Fantome"] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");
    assert_eq!(
        state.ai_folders("perso").expect("choix"),
        None,
        "un refus ne modifie rien"
    );

    let (status, body) = call(
        &state,
        patch("/api/accounts/absent/ai-folders", &json!({ "folders": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn an_unknown_folder_in_the_selection_is_a_400() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    state
        .store()
        .upsert_folder(&folder("INBOX", None))
        .expect("dossier");

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/perso/sync-folders",
            &json!({ "folders": ["INBOX", "Fantome"] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");
    assert_eq!(
        state.sync_folders("perso").expect("choix"),
        None,
        "un refus ne modifie rien"
    );

    let (status, body) = call(
        &state,
        patch(
            "/api/accounts/absent/sync-folders",
            &json!({ "folders": [] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn a_selection_is_written_to_accounts_json_and_survives_a_reload() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);
    state
        .store()
        .upsert_folder(&folder("INBOX", None))
        .expect("dossier");

    let (status, _) = call(
        &state,
        patch(
            "/api/accounts/perso/sync-folders",
            &json!({ "folders": ["INBOX"] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let text = fs::read_to_string(directory.path().join("accounts.json")).expect("fichier");
    assert!(
        text.contains("synced_folders"),
        "le choix est persisté : {text}"
    );
    assert!(
        !text.contains("secret-en-clair"),
        "le secret reste hors du fichier"
    );

    let reopened = state_in(directory.path()).await;
    assert_eq!(
        reopened.sync_folders("perso").expect("choix"),
        Some(vec!["INBOX".to_string()])
    );

    let legacy = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(directory.path().join("accounts.json")).expect("fichier"),
    )
    .expect("json");
    assert!(legacy.is_array());
}

#[test]
fn mail_error_maps_to_status() {
    let cases = [
        (
            MailError::Config("x".to_string()),
            StatusCode::BAD_REQUEST,
            "config",
        ),
        (
            MailError::Auth("x".to_string()),
            StatusCode::UNAUTHORIZED,
            "auth",
        ),
        (
            MailError::InvalidData("x".to_string()),
            StatusCode::NOT_FOUND,
            "store",
        ),
        (
            MailError::Imap("x".to_string()),
            StatusCode::BAD_GATEWAY,
            "imap",
        ),
        (
            MailError::Smtp("x".to_string()),
            StatusCode::BAD_GATEWAY,
            "smtp",
        ),
        (
            MailError::Tls("x".to_string()),
            StatusCode::BAD_GATEWAY,
            "tls",
        ),
        (
            MailError::OAuth("x".to_string()),
            StatusCode::BAD_GATEWAY,
            "oauth",
        ),
        (
            MailError::OAuthRevoked("x".to_string()),
            StatusCode::UNAUTHORIZED,
            "oauth_revoked",
        ),
        (
            MailError::Mime("x".to_string()),
            StatusCode::INTERNAL_SERVER_ERROR,
            "mime",
        ),
        (
            MailError::Io(std::io::Error::other("x")),
            StatusCode::INTERNAL_SERVER_ERROR,
            "store",
        ),
    ];
    for (error, status, kind) in cases {
        let api = ApiError::from(error);
        assert_eq!(api.status(), status);
        assert_eq!(api.kind(), kind);
        assert!(!api.message().is_empty(), "{kind} carries no message");
    }
}

#[tokio::test]
async fn requests_without_a_token_are_refused() {
    let (_directory, state) = state().await;
    let (status, body) = call_bare(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json(&body)["kind"], "auth");
}

#[tokio::test]
async fn a_wrong_token_is_refused() {
    let (_directory, state) = state().await;
    let request = Request::builder()
        .uri("/api/accounts")
        .header("authorization", "Bearer pas-le-bon-jeton")
        .body(Body::empty())
        .expect("requête");
    let (status, body) = call_bare(&state, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json(&body)["kind"], "auth");
}

#[tokio::test]
async fn health_stays_public() {
    let (_directory, state) = state().await;
    let (status, _) = call_bare(&state, get("/api/health")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn events_accept_the_token_in_the_query() {
    let (_directory, state) = state().await;
    let uri = format!("/api/events?token={}", state.token());
    // SSE : statut seul, le corps est un flux infini (ne pas le lire).
    let response = app(state.clone())
        .oneshot(get(&uri))
        .await
        .expect("réponse");
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);

    let (status, _) = call_bare(&state, get("/api/events")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = call_bare(&state, get("/api/events?token=faux")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_attachment_of_an_unknown_message_is_a_404() {
    let (_directory, state) = state().await;
    let config: lavande_mail::config::AccountConfig =
        serde_json::from_value(account("perso")).expect("config");
    state
        .add_account(&config, &[])
        .await
        .expect("compte ajouté");

    let uri = "/api/accounts/perso/folders/INBOX/messages/7/attachments/0";
    let (status, _) = call_bare(&state, get(uri)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Le message n'est pas dans la base : la route répond sans ouvrir de session.
    let (status, body) = call(&state, get(uri)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let payload = json(&body);
    assert_eq!(payload["kind"], "store");
    assert!(
        payload["error"]
            .as_str()
            .expect("message")
            .contains("message 7 introuvable"),
        "{payload}"
    );
}

#[tokio::test]
async fn html_images_of_an_unknown_message_is_a_404() {
    let (_directory, state) = state().await;
    let config: lavande_mail::config::AccountConfig =
        serde_json::from_value(account("perso")).expect("config");
    state
        .add_account(&config, &[])
        .await
        .expect("compte ajouté");

    let uri = "/api/accounts/perso/folders/INBOX/messages/7/html-images";
    let (status, _) = call_bare(&state, get(uri)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = call(&state, get(uri)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let payload = json(&body);
    assert!(
        payload["error"]
            .as_str()
            .expect("message")
            .contains("message 7 introuvable"),
        "{payload}"
    );
}

/// Un message stocké sans corps HTML : 404 sans ouvrir de session IMAP.
#[tokio::test]
async fn html_images_of_a_text_only_message_is_a_404() {
    let (_directory, state) = state().await;
    let config: lavande_mail::config::AccountConfig =
        serde_json::from_value(account("perso")).expect("config");
    state
        .add_account(&config, &[])
        .await
        .expect("compte ajouté");
    state
        .store()
        .upsert_message(&text_message())
        .expect("message");

    let uri = "/api/accounts/perso/folders/INBOX/messages/7/html-images";
    let (status, body) = call(&state, get(uri)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let payload = json(&body);
    assert!(
        payload["error"]
            .as_str()
            .expect("message")
            .contains("pas de corps HTML"),
        "{payload}"
    );
}

fn text_message() -> lavande_mail::model::Message {
    let address = lavande_mail::model::Address {
        name: None,
        email: "camille@studio-lilas.fr".to_string(),
    };
    lavande_mail::model::Message {
        account_id: "perso".to_string(),
        folder_path: "INBOX".to_string(),
        uid: 7,
        uidvalidity: 1,
        thread_id: "t-soldes".to_string(),
        message_id: Some("soldes@studio-lilas.fr".to_string()),
        in_reply_to: None,
        references: Vec::new(),
        from: address.clone(),
        to: vec![address],
        cc: Vec::new(),
        subject: "Soldes".to_string(),
        date: None,
        flags: Default::default(),
        size: 64,
        pgp: Default::default(),
        pgp_detail: None,
        preview: "Soldes du mois".to_string(),
        body_text: Some("Soldes du mois".to_string()),
        body_html: None,
        attachments: Vec::new(),
    }
}

#[tokio::test]
async fn the_token_file_is_private_and_stable() {
    let (directory, state) = state().await;
    #[cfg(unix)]
    {
        let path = directory.path().join("daemon-token");
        let mode = fs::metadata(&path).expect("fichier").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(!state.token().is_empty());

    let reopened = state_in(directory.path()).await;
    assert_eq!(reopened.token(), state.token());
}

#[tokio::test]
async fn legacy_secrets_are_migrated_out_of_accounts_json() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;

    let text = fs::read_to_string(directory.path().join("accounts.json")).expect("fichier");
    assert!(!text.contains("secret-en-clair"), "{text}");
    assert!(!text.contains("\"password\":"), "{text}");

    let config = state.account("perso").await.expect("compte réhydraté");
    match config.auth {
        lavande_mail::config::AuthConfig::Password { password } => {
            assert_eq!(password, "secret-en-clair");
        }
        _ => panic!("authentification par mot de passe attendue"),
    }
}

#[tokio::test]
async fn add_account_keeps_secrets_out_of_the_file() {
    let (directory, state) = state().await;
    let config: lavande_mail::config::AccountConfig =
        serde_json::from_value(account("perso")).expect("config");
    state
        .add_account(&config, &[])
        .await
        .expect("compte ajouté");

    let text = fs::read_to_string(directory.path().join("accounts.json")).expect("fichier");
    assert!(!text.contains("secret-en-clair"), "{text}");
    assert!(directory.path().join("secrets.enc").exists());
    #[cfg(unix)]
    {
        let mode = fs::metadata(directory.path().join("secrets.key"))
            .expect("clé")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    let stored = state.secrets().get("perso").await.expect("secret");
    assert_eq!(
        stored,
        Some(lavande_mail_api::secrets::AccountSecrets::Password {
            password: "secret-en-clair".to_string()
        })
    );
}

#[tokio::test]
async fn remove_account_forgets_the_secret() {
    let (_directory, state) = state().await;
    let config: lavande_mail::config::AccountConfig =
        serde_json::from_value(account("perso")).expect("config");
    state
        .add_account(&config, &[])
        .await
        .expect("compte ajouté");
    assert!(state.remove_account("perso").await.expect("suppression"));
    assert_eq!(state.secrets().get("perso").await.expect("lecture"), None);
    assert!(state.account("perso").await.is_err());
}

#[tokio::test]
async fn calendar_sources_keep_their_credentials_in_the_secret_store() {
    let (directory, state) = state().await;
    let source = state
        .add_calendar_source(
            "Travail",
            "https://caldav.exemple.tld/dav/",
            Some("/dav/calendars/travail/".to_string()),
            lavande_mail_api::secrets::AccountSecrets::Caldav {
                username: "roman".to_string(),
                password: "secret-en-clair".to_string(),
            },
        )
        .await
        .expect("source ajoutée");
    assert_eq!(source.id, "travail");

    let path = directory.path().join("calendars.json");
    let text = fs::read_to_string(&path).expect("calendars.json");
    assert!(!text.contains("secret-en-clair"), "{text}");
    assert!(!text.contains("roman"), "{text}");
    assert!(!text.contains("password"), "{text}");
    assert!(text.contains("https://caldav.exemple.tld/dav/"), "{text}");
    #[cfg(unix)]
    {
        let mode = fs::metadata(&path).expect("fichier").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    assert_eq!(
        state
            .calendar_credentials("travail")
            .await
            .expect("identifiants"),
        ("roman".to_string(), "secret-en-clair".to_string())
    );
    assert_eq!(
        state.calendar_source("travail").expect("source").url,
        "https://caldav.exemple.tld/dav/"
    );
}

#[tokio::test]
async fn removing_a_calendar_source_forgets_its_credentials() {
    let (_directory, state) = state().await;
    state
        .add_calendar_source(
            "Travail",
            "https://caldav.exemple.tld/dav/",
            None,
            lavande_mail_api::secrets::AccountSecrets::Caldav {
                username: "roman".to_string(),
                password: "secret-en-clair".to_string(),
            },
        )
        .await
        .expect("source ajoutée");

    assert!(state
        .remove_calendar_source("travail")
        .await
        .expect("suppression"));
    assert!(state.calendar_sources().expect("sources").is_empty());
    assert_eq!(
        state.secrets().get("caldav:travail").await.expect("secret"),
        None
    );
    assert!(state.calendar_source("travail").is_err());
    assert!(!state
        .remove_calendar_source("travail")
        .await
        .expect("seconde suppression"));
}

#[tokio::test]
async fn a_calendar_source_without_its_secret_is_an_error() {
    let (_directory, state) = state().await;
    state
        .add_calendar_source(
            "Travail",
            "https://caldav.exemple.tld/dav/",
            None,
            lavande_mail_api::secrets::AccountSecrets::Caldav {
                username: "roman".to_string(),
                password: "secret-en-clair".to_string(),
            },
        )
        .await
        .expect("source ajoutée");
    state
        .secrets()
        .delete("caldav:travail")
        .await
        .expect("secret effacé");
    let error = state
        .calendar_credentials("travail")
        .await
        .expect_err("identifiants absents");
    assert!(error.message().contains("coffre"), "{error}");
}

#[tokio::test]
async fn a_corrupt_secret_file_is_an_error() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let mut stripped = account("perso");
    stripped["auth"] = json!({ "kind": "password" });
    seed(directory.path(), &[stripped]);
    fs::write(directory.path().join("secrets.enc"), b"pas-du-chiffre").expect("fichier");
    let state = state_in(directory.path()).await;
    let error = state.account("perso").await.expect_err("secret illisible");
    assert!(error.message().contains("corrompu"), "{error}");
}

#[tokio::test]
async fn the_keyring_starts_empty() {
    let (_directory, state) = state().await;
    let (status, body) = call(&state, get("/api/pgp/keys")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["keys"], json!([]));
}

#[tokio::test]
async fn a_generated_key_never_leaks_its_private_half() {
    let (directory, state) = state().await;
    let (status, body) = call(
        &state,
        post(
            "/api/pgp/keys/generate",
            &json!({ "name": "Roman", "email": "roman@lavande.mail" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let payload = json(&body);
    let key = &payload["key"];
    let fingerprint = key["fingerprint"].as_str().expect("empreinte").to_string();
    assert_eq!(fingerprint.len(), 40);
    assert_eq!(fingerprint.to_uppercase(), fingerprint);
    assert_eq!(key["user_id"], "Roman <roman@lavande.mail>");
    assert_eq!(key["name"], "Roman");
    assert_eq!(key["email"], "roman@lavande.mail");
    assert_eq!(key["has_secret"], true);
    assert_eq!(key["revoked"], false);
    assert_eq!(key["expired"], false);
    assert!(key["created_at"].is_string());
    let public_key = payload["public_key"].as_str().expect("clé publique");
    assert!(public_key.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----"));
    assert!(!public_key.contains("PRIVATE"));
    assert!(
        !String::from_utf8_lossy(&body).contains("PRIVATE KEY"),
        "jamais de clé privée dans la réponse"
    );

    let (_status, listed) = call(&state, get("/api/pgp/keys")).await;
    let keys = json(&listed)["keys"].as_array().expect("liste").clone();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["fingerprint"], fingerprint);

    let (status, exported) =
        call(&state, get(&format!("/api/pgp/keys/{fingerprint}/export"))).await;
    assert_eq!(status, StatusCode::OK);
    let exported = json(&exported);
    assert_eq!(exported["public_key"], public_key);

    let private = directory.path().join("pgp-keys.json");
    let text = fs::read_to_string(&private).expect("trousseau");
    assert!(!text.contains("PRIVATE KEY"), "{text}");
    #[cfg(unix)]
    {
        let mode = fs::metadata(&private)
            .expect("fichier")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(
        state
            .secrets()
            .get(&format!("pgp:{fingerprint}"))
            .await
            .expect("secret")
            .is_some(),
        "la clé privée vit dans le store de secrets"
    );
}

#[tokio::test]
async fn a_listed_key_reports_the_secret_it_stores() {
    let (directory, state) = state().await;
    let (generated, _public) = state
        .pgp()
        .generate("Roman", "roman@lavande.mail")
        .await
        .expect("génération");
    assert!(generated.has_secret);

    let listed = state.pgp().keys().expect("trousseau");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].fingerprint, generated.fingerprint);
    assert!(
        listed[0].has_secret,
        "la liste doit relire le drapeau stocké, pas la clé publique"
    );

    let (status, body) = call(&state, get("/api/pgp/keys")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["keys"][0]["has_secret"], true);

    let key_file = fs::read_to_string(directory.path().join("pgp-keys.json")).expect("trousseau");
    assert!(key_file.contains("\"has_secret\": true"), "{key_file}");

    let public_only = lavande_mail::pgp::generate_key("Camille", "camille@studio-lilas.fr")
        .expect("génération")
        .public_armored()
        .expect("clé publique");
    state.pgp().import(&public_only).await.expect("import");
    let listed = state.pgp().keys().expect("trousseau");
    assert_eq!(listed.len(), 2);
    let imported = listed
        .iter()
        .find(|key| key.email.as_deref() == Some("camille@studio-lilas.fr"))
        .expect("clé importée");
    assert!(!imported.has_secret, "clé publique seule : aucun secret");
    let kept = listed
        .iter()
        .find(|key| key.fingerprint == generated.fingerprint)
        .expect("clé générée");
    assert!(kept.has_secret, "la clé générée garde son secret");
}

#[tokio::test]
async fn an_imported_public_key_is_listed_and_exportable() {
    let (_directory, state) = state().await;
    let generated = state
        .pgp()
        .generate("Camille", "camille@studio-lilas.fr")
        .await
        .expect("génération");
    let public_key = generated.1;
    let fingerprint = generated.0.fingerprint;

    let (status, body) = call(
        &state,
        post("/api/pgp/keys/import", &json!({ "armored": public_key })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let key = json(&body)["key"].clone();
    assert_eq!(key["fingerprint"], fingerprint);
    assert_eq!(key["has_secret"], true, "l'import garde la clé secrète");
}

#[tokio::test]
async fn an_invalid_armored_key_is_a_400() {
    let (_directory, state) = state().await;
    let (status, body) = call(
        &state,
        post("/api/pgp/keys/import", &json!({ "armored": "pas une clé" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let payload = json(&body);
    assert_eq!(payload["kind"], "config");
    assert!(
        payload["error"]
            .as_str()
            .expect("message")
            .starts_with("clé PGP illisible"),
        "{payload}"
    );
}

#[tokio::test]
async fn an_invalid_address_is_a_400() {
    let (_directory, state) = state().await;
    let (status, body) = call(
        &state,
        post(
            "/api/pgp/keys/generate",
            &json!({ "name": "Roman", "email": "pas-une-adresse" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "config");
}

#[tokio::test]
async fn an_unknown_fingerprint_is_a_404() {
    let (_directory, state) = state().await;
    let unknown = "0".repeat(40);
    let (status, body) = call(&state, get(&format!("/api/pgp/keys/{unknown}/export"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(json(&body)["error"]
        .as_str()
        .expect("message")
        .contains("inconnue"));
    let (status, _) = call(&state, delete(&format!("/api/pgp/keys/{unknown}"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_deleted_key_leaves_the_keyring() {
    let (directory, state) = state().await;
    let (fingerprint, _public) = {
        let (key, public) = state
            .pgp()
            .generate("Roman", "roman@lavande.mail")
            .await
            .expect("génération");
        (key.fingerprint, public)
    };
    let (status, _) = call(&state, delete(&format!("/api/pgp/keys/{fingerprint}"))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_status, body) = call(&state, get("/api/pgp/keys")).await;
    assert_eq!(json(&body)["keys"], json!([]));
    assert_eq!(
        state
            .secrets()
            .get(&format!("pgp:{fingerprint}"))
            .await
            .expect("secret"),
        None
    );
    let text = fs::read_to_string(directory.path().join("pgp-keys.json")).expect("trousseau");
    assert!(!text.contains(&fingerprint), "{text}");
}

#[tokio::test]
async fn sending_a_signed_message_without_a_key_is_a_400() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let (status, body) = call(
        &state,
        post(
            "/api/accounts/perso/send",
            &json!({
                "to": [{ "email": "camille@studio-lilas.fr" }],
                "subject": "Planning",
                "text": "Bonjour",
                "pgp_sign": true
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json(&body)["error"],
        "Aucune clé secrète pour signer ce message"
    );
}

#[tokio::test]
async fn encrypting_to_a_recipient_without_a_key_lists_the_missing_one() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let (status, body) = call(
        &state,
        post(
            "/api/accounts/perso/send",
            &json!({
                "to": [{ "email": "camille@studio-lilas.fr" }],
                "cc": [{ "email": "marc@mail.fr" }],
                "subject": "Planning",
                "text": "Bonjour",
                "pgp_encrypt": true
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let message = json(&body)["error"].as_str().expect("message").to_string();
    assert!(message.contains("camille@studio-lilas.fr"), "{message}");
    assert!(message.contains("marc@mail.fr"), "{message}");
}

#[tokio::test]
async fn saving_a_draft_without_a_drafts_folder_is_a_400() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    let (status, body) = call(
        &state,
        post(
            "/api/accounts/perso/drafts",
            &json!({
                "to": [{ "email": "camille@studio-lilas.fr" }],
                "subject": "Planning",
                "text": "Bonjour"
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json(&body)["error"],
        "Aucun dossier Brouillons pour ce compte"
    );
}

fn encrypted_message(uid: u32) -> lavande_mail::model::Message {
    lavande_mail::model::Message {
        account_id: "perso".to_string(),
        folder_path: "INBOX".to_string(),
        uid,
        uidvalidity: 1,
        thread_id: "t1".to_string(),
        message_id: Some(format!("<m{uid}@x>")),
        in_reply_to: None,
        references: Vec::new(),
        from: lavande_mail::model::Address {
            name: Some("Camille".to_string()),
            email: "camille@studio-lilas.fr".to_string(),
        },
        to: Vec::new(),
        cc: Vec::new(),
        subject: "Chiffré".to_string(),
        date: None,
        flags: lavande_mail::model::Flags::default(),
        size: 512,
        pgp: lavande_mail::model::PgpState::Encrypted,
        pgp_detail: Some(lavande_mail::pgp::PgpDetail {
            verified: None,
            signer: None,
            decrypted: true,
            error: None,
        }),
        preview: "Bonjour Camille".to_string(),
        body_text: Some("Bonjour Camille".to_string()),
        body_html: None,
        attachments: Vec::new(),
    }
}

#[tokio::test]
async fn the_pgp_switch_is_per_account_and_closes_decrypted_bodies() {
    let (directory, state) = state().await;
    seed(directory.path(), &[account("perso")]);

    let (status, body) = call(&state, get("/api/accounts")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)[0]["pgp"], json!(true), "ouvert par défaut");

    state
        .store()
        .upsert_message(&encrypted_message(1))
        .expect("message");

    let (status, body) = call(
        &state,
        patch("/api/accounts/perso/pgp", &json!({ "enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps: {body:?}");
    let summary = json(&body);
    assert_eq!(summary["id"], "perso");
    assert_eq!(summary["label"], "Perso", "le reste du compte est intact");
    assert_eq!(summary["pgp"], json!(false));
    assert!(!state.store().pgp_enabled("perso").expect("interrupteur"));

    let stored = state
        .store()
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert!(
        stored.body_text.is_none(),
        "ce qui avait été déchiffré est effacé"
    );
    assert_eq!(stored.preview, "");
    assert_eq!(stored.pgp_detail, None);
    assert_eq!(
        stored.pgp,
        lavande_mail::model::PgpState::Encrypted,
        "le message reste chiffré"
    );

    let (status, body) = call(
        &state,
        patch("/api/accounts/perso/pgp", &json!({ "enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["pgp"], json!(true));
    assert!(state.store().pgp_enabled("perso").expect("interrupteur"));

    let (status, body) = call(
        &state,
        patch("/api/accounts/absent/pgp", &json!({ "enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn a_composition_body_above_two_megabytes_reaches_the_handler() {
    let (_directory, state) = state().await;
    let inline = "A".repeat(3 * 1024 * 1024);
    let (status, body) = call(
        &state,
        post(
            "/api/accounts/absent/send",
            &json!({
                "to": [{ "email": "camille@studio-lilas.fr" }],
                "subject": "Capture",
                "text": "Bonjour",
                "html": format!("<p>Bonjour</p>\n<img src=\"data:image/png;base64,{inline}\">"),
            }),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json(&body)["kind"], "store");
}

const ICS: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//Lavande//Tests//FR\r\n\
BEGIN:VEVENT\r\n\
UID:abc-123\r\n\
SUMMARY:Réunion équipe\r\n\
DTSTART:20240315T090000Z\r\n\
DTEND:20240315T100000Z\r\n\
LOCATION:Bureau\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:jour-6\r\n\
SUMMARY:Journée off\r\n\
DTSTART;VALUE=DATE:20240320\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

#[tokio::test]
async fn an_ics_payload_is_parsed_and_returns_wall_clock_events() {
    let (_directory, state) = state().await;
    let (status, body) = call(
        &state,
        post(
            "/api/calendars/ics",
            &json!({ "content": ICS, "source": "Google" }),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let events = json(&body);
    let events = events.as_array().expect("liste d'événements");
    assert_eq!(events.len(), 2);

    assert_eq!(events[0]["uid"], "abc-123");
    assert_eq!(events[0]["title"], "Réunion équipe");
    assert_eq!(events[0]["date"], "2024-03-15");
    assert_eq!(events[0]["start"], "09:00");
    assert_eq!(events[0]["end"], "10:00");
    assert_eq!(events[0]["all_day"], json!(false));
    assert_eq!(events[0]["timezone"], "UTC");
    assert_eq!(events[0]["location"], "Bureau");
    assert_eq!(events[0]["recurring"], json!(false));
    assert_eq!(events[0]["source"], "Google");

    assert_eq!(events[1]["uid"], "jour-6");
    assert_eq!(events[1]["date"], "2024-03-20");
    assert_eq!(events[1]["start"], Value::Null);
    assert_eq!(events[1]["end"], Value::Null);
    assert_eq!(events[1]["all_day"], json!(true));
    assert_eq!(events[1]["timezone"], Value::Null);
    assert_eq!(events[1]["source"], "Google");
}

#[tokio::test]
async fn calendar_import_requires_the_daemon_token() {
    let (_directory, state) = state().await;
    let request = post("/api/calendars/ics", &json!({ "content": ICS }));
    let (status, body) = call_bare(&state, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json(&body)["kind"], "auth");
}

#[tokio::test]
async fn an_invalid_calendar_is_a_400_kind_calendar() {
    let (_directory, state) = state().await;
    for payload in [
        json!({}),
        json!({ "content": "   " }),
        json!({ "content": "ceci n'est pas un calendrier" }),
        json!({ "content": "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n" }),
        json!({ "content": ICS, "url": "https://exemple.tld/calendrier.ics" }),
        json!({ "url": "pas une url" }),
        json!({ "url": "file:///etc/passwd" }),
    ] {
        let (status, body) = call(&state, post("/api/calendars/ics", &payload)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{payload} : {body:?}");
        assert_eq!(json(&body)["kind"], "calendar", "{payload}");
    }
}

#[tokio::test]
async fn an_unreachable_calendar_url_is_a_502() {
    let (_directory, state) = state().await;
    let (status, body) = call(
        &state,
        post(
            "/api/calendars/ics",
            &json!({ "url": "http://127.0.0.1:1/calendrier.ics" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body:?}");
    assert_eq!(json(&body)["kind"], "calendar");
}

#[tokio::test]
async fn search_refuses_an_invalid_date_or_flag() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    for uri in [
        "/api/accounts/perso/search?q=facture&before=2026-13-01",
        "/api/accounts/perso/search?q=facture&after=hier",
        "/api/accounts/perso/search?q=facture&unread=oui",
        "/api/accounts/perso/search?q=facture&has_attachment=1x",
    ] {
        let (status, body) = call(&state, get(uri)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(json(&body)["kind"], "search", "{uri}");
    }
}

#[tokio::test]
async fn search_answers_the_filtered_page_of_the_local_index() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed(directory.path(), &[account("perso")]);
    let state = state_in(directory.path()).await;
    state
        .store()
        .upsert_message(&text_message())
        .expect("message");

    let (status, body) = call(&state, get("/api/accounts/perso/search?q=soldes")).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(json(&body).as_array().expect("liste").len(), 1);

    for uri in [
        "/api/accounts/perso/search?q=soldes&unread=true",
        "/api/accounts/perso/search?q=soldes&folder=Sent",
        "/api/accounts/perso/search?q=soldes&before=2020-01-01",
        "/api/accounts/perso/search?q=absent",
        "/api/accounts/perso/search?q=%25",
    ] {
        let (status, body) = call(&state, get(uri)).await;
        assert_eq!(status, StatusCode::OK, "{uri} : {body:?}");
        assert!(json(&body).as_array().expect("liste").is_empty(), "{uri}");
    }

    let (status, body) = call(
        &state,
        get("/api/accounts/perso/search?folder=INBOX&from=camille&subject=soldes"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(json(&body).as_array().expect("liste").len(), 1);
}
