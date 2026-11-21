//! OAuth2 sans réseau : fournisseur d'autorisation factice local.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use lavande_mail::config::{AccountConfig, AuthConfig, Encryption, Endpoint};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
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
        .header("authorization", format!("Bearer {}", state.token()))
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
        .header("authorization", format!("Bearer {}", state.token()))
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
    serve_provider(200).await
}

/// Même fournisseur, qui refuse le code (`invalid_grant`).
async fn refusing_provider() -> String {
    serve_provider(400).await
}

/// Même fournisseur, avec un corps de refus sur mesure.
async fn rejecting_provider(status: u16, body: &'static str) -> String {
    serve_provider_with(move |_| (status, body.to_string())).await
}

/// Fournisseur qui refuse toute requête de jeton portant un `client_secret`.
async fn strict_provider() -> String {
    serve_provider_with(|request| {
        if request.contains("client_secret=") {
            (
                400,
                r#"{"error":"invalid_request","error_description":"client_secret must be absent"}"#
                    .to_string(),
            )
        } else {
            (200, TOKEN_BODY.to_string())
        }
    })
    .await
}

/// Point d'écoute fermé : l'échange échoue sur le transport, sans réseau.
async fn closed_endpoint() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("écoute");
    let base = format!("http://{}", listener.local_addr().expect("adresse"));
    drop(listener);
    base
}

const TOKEN_BODY: &str = r#"{"access_token":"secret","refresh_token":"refresh-123","expires_in":3600,"token_type":"Bearer"}"#;

/// `{"email":"autre@gmail.com","email_verified":true}`
const ID_TOKEN_OTHER_ACCOUNT: &str =
    "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImF1dHJlQGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlfQ.c2ln";

/// `{"email":"Roman@Lavande.Test"}`
const ID_TOKEN_SAME_ACCOUNT: &str =
    "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6IlJvbWFuQExhdmFuZGUuVGVzdCJ9.c2ln";

fn token_body(id_token: &str) -> String {
    json!({
        "access_token": "secret",
        "refresh_token": "refresh-123",
        "expires_in": 3600,
        "token_type": "Bearer",
        "id_token": id_token
    })
    .to_string()
}

async fn serve_provider(token_status: u16) -> String {
    serve_provider_with(move |_| {
        let body = if token_status == 200 {
            TOKEN_BODY
        } else {
            r#"{"error":"invalid_grant"}"#
        };
        (token_status, body.to_string())
    })
    .await
}

