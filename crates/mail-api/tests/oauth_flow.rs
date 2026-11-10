//! OAuth2 sans réseau : fournisseur d'autorisation factice local.

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

fn state() -> (TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let state = AppState::open(directory.path(), TlsOptions::default()).expect("état");
    (directory, Arc::new(state))
}

fn account_input(token_endpoint: &str, auth_endpoint: &str) -> Value {
    json!({
        "provider": "custom",
        "email": "roman@lavande.test",
        "label": "GreenMail",
        "imap": { "host": "127.0.0.1", "port": 9999, "encryption": "tls" },
        "smtp": { "host": "127.0.0.1", "port": 9998, "encryption": "tls" },
        "client_id": "lavande-test",
        "token_endpoint": token_endpoint,
        "auth_endpoint": auth_endpoint
    })
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

/// Fournisseur d'autorisation minimal : `/authorize` redirige avec un code,
/// `/token` renvoie un jeton d'accès et un refresh token.
async fn fake_provider() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("écoute");
    let base = format!("http://{}", listener.local_addr().expect("adresse"));
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 4096];
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let first = request.lines().next().unwrap_or_default().to_string();
            let reply = if first.starts_with("GET /authorize") {
                let state = request
                    .split("state=")
                    .nth(1)
                    .and_then(|rest| rest.split(['&', ' ']).next())
                    .unwrap_or_default()
                    .to_string();
                let location = format!("/api/oauth/callback?code=code-abc&state={state}");
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
            } else {
                let body = r#"{"access_token":"secret","refresh_token":"refresh-123","expires_in":3600,"token_type":"Bearer"}"#;
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            };
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    base
}

#[tokio::test]
async fn start_returns_a_pkce_authorization_url() {
    let (_directory, state) = state();
    let provider = fake_provider().await;
    let (status, payload) = post(
        &state,
        "/api/oauth/start",
        account_input(
            &format!("{provider}/token"),
            &format!("{provider}/authorize"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{payload}");
    let url = payload["auth_url"].as_str().expect("auth_url");
    for fragment in [
        "response_type=code",
        "code_challenge_method=S256",
        "code_challenge=",
        "state=",
        "client_id=lavande-test",
        "redirect_uri=",
    ] {
        assert!(url.contains(fragment), "« {fragment} » absent de {url}");
    }
    assert_eq!(
        payload["redirect_uri"].as_str(),
        Some("http://127.0.0.1:8790/api/oauth/callback")
    );
}

#[tokio::test]
async fn a_broken_imap_leaves_no_account_and_a_failed_session() {
    let (directory, state) = state();
    let provider = fake_provider().await;
    let (status, payload) = post(
        &state,
        "/api/oauth/start",
        account_input(
            &format!("{provider}/token"),
            &format!("{provider}/authorize"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{payload}");
    let session = payload["session"].as_str().expect("session").to_string();
    let auth_url = payload["auth_url"].as_str().expect("auth_url");
    let state_param = auth_url
        .split("state=")
        .nth(1)
        .and_then(|rest| rest.split('&').next())
        .expect("state")
        .to_string();

    let (status, page) = get(
        &state,
        &format!("/api/oauth/callback?code=code-abc&state={state_param}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("Connexion refusée"), "{page}");

    let (status, status_payload) =
        get(&state, &format!("/api/oauth/status?session={session}")).await;
    assert_eq!(status, StatusCode::OK);
    let parsed: Value = serde_json::from_str(&status_payload).expect("json");
    assert_eq!(parsed["status"], "failed", "{parsed}");

    assert!(
        std::fs::read(directory.path().join("accounts.json")).is_err(),
        "un compte a été écrit malgré l'échec"
    );
}

#[tokio::test]
async fn a_denied_consent_marks_the_session_failed() {
    let (_directory, state) = state();
    let provider = fake_provider().await;
    let (_, payload) = post(
        &state,
        "/api/oauth/start",
        account_input(
            &format!("{provider}/token"),
            &format!("{provider}/authorize"),
        ),
    )
    .await;
    let session = payload["session"].as_str().expect("session").to_string();
    let state_param = payload["auth_url"]
        .as_str()
        .expect("auth_url")
        .split("state=")
        .nth(1)
        .and_then(|rest| rest.split('&').next())
        .expect("state")
        .to_string();

    let (status, page) = get(
        &state,
        &format!("/api/oauth/callback?error=access_denied&state={state_param}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("refusée"), "{page}");

    let (_, status_payload) = get(&state, &format!("/api/oauth/status?session={session}")).await;
    let parsed: Value = serde_json::from_str(&status_payload).expect("json");
    assert_eq!(parsed["status"], "failed", "{parsed}");
}

#[tokio::test]
async fn an_unknown_state_is_rejected() {
    let (_directory, state) = state();
    let (status, page) = get(&state, "/api/oauth/callback?code=abc&state=inconnu").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(page.contains("expiré"), "{page}");
}

#[tokio::test]
async fn a_provider_without_client_id_is_a_config_error() {
    let (_directory, state) = state();
    let mut input = account_input(
        "https://example.invalid/token",
        "https://example.invalid/auth",
    );
    input["provider"] = json!("google");
    input.as_object_mut().expect("objet").remove("client_id");
    let (status, payload) = post(&state, "/api/oauth/start", input).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert_eq!(payload["kind"], "config", "{payload}");
}

#[tokio::test]
async fn an_unknown_session_is_a_404() {
    let (_directory, state) = state();
    let (status, _) = get(&state, "/api/oauth/status?session=inconnue").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
