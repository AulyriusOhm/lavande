//! `/api/sync/secrets…`: la clé privée de l'appareil et les jetons de session de
//! la synchronisation E2EE vivent dans le coffre du démon, jamais dans un
//! `accounts.json` ni dans une réponse non authentifiée.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

const DEVICE: &str = "/api/sync/secrets/device";
const ACCOUNT: &str = "/api/sync/secrets/accounts/user-1";

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

fn request(method: &str, uri: &str, payload: Option<&Value>) -> Request<Body> {
    let builder = Request::builder().method(method).uri(uri);
    match payload {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .expect("requête"),
        None => builder.body(Body::empty()).expect("requête"),
    }
}

async fn call(state: &Arc<AppState>, request: Request<Body>) -> (StatusCode, Bytes) {
    let mut request = request;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", state.token())
            .parse()
            .expect("en-tête"),
    );
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

fn text(body: &Bytes) -> String {
    String::from_utf8(body.to_vec()).expect("utf-8")
}

async fn read_json(state: &Arc<AppState>, uri: &str) -> Value {
    json(&call(state, request("GET", uri, None)).await.1)
}

#[tokio::test]
async fn device_key_is_absent_until_written() {
    let (_directory, state) = state().await;
    let (status, body) = call(&state, request("GET", DEVICE, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["private_key"], Value::Null);
}

#[tokio::test]
async fn device_key_round_trips_through_the_vault() {
    let (_directory, state) = state().await;
    let key = "a".repeat(43);
    let (status, _) = call(
        &state,
        request("PUT", DEVICE, Some(&json!({ "private_key": key }))),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = call(&state, request("GET", DEVICE, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["private_key"], key);

    let (status, body) = call(
        &state,
        request("PUT", DEVICE, Some(&json!({ "private_key": "" }))),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "sync");
    assert_eq!(read_json(&state, DEVICE).await["private_key"], key);
}

#[tokio::test]
async fn account_token_round_trips_and_is_removed() {
    let (_directory, state) = state().await;
    let (status, _) = call(
        &state,
        request("PUT", ACCOUNT, Some(&json!({ "token": "session-1" }))),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(read_json(&state, ACCOUNT).await["token"], "session-1");

    let (status, _) = call(&state, request("DELETE", ACCOUNT, None)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = call(&state, request("GET", ACCOUNT, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["token"], Value::Null);
}

#[tokio::test]
async fn an_invalid_account_id_is_a_400() {
    let (_directory, state) = state().await;
    let (status, body) = call(
        &state,
        request(
            "PUT",
            "/api/sync/secrets/accounts/bad%20id",
            Some(&json!({ "token": "x" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json(&body)["kind"], "sync");
}

#[tokio::test]
async fn secrets_never_leave_without_the_daemon_token() {
    let (_directory, state) = state().await;
    call(
        &state,
        request("PUT", DEVICE, Some(&json!({ "private_key": "cle-privee" }))),
    )
    .await;
    let response = app(state.clone())
        .oneshot(request("GET", DEVICE, None))
        .await
        .expect("le routeur répond");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn secrets_are_not_written_in_the_data_directory_in_clear() {
    let (directory, state) = state().await;
    call(
        &state,
        request("PUT", DEVICE, Some(&json!({ "private_key": "cle-privee" }))),
    )
    .await;
    call(
        &state,
        request("PUT", ACCOUNT, Some(&json!({ "token": "jeton-session" }))),
    )
    .await;

    let mut entries = 0;
    for entry in std::fs::read_dir(directory.path()).expect("répertoire") {
        let path = entry.expect("entrée").path();
        if !path.is_file() {
            continue;
        }
        entries += 1;
        let bytes = std::fs::read(&path).expect("lecture");
        let content = String::from_utf8_lossy(&bytes);
        assert!(!content.contains("cle-privee"), "{}", path.display());
        assert!(!content.contains("jeton-session"), "{}", path.display());
    }
    assert!(entries > 0, "le coffre doit exister sur disque");
}

#[tokio::test]
async fn an_answer_never_carries_another_secret() {
    let (_directory, state) = state().await;
    call(
        &state,
        request("PUT", DEVICE, Some(&json!({ "private_key": "cle-privee" }))),
    )
    .await;
    call(
        &state,
        request("PUT", ACCOUNT, Some(&json!({ "token": "jeton-session" }))),
    )
    .await;
    let device = text(&call(&state, request("GET", DEVICE, None)).await.1);
    assert!(device.contains("cle-privee"), "{device}");
    assert!(!device.contains("jeton-session"), "{device}");
    let account = text(&call(&state, request("GET", ACCOUNT, None)).await.1);
    assert!(account.contains("jeton-session"), "{account}");
    assert!(!account.contains("cle-privee"), "{account}");
}
