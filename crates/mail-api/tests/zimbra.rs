//! Socle SOAP Zimbra : `GetInfo` d'un compte, servi par un faux Zimbra en
//! boucle locale et appelé par le routeur, sans réseau.

use std::fs;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::{AccountSecrets, SecretBackend};
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

const AUTH_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
    "Body":{"AuthResponse":{"_jsns":"urn:zimbraAccount","authToken":"jeton-1","lifetime":43199999}}}"#;

const INFO_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
    "Body":{"GetInfoResponse":{"_jsns":"urn:zimbraAccount",
    "name":"roman@exemple.tld","id":"7f2c","version":"9.0.0_GA_4642"}}}"#;

const REFUSED_ANSWER: &str = r#"{"Body":{"Fault":{"Reason":{"Text":"authentication failed for [roman]"},
    "Detail":{"Error":{"Code":"account.AUTH_FAILED"}}}}}"#;

const FAILURE_ANSWER: &str = r#"{"Body":{"Fault":{"Reason":{"Text":"service failure"},
    "Detail":{"Error":{"Code":"service.FAILURE"}}}}}"#;

/// Réponses du faux Zimbra : à l'`AuthRequest`, puis à l'appel authentifié.
#[derive(Clone)]
struct Zimbra {
    auth: &'static str,
    call: &'static str,
}

async fn soap_answer(State(zimbra): State<Zimbra>, body: String) -> Response {
    let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let answer = match request["Body"].get("AuthRequest") {
        Some(_) => zimbra.auth,
        None => zimbra.call,
    };
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        answer,
    )
        .into_response()
}

/// Faux serveur SOAP en boucle locale ; rend son hôte (`127.0.0.1:<port>`).
async fn serve(zimbra: Zimbra) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("écoute");
    let address = listener.local_addr().expect("adresse locale");
    let server = Router::new().fallback(any(soap_answer)).with_state(zimbra);
    tokio::spawn(async move {
        axum::serve(listener, server)
            .await
            .expect("serveur de test");
    });
    format!("127.0.0.1:{}", address.port())
}

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

fn account(id: &str, host: &str, email: &str) -> Value {
    json!({
        "id": id,
        "label": "Pro",
        "email": email,
        "username": email,
        "imap": { "host": host, "port": 993, "encryption": "tls" },
        "smtp": { "host": "smtp.exemple.tld", "port": 465, "encryption": "tls" },
        "auth": { "kind": "password", "password": "secret-en-clair" },
    })
}

async fn link_account(
    directory: &TempDir,
    state: &Arc<AppState>,
    account: Value,
    secrets: AccountSecrets,
) {
    let id = account["id"].as_str().expect("id").to_string();
    fs::write(
        directory.path().join("accounts.json"),
        serde_json::to_vec_pretty(&[account]).expect("json"),
    )
    .expect("accounts.json");
    state
        .secrets()
        .put(&id, &secrets)
        .await
        .expect("secret du compte");
}

async fn get(state: &Arc<AppState>, uri: &str) -> (StatusCode, Bytes) {
    let request = Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {}", state.token()))
        .body(Body::empty())
        .expect("requête");
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
    serde_json::from_slice(body).expect("JSON")
}

#[tokio::test]
async fn the_info_of_a_password_account_is_read() {
    let (directory, state) = state().await;
    let host = serve(Zimbra {
        auth: AUTH_ANSWER,
        call: INFO_ANSWER,
    })
    .await;
    link_account(
        &directory,
        &state,
        account("pro", &host, "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret-en-clair".to_string(),
        },
    )
    .await;

    let (status, body) = get(&state, "/api/accounts/pro/zimbra/info").await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let info = json(&body);
    assert_eq!(info["name"], "roman@exemple.tld");
    assert_eq!(info["id"], "7f2c");
    assert_eq!(info["version"], "9.0.0_GA_4642");
    let text = String::from_utf8_lossy(&body).to_string();
    assert!(!text.contains("jeton-1"), "{text}");
    assert!(!text.contains("secret-en-clair"), "{text}");
}

#[tokio::test]
async fn an_oauth_account_has_no_zimbra_info() {
    let (directory, state) = state().await;
    let mut oauth = account("gmail", "imap.gmail.com", "roman@gmail.com");
    oauth["auth"] = json!({
        "kind": "o_auth2",
        "client_id": "client",
        "token_endpoint": "https://oauth2.googleapis.com/token"
    });
    link_account(
        &directory,
        &state,
        oauth,
        AccountSecrets::OAuth2 {
            client_secret: "secret-client".to_string(),
            refresh_token: "secret-refresh".to_string(),
        },
    )
    .await;

    let (status, body) = get(&state, "/api/accounts/gmail/zimbra/info").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "zimbra");
}

#[tokio::test]
async fn a_refused_login_is_an_authentication_error() {
    let (directory, state) = state().await;
    let host = serve(Zimbra {
        auth: REFUSED_ANSWER,
        call: INFO_ANSWER,
    })
    .await;
    link_account(
        &directory,
        &state,
        account("pro", &host, "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret-en-clair".to_string(),
        },
    )
    .await;

    let (status, body) = get(&state, "/api/accounts/pro/zimbra/info").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "corps : {body:?}");
    let error = json(&body);
    assert_eq!(error["kind"], "auth");
    let message = error["error"].as_str().expect("message");
    assert!(message.contains("account.AUTH_FAILED"), "{message}");
    assert!(!message.contains("secret-en-clair"), "{message}");
}

#[tokio::test]
async fn a_refused_call_is_a_soap_gateway_error() {
    let (directory, state) = state().await;
    let host = serve(Zimbra {
        auth: AUTH_ANSWER,
        call: FAILURE_ANSWER,
    })
    .await;
    link_account(
        &directory,
        &state,
        account("pro", &host, "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret-en-clair".to_string(),
        },
    )
    .await;

    let (status, body) = get(&state, "/api/accounts/pro/zimbra/info").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "corps : {body:?}");
    let error = json(&body);
    assert_eq!(error["kind"], "soap");
    let message = error["error"].as_str().expect("message");
    assert!(message.starts_with("serveur Zimbra"), "{message}");
    assert!(!message.contains("secret-en-clair"), "{message}");
}

#[tokio::test]
async fn an_unknown_account_has_no_zimbra_info() {
    let (_directory, state) = state().await;
    let (status, body) = get(&state, "/api/accounts/inconnu/zimbra/info").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "corps : {body:?}");
}
