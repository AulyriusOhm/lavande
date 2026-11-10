//! OAuth2 de bout en bout contre GreenMail : fournisseur factice local, mais
//! vraie connexion IMAP/SMTP XOAUTH2 (GreenMail accepte le mot de passe comme
//! jeton d'accès).

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;

fn tls() -> TlsOptions {
    let path = std::env::var("MAIL_TEST_TLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").expect("HOME")).join(".cache/lavande/mail-test")
        });
    let pem = fs::read(path.join("cert.pem")).expect("certificat de test");
    TlsOptions {
        extra_roots_pem: vec![pem],
    }
}

fn state() -> (TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let state = AppState::open(directory.path(), tls()).expect("état");
    (directory, Arc::new(state))
}

async fn post(state: &Arc<AppState>, uri: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("requête");
    let response = app(state.clone()).oneshot(request).await.expect("réponse");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("corps");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn get(state: &Arc<AppState>, uri: &str) -> (StatusCode, String) {
    let request = Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("requête");
    let response = app(state.clone()).oneshot(request).await.expect("réponse");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("corps");
    (status, String::from_utf8_lossy(&bytes).to_string())
}

async fn fake_provider() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("écoute");
    let base = format!("http://{}", listener.local_addr().expect("adresse"));
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 4096];
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            let _ = &buffer[..read];
            let body = r#"{"access_token":"secret","refresh_token":"refresh-greenmail","expires_in":3600,"token_type":"Bearer"}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    base
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn the_whole_oauth_flow_creates_a_working_account() {
    let (_directory, state) = state();
    let provider = fake_provider().await;
    let input = json!({
        "provider": "custom",
        "email": "roman@lavande.test",
        "label": "GreenMail",
        "imap": { "host": "localhost", "port": 3993, "encryption": "tls" },
        "smtp": { "host": "localhost", "port": 3465, "encryption": "tls" },
        "client_id": "lavande-test",
        "scope": "email",
        "auth_endpoint": format!("{provider}/authorize"),
        "token_endpoint": format!("{provider}/token")
    });

    let (status, payload) = post(&state, "/api/oauth/start", input).await;
    assert_eq!(status, StatusCode::CREATED, "{payload}");
    let session = payload["session"].as_str().expect("session").to_string();
    let oauth_state = payload["auth_url"]
        .as_str()
        .expect("auth_url")
        .split("state=")
        .nth(1)
        .and_then(|rest| rest.split('&').next())
        .expect("state")
        .to_string();

    let (status, page) = get(
        &state,
        &format!("/api/oauth/callback?code=code-abc&state={oauth_state}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("Compte connecté"), "{page}");

    let (_, status_payload) = get(&state, &format!("/api/oauth/status?session={session}")).await;
    let parsed: Value = serde_json::from_str(&status_payload).expect("json");
    assert_eq!(parsed["status"], "done", "{parsed}");
    let account_id = parsed["account_id"]
        .as_str()
        .expect("account_id")
        .to_string();

    let (_, accounts) = get(&state, "/api/accounts").await;
    let listed: Value = serde_json::from_str(&accounts).expect("json");
    assert!(
        listed
            .as_array()
            .expect("liste")
            .iter()
            .any(|entry| entry["id"] == account_id.as_str()),
        "{listed}"
    );

    let (status, report) = post(
        &state,
        &format!("/api/accounts/{account_id}/sync"),
        json!({ "folder_path": "INBOX" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert!(
        report["reports"][0]["inserted"].as_u64().is_some(),
        "{report}"
    );
}
