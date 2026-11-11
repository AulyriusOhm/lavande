//! Offline HTTP tests: the router is driven directly, no socket, no network.

use std::fs;
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
    assert!(!text.contains("password"), "{text}");
    assert!(!text.contains("auth"), "{text}");
    let payload = json(&body);
    assert_eq!(payload[0]["id"], "perso");
    assert_eq!(payload[0]["username"], "roman@lavande.mail");
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
async fn the_token_file_is_private_and_stable() {
    let (directory, state) = state().await;
    let path = directory.path().join("daemon-token");
    let mode = fs::metadata(&path).expect("fichier").permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
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
    let mode = fs::metadata(directory.path().join("secrets.key"))
        .expect("clé")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);

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