async fn serve_provider_with<F>(token_reply: F) -> String
where
    F: Fn(&str) -> (u16, String) + Send + 'static,
{
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
                let (token_status, body) = token_reply(&request);
                let reason = if token_status == 200 {
                    "OK"
                } else {
                    "Bad Request"
                };
                format!(
                    "HTTP/1.1 {token_status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            };
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    base
}

/// Déroule le consentement jusqu'à `code_received` et rend l'identifiant de
/// session, prêt pour `/api/oauth/complete`.
async fn consent(state: &Arc<AppState>, token_endpoint: &str, auth_endpoint: &str) -> String {
    consent_with(state, account_input(token_endpoint, auth_endpoint)).await
}

async fn consent_with(state: &Arc<AppState>, input: Value) -> String {
    let (status, payload) = post(state, "/api/oauth/start", input).await;
    assert_eq!(status, StatusCode::CREATED, "{payload}");
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
        state,
        &format!("/api/oauth/callback?code=code-abc&state={state_param}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("Consentement enregistré"), "{page}");
    session
}

async fn complete(state: &Arc<AppState>, session: &str) -> Value {
    let (status, payload) = post(state, "/api/oauth/complete", json!({ "session": session })).await;
    assert_eq!(status, StatusCode::OK, "{payload}");
    payload
}

#[tokio::test]
async fn start_returns_a_pkce_authorization_url() {
    let (_directory, state) = state().await;
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
    let (directory, state) = state().await;
    let provider = fake_provider().await;
    let session = consent(
        &state,
        &format!("{provider}/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");

    let (_, status_payload) = get(&state, &format!("/api/oauth/status?session={session}")).await;
    let parsed: Value = serde_json::from_str(&status_payload).expect("json");
    assert_eq!(parsed["status"], "failed", "{parsed}");

    assert!(
        std::fs::read(directory.path().join("accounts.json")).is_err(),
        "un compte a été écrit malgré l'échec"
    );
}

#[tokio::test]
async fn a_network_failure_of_the_exchange_keeps_the_session_on_code_received() {
    let (_directory, state) = state().await;
    let closed = closed_endpoint().await;
    let provider = fake_provider().await;
    let session = consent(
        &state,
        &format!("{closed}/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    for attempt in 0..20 {
        let completed = complete(&state, &session).await;
        assert_eq!(
            completed["status"], "code_received",
            "tentative {attempt}: {completed}"
        );
    }

    let exhausted = complete(&state, &session).await;
    assert_eq!(exhausted["status"], "failed", "{exhausted}");
}

#[tokio::test]
async fn a_refused_code_fails_the_session_without_any_retry() {
    let (_directory, state) = state().await;
    let provider = refusing_provider().await;
    let session = consent(
        &state,
        &format!("{provider}/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(error.contains("refusé"), "{completed}");
    assert!(error.contains("invalid_grant"), "{completed}");

    let replay = complete(&state, &session).await;
    assert_eq!(replay["status"], "failed", "{replay}");
}

#[tokio::test]
async fn a_rejected_client_explains_why_in_the_provider_words() {
    let (_directory, state) = state().await;
    let provider = rejecting_provider(
        401,
        r#"{"error":"invalid_client","error_description":"The provided client secret is invalid."}"#,
    )
    .await;
    let session = consent(
        &state,
        &format!("{provider}/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(error.contains("invalid_client"), "{completed}");
    assert!(error.contains("client secret is invalid"), "{completed}");
}

#[tokio::test]
async fn an_empty_client_secret_is_never_sent_to_the_provider() {
    let (_directory, state) = state().await;
    let provider = strict_provider().await;
    let mut input = account_input(
        &format!("{provider}/token"),
        &format!("{provider}/authorize"),
    );
    input["client_secret"] = json!("");
    let session = consent_with(&state, input).await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(!error.contains("refusé"), "{completed}");
}

#[tokio::test]
async fn a_denied_consent_marks_the_session_failed() {
    let (_directory, state) = state().await;
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
    let (_directory, state) = state().await;
    let (status, page) = get(&state, "/api/oauth/callback?code=abc&state=inconnu").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(page.contains("expiré"), "{page}");
}

#[tokio::test]
async fn a_provider_without_client_id_is_a_config_error() {
    let (_directory, state) = state().await;
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
    let (_directory, state) = state().await;
    let (status, _) = get(&state, "/api/oauth/status?session=inconnue").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_consent_for_another_account_never_creates_it() {
    let (directory, state) = state().await;
    let provider = serve_provider_with(|_| (200, token_body(ID_TOKEN_OTHER_ACCOUNT))).await;
    let session = consent(
        &state,
        &format!("{provider}/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(error.contains("autre@gmail.com"), "{completed}");
    assert!(error.contains("roman@lavande.test"), "{completed}");
    assert!(
        std::fs::read(directory.path().join("accounts.json")).is_err(),
        "un compte a été écrit malgré le compte autorisé différent"
    );
}

#[tokio::test]
async fn a_consent_for_the_expected_account_in_another_case_succeeds() {
    let (_directory, state) = state().await;
    let provider = serve_provider_with(|_| (200, token_body(ID_TOKEN_SAME_ACCOUNT))).await;
    let session = consent(
        &state,
        &format!("{provider}/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(error.contains("serveur IMAP"), "{completed}");
    assert!(!error.contains("ne correspond pas"), "{completed}");
}

#[tokio::test]
async fn a_consent_without_an_id_token_is_not_blocked() {
    let (_directory, state) = state().await;
    let provider = fake_provider().await;
    let session = consent(
        &state,
        &format!("{provider}/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(error.contains("serveur IMAP"), "{completed}");
    assert!(!error.contains("ne correspond pas"), "{completed}");
}

#[tokio::test]
async fn a_google_consent_without_the_gmail_permission_is_refused() {
    let (_directory, state) = state().await;
    let provider = serve_provider_with(|request| {
        if request.contains("/tokeninfo") {
            (
                200,
                r#"{"email":"roman@lavande.test","scope":"openid email https://www.googleapis.com/auth/calendar"}"#
                    .to_string(),
            )
        } else {
            (200, token_body(ID_TOKEN_SAME_ACCOUNT))
        }
    })
    .await;
    let session = consent(
        &state,
        &format!("{provider}/googleapis.com/token"),
        &format!("{provider}/authorize"),
    )
    .await;

    let completed = complete(&state, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(error.contains("permission Gmail"), "{completed}");
}

/// Compte OAuth2 déjà présent, avec un refresh token périmé : l'état d'un compte
/// Google dont l'autorisation a expiré au bout de sept jours.
async fn seed_oauth_account(state: &Arc<AppState>, token_endpoint: &str, email: &str) -> String {
    let config = AccountConfig {
        id: "roman-lavande-test".to_string(),
        label: "GreenMail".to_string(),
        email: email.to_string(),
        username: email.to_string(),
        imap: Endpoint {
            host: "127.0.0.1".to_string(),
            port: 9999,
            encryption: Encryption::Tls,
        },
        smtp: Endpoint {
            host: "127.0.0.1".to_string(),
            port: 9998,
            encryption: Encryption::Tls,
        },
        auth: AuthConfig::OAuth2 {
            client_id: "lavande-test".to_string(),
            client_secret: "secret-precedent".to_string(),
            refresh_token: "refresh-precedent".to_string(),
            token_endpoint: token_endpoint.to_string(),
        },
        synced_folders: None,
    };
    state.add_account(&config, &[]).await.expect("compte");
    config.id
}

async fn seed_password_account(state: &Arc<AppState>) -> String {
    let config = AccountConfig {
        id: "perso".to_string(),
        label: "Perso".to_string(),
        email: "roman@lavande.test".to_string(),
        username: "roman@lavande.test".to_string(),
        imap: Endpoint {
            host: "127.0.0.1".to_string(),
            port: 9999,
            encryption: Encryption::Tls,
        },
        smtp: Endpoint {
            host: "127.0.0.1".to_string(),
            port: 9998,
            encryption: Encryption::Tls,
        },
        auth: AuthConfig::Password {
            password: "secret-en-clair".to_string(),
        },
        synced_folders: None,
    };
    state.add_account(&config, &[]).await.expect("compte");
    config.id
}

async fn refresh_token_of(state: &Arc<AppState>, id: &str) -> String {
    match state.secrets().get(id).await.expect("secret") {
        Some(lavande_mail_api::secrets::AccountSecrets::OAuth2 { refresh_token, .. }) => {
            refresh_token
        }
        other => panic!("secret OAuth2 attendu : {other:?}"),
    }
}

/// Suite du consentement pour une session déjà ouverte : `code` sur le retour
/// loopback, puis `complete`. Rend la charge de `complete`.
async fn consent_and_complete(state: &Arc<AppState>, auth_url: &str, session: &str) -> Value {
    let state_param = auth_url
        .split("state=")
        .nth(1)
        .and_then(|rest| rest.split('&').next())
        .expect("state")
        .to_string();
    let (status, page) = get(
        state,
        &format!("/api/oauth/callback?code=code-abc&state={state_param}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Consentement enregistré"), "{page}");
    complete(state, session).await
}

#[tokio::test]
async fn a_reconnect_replays_the_consent_for_the_existing_account() {
    let (_directory, state) = state().await;
    let provider = fake_provider().await;
    let id = seed_oauth_account(
        &state,
        &format!("{provider}/googleapis.com/token"),
        "roman@lavande.test",
    )
    .await;
    state.mark_reauth_required(&id).await.expect("marque");

    let (status, started) = post(&state, "/api/oauth/reconnect", json!({ "account_id": id })).await;
    assert_eq!(status, StatusCode::CREATED, "{started}");
    let auth_url = started["auth_url"].as_str().expect("auth_url");
    for fragment in [
        "response_type=code",
        "code_challenge_method=S256",
        "client_id=lavande-test",
        "state=",
    ] {
        assert!(
            auth_url.contains(fragment),
            "« {fragment} » absent de {auth_url}"
        );
    }
    let session = started["session"].as_str().expect("session").to_string();

    let completed = consent_and_complete(&state, auth_url, &session).await;
    // Hors GreenMail la sonde IMAP échoue : aucun secret n'est écrit avant elle.
    assert_eq!(completed["status"], "failed", "{completed}");
    assert!(
        completed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("serveur IMAP"),
        "{completed}"
    );
    assert_eq!(
        refresh_token_of(&state, &id).await,
        "refresh-precedent",
        "un échange non validé par IMAP ne remplace pas le jeton"
    );

    let (_, listed) = get(&state, "/api/accounts").await;
    let accounts: Value = serde_json::from_str(&listed).expect("json");
    let entries = accounts.as_array().expect("liste");
    assert_eq!(entries.len(), 1, "{accounts}");
    assert_eq!(entries[0]["auth_kind"], "oauth2", "{accounts}");
    assert_eq!(entries[0]["needs_reauth"], true, "{accounts}");
}

#[tokio::test]
async fn a_reconnect_for_another_account_never_replaces_the_token() {
    let (_directory, state) = state().await;
    let provider = serve_provider_with(|_| (200, token_body(ID_TOKEN_OTHER_ACCOUNT))).await;
    let id = seed_oauth_account(
        &state,
        &format!("{provider}/googleapis.com/token"),
        "roman@lavande.test",
    )
    .await;
    state.mark_reauth_required(&id).await.expect("marque");

    let (status, started) = post(&state, "/api/oauth/reconnect", json!({ "account_id": id })).await;
    assert_eq!(status, StatusCode::CREATED, "{started}");
    let auth_url = started["auth_url"].as_str().expect("auth_url").to_string();
    let session = started["session"].as_str().expect("session").to_string();

    let completed = consent_and_complete(&state, &auth_url, &session).await;
    assert_eq!(completed["status"], "failed", "{completed}");
    let error = completed["error"].as_str().unwrap_or_default();
    assert!(error.contains("autre@gmail.com"), "{completed}");
    assert_eq!(refresh_token_of(&state, &id).await, "refresh-precedent");
}

#[tokio::test]
async fn a_reconnect_without_the_account_is_a_404() {
    let (_directory, state) = state().await;
    let (status, payload) = post(
        &state,
        "/api/oauth/reconnect",
        json!({ "account_id": "absent" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{payload}");
    assert_eq!(payload["kind"], "config", "{payload}");
}

#[tokio::test]
async fn a_reconnect_of_a_password_account_is_refused() {
    let (_directory, state) = state().await;
    let id = seed_password_account(&state).await;
    let (status, payload) = post(&state, "/api/oauth/reconnect", json!({ "account_id": id })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert_eq!(payload["kind"], "config", "{payload}");
    assert!(
        payload["error"]
            .as_str()
            .unwrap_or_default()
            .contains("n'utilise pas OAuth2"),
        "{payload}"
    );
}

#[tokio::test]
async fn a_reconnect_of_a_custom_provider_explains_what_to_do() {
    let (_directory, state) = state().await;
    let id = seed_oauth_account(&state, "https://exemple.test/token", "roman@lavande.test").await;
    let (status, payload) = post(&state, "/api/oauth/reconnect", json!({ "account_id": id })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert_eq!(payload["kind"], "config", "{payload}");
    assert_eq!(
        payload["error"],
        "reconnexion automatique non disponible pour ce fournisseur ; retire le compte puis \
         reconnecte-le",
        "{payload}"
    );
}

/// Le fournisseur est déduit du point de jeton : un compte Google doit recevoir
/// l'URL Google et le périmètre Gmail, pas ceux du dernier compte ajouté.
#[tokio::test]
async fn a_google_reconnect_asks_for_the_google_endpoints() {
    let (_directory, state) = state().await;
    let provider = fake_provider().await;
    let id = seed_oauth_account(
        &state,
        &format!("{provider}/googleapis.com/token"),
        "roman@lavande.test",
    )
    .await;

    let (status, started) = post(&state, "/api/oauth/reconnect", json!({ "account_id": id })).await;
    assert_eq!(status, StatusCode::CREATED, "{started}");
    let auth_url = started["auth_url"].as_str().expect("auth_url");
    assert!(auth_url.contains("access_type=offline"), "{auth_url}");
    assert!(auth_url.contains("prompt=consent"), "{auth_url}");
    assert!(
        auth_url.contains("mail.google.com"),
        "périmètre Gmail attendu : {auth_url}"
    );
}
