//! `/api/ai`: device flow GitHub Copilot et proxy chat, contre un GitHub factice.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::copilot::{CopilotTokens, Settings, EDITOR_VERSION};
use lavande_mail_api::secrets::{AccountSecrets, SecretBackend};
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;

struct Fake {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    fn count(&self, start: &str) -> usize {
        self.requests()
            .iter()
            .filter(|request| request.starts_with(start))
            .count()
    }

    fn find(&self, start: &str) -> String {
        let requests = self.requests();
        requests
            .iter()
            .find(|request| request.starts_with(start))
            .cloned()
            .unwrap_or_else(|| panic!("aucune requête « {start} » : {requests:?}"))
    }
}

fn path(request: &str) -> &str {
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|target| target.split('?').next())
        .unwrap_or_default()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    }
}

async fn read_request(socket: &mut TcpStream) -> String {
    let mut received = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let read = socket.read(&mut buffer).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        received.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&received).to_string();
        let Some((headers, body)) = text.split_once("\r\n\r\n") else {
            continue;
        };
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap_or(0))
            })
            .unwrap_or(0);
        if body.len() >= length {
            break;
        }
    }
    String::from_utf8_lossy(&received).to_string()
}

async fn serve<F>(reply: F) -> Fake
where
    F: Fn(&str) -> (u16, String) + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("écoute");
    let base = format!("http://{}", listener.local_addr().expect("adresse"));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    let reply = Arc::new(reply);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let reply = reply.clone();
            let log = log.clone();
            tokio::spawn(async move {
                let request = read_request(&mut socket).await;
                log.lock().unwrap().push(request.clone());
                let (status, body) = reply(&request);
                let head = format!(
                    "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reason(status),
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    Fake { base, requests }
}

/// GitHub qui accepte les connexions sans jamais répondre : le proxy doit
/// abandonner seul.
async fn serve_silent() -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("écoute");
    let base = format!("http://{}", listener.local_addr().expect("adresse"));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let request = read_request(&mut socket).await;
                log.lock().unwrap().push(request);
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
        }
    });
    Fake { base, requests }
}

async fn state(settings: Settings) -> (TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let mut state = AppState::open_with(
        directory.path(),
        TlsOptions::default(),
        Default::default(),
        SecretBackend::File,
    )
    .await
    .expect("état");
    state.set_copilot(settings);
    (directory, Arc::new(state))
}

fn settings(fake: &Fake) -> Settings {
    Settings {
        github: fake.base.clone(),
        api: fake.base.clone(),
        copilot: fake.base.clone(),
        chat_timeout: Duration::from_secs(5),
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("horloge")
        .as_secs() as i64
}

async fn connected(state: &Arc<AppState>, expires_at: i64, copilot_token: Option<&str>) {
    state
        .set_copilot_tokens(&CopilotTokens {
            github_token: "gh-token".to_string(),
            copilot_token: copilot_token.map(str::to_string),
            expires_at: Some(expires_at),
            login: Some("roman".to_string()),
        })
        .await
        .expect("secret stocké");
}

async fn call(state: &Arc<AppState>, request: Request<Body>) -> (StatusCode, String) {
    let response = app(state.clone())
        .oneshot(request)
        .await
        .expect("le routeur répond");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("corps");
    (status, String::from_utf8_lossy(&bytes).to_string())
}

async fn post(state: &Arc<AppState>, uri: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", state.token()))
        .body(Body::from(body.to_string()))
        .expect("requête");
    let (status, text) = call(state, request).await;
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

async fn get_raw(state: &Arc<AppState>, uri: &str) -> (StatusCode, String) {
    let request = Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {}", state.token()))
        .body(Body::empty())
        .expect("requête");
    call(state, request).await
}

async fn get(state: &Arc<AppState>, uri: &str) -> (StatusCode, Value) {
    let (status, text) = get_raw(state, uri).await;
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

const DEVICE_CODE: &str = r#"{"device_code":"dev-123","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#;

fn authorized() -> String {
    json!({ "access_token": "gh-token", "token_type": "bearer", "scope": "read:user" }).to_string()
}

fn copilot(expires_at: i64) -> String {
    json!({ "token": "copilot-token", "expires_at": expires_at }).to_string()
}

fn chat_answer() -> String {
    json!({
        "choices": [{ "message": { "role": "assistant", "content": "Bonjour" }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 12, "completion_tokens": 3 }
    })
    .to_string()
}

async fn started(state: &Arc<AppState>) -> String {
    let (status, payload) = post(state, "/api/ai/copilot/start", json!({})).await;
    assert_eq!(status, StatusCode::CREATED, "{payload}");
    payload["session"].as_str().expect("session").to_string()
}

async fn status(state: &Arc<AppState>, session: &str) -> (StatusCode, Value) {
    get(state, &format!("/api/ai/copilot/status?session={session}")).await
}

#[tokio::test]
async fn start_sends_the_public_client_id_and_a_read_user_scope() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;

    let (status, payload) = post(&state, "/api/ai/copilot/start", json!({})).await;

    assert_eq!(status, StatusCode::CREATED, "{payload}");
    assert!(
        payload["session"]
            .as_str()
            .is_some_and(|value| !value.is_empty()),
        "{payload}"
    );
    assert_eq!(
        payload["verification_uri"],
        "https://github.com/login/device"
    );
    assert_eq!(payload["user_code"], "ABCD-1234");
    assert_eq!(payload["interval"], 5);
    assert_eq!(payload["expires_in"], 900);
    let request = fake.find("POST /login/device/code");
    assert!(
        request.contains("client_id=Iv1.b507a08c87ecfe98"),
        "{request}"
    );
    assert!(request.contains("scope=read%3Auser"), "{request}");
    assert!(
        request.to_lowercase().contains("accept: application/json"),
        "{request}"
    );
}

#[tokio::test]
async fn start_accepts_a_manual_client_id() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;

    let (status, payload) = post(
        &state,
        "/api/ai/copilot/start",
        json!({ "client_id": "client-perso" }),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED, "{payload}");
    let request = fake.find("POST /login/device/code");
    assert!(request.contains("client_id=client-perso"), "{request}");
}

#[tokio::test]
async fn start_reports_a_github_refusal() {
    let fake = serve(|_| {
        (
            400,
            json!({ "error": "invalid_client", "error_description": "client inconnu" }).to_string(),
        )
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;

    let (status, payload) = post(&state, "/api/ai/copilot/start", json!({})).await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{payload}");
    assert_eq!(payload["kind"], "copilot");
    let message = payload["error"].as_str().expect("message");
    assert!(message.contains("invalid_client"), "{message}");
    assert!(message.contains("Réessaie"), "{message}");
}

#[tokio::test]
async fn status_stays_pending_while_github_waits_for_the_code() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        "/login/oauth/access_token" => {
            (200, json!({ "error": "authorization_pending" }).to_string())
        }
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    let session = started(&state).await;

    let (status, payload) = status(&state, &session).await;

    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(payload["status"], "pending");
    assert_eq!(payload["interval"], 5);
    assert!(payload["error"].is_null(), "{payload}");
    assert!(payload["login"].is_null(), "{payload}");
    let request = fake.find("POST /login/oauth/access_token");
    assert!(request.contains("device_code=dev-123"), "{request}");
    assert!(
        request.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"),
        "{request}"
    );
    assert!(
        request.contains("client_id=Iv1.b507a08c87ecfe98"),
        "{request}"
    );
}

#[tokio::test]
async fn status_makes_at_most_one_poll_per_call() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        "/login/oauth/access_token" => {
            (200, json!({ "error": "authorization_pending" }).to_string())
        }
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    let session = started(&state).await;

    status(&state, &session).await;
    status(&state, &session).await;

    assert_eq!(fake.count("POST /login/oauth/access_token"), 2);
}

#[tokio::test]
async fn slow_down_pushes_the_interval_by_five_seconds() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        "/login/oauth/access_token" => (200, json!({ "error": "slow_down" }).to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    let session = started(&state).await;

    let (_, first) = status(&state, &session).await;
    let (_, second) = status(&state, &session).await;

    assert_eq!(first["status"], "pending");
    assert_eq!(first["interval"], 10);
    assert_eq!(second["interval"], 15);
}

#[tokio::test]
async fn an_expired_device_code_ends_the_session() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        "/login/oauth/access_token" => (200, json!({ "error": "expired_token" }).to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    let session = started(&state).await;

    let (status, payload) = status(&state, &session).await;

    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(payload["status"], "expired");
    assert!(payload["error"].is_null(), "{payload}");
}

#[tokio::test]
async fn a_denied_consent_fails_the_session_in_french() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        "/login/oauth/access_token" => (200, json!({ "error": "access_denied" }).to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    let session = started(&state).await;

    let (_, payload) = status(&state, &session).await;

    assert_eq!(payload["status"], "failed", "{payload}");
    let message = payload["error"].as_str().expect("message");
    assert!(message.contains("autorisation refusée"), "{message}");
    assert!(message.contains("relance la connexion"), "{message}");
}

#[tokio::test]
async fn a_completed_flow_stores_both_tokens_and_the_login() {
    let expires_at = now() + 3600;
    let fake = serve(move |request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        "/login/oauth/access_token" => (200, authorized()),
        "/copilot_internal/v2/token" => (200, copilot(expires_at)),
        "/user" => (200, json!({ "login": "roman" }).to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    let session = started(&state).await;

    let (status, payload) = status(&state, &session).await;

    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(payload["status"], "done", "{payload}");
    assert_eq!(payload["login"], "roman");

    let copilot_request = fake.find("GET /copilot_internal/v2/token");
    assert!(
        copilot_request.contains("authorization: token gh-token"),
        "{copilot_request}"
    );
    assert!(
        copilot_request.contains("copilot-integration-id: vscode-chat"),
        "{copilot_request}"
    );
    assert!(
        copilot_request.contains(&format!("editor-version: {EDITOR_VERSION}")),
        "{copilot_request}"
    );

    let tokens = state
        .copilot_tokens()
        .await
        .expect("coffre")
        .expect("jetons stockés");
    assert_eq!(tokens.github_token, "gh-token");
    assert_eq!(tokens.copilot_token.as_deref(), Some("copilot-token"));
    assert_eq!(tokens.expires_at, Some(expires_at));
    assert_eq!(tokens.login.as_deref(), Some("roman"));

    let (_, session_payload) = get(&state, "/api/ai/copilot/session").await;
    assert_eq!(session_payload["connected"], true);
    assert_eq!(session_payload["login"], "roman");
}

#[tokio::test]
async fn a_refused_copilot_token_fails_the_session() {
    let fake = serve(|request| match path(request) {
        "/login/device/code" => (200, DEVICE_CODE.to_string()),
        "/login/oauth/access_token" => (200, authorized()),
        "/copilot_internal/v2/token" => (200, json!({ "message": "no subscription" }).to_string()),
        _ => (403, json!({ "message": "no subscription" }).to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    let session = started(&state).await;

    let (_, payload) = status(&state, &session).await;

    assert_eq!(payload["status"], "failed", "{payload}");
    let message = payload["error"].as_str().expect("message");
    assert!(message.contains("abonnement"), "{message}");
    assert!(state.copilot_tokens().await.expect("coffre").is_none());
}

#[tokio::test]
async fn an_unknown_session_is_a_404() {
    let fake = serve(|_| (404, "{}".to_string())).await;
    let (_directory, state) = state(settings(&fake)).await;

    let (status, payload) = status(&state, "inconnue").await;

    assert_eq!(status, StatusCode::NOT_FOUND, "{payload}");
    assert_eq!(payload["kind"], "store");
}

#[tokio::test]
async fn session_without_a_secret_is_disconnected_and_leaks_nothing() {
    let fake = serve(|_| (404, "{}".to_string())).await;
    let (_directory, state) = state(settings(&fake)).await;

    let (status, text) = get_raw(&state, "/api/ai/copilot/session").await;
    let payload: Value = serde_json::from_str(&text).expect("JSON");

    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(payload["connected"], false);
    assert!(payload["login"].is_null(), "{text}");
    assert!(!text.contains("token"), "{text}");
}

#[tokio::test]
async fn logout_is_idempotent_and_never_shows_a_token() {
    let fake = serve(|_| (404, "{}".to_string())).await;
    let (_directory, state) = state(settings(&fake)).await;
    connected(&state, now() + 3600, Some("copilot-token")).await;

    let (first, payload) = post(&state, "/api/ai/copilot/logout", json!({})).await;
    let (second, again) = post(&state, "/api/ai/copilot/logout", json!({})).await;

    assert_eq!(first, StatusCode::OK, "{payload}");
    assert_eq!(payload["ok"], true);
    assert_eq!(second, StatusCode::OK, "{again}");
    assert_eq!(again["ok"], true);
    assert!(state.copilot_tokens().await.expect("coffre").is_none());
    let (status, text) = get_raw(&state, "/api/ai/copilot/session").await;
    assert_eq!(status, StatusCode::OK);
    assert!(text.contains("\"connected\":false"), "{text}");
}

#[tokio::test]
async fn chat_without_a_connection_is_a_409() {
    let fake = serve(|_| (404, "{}".to_string())).await;
    let (_directory, state) = state(settings(&fake)).await;

    let (status, payload) = post(
        &state,
        "/api/ai/chat",
        json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "bonjour" }] }),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT, "{payload}");
    assert_eq!(payload["kind"], "copilot");
    assert_eq!(
        payload["error"],
        "Connecte ton compte GitHub Copilot dans les réglages IA."
    );
}

#[tokio::test]
async fn chat_proxies_to_copilot_with_its_headers() {
    let fake = serve(|request| match path(request) {
        "/chat/completions" => (200, chat_answer()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    connected(&state, now() + 3600, Some("copilot-token")).await;

    let (status, payload) = post(
        &state,
        "/api/ai/chat",
        json!({
            "model": "gpt-4o",
            "messages": [{ "role": "user", "content": "bonjour" }],
            "temperature": 0.2
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{payload}");
    assert_eq!(payload["choices"][0]["message"]["content"], "Bonjour");
    assert_eq!(payload["usage"]["prompt_tokens"], 12);
    assert_eq!(payload["usage"]["completion_tokens"], 3);

    let upstream = fake.find("POST /chat/completions");
    assert!(
        upstream.contains("authorization: Bearer copilot-token"),
        "{upstream}"
    );
    assert!(
        upstream.contains("copilot-integration-id: vscode-chat"),
        "{upstream}"
    );
    assert!(
        upstream.contains(&format!("editor-version: {EDITOR_VERSION}")),
        "{upstream}"
    );
    assert!(
        upstream.contains("content-type: application/json"),
        "{upstream}"
    );
    assert!(upstream.contains("\"model\":\"gpt-4o\""), "{upstream}");
    assert!(upstream.contains("\"temperature\":0.2"), "{upstream}");
    assert!(upstream.contains("\"content\":\"bonjour\""), "{upstream}");
    assert_eq!(fake.count("GET /copilot_internal/v2/token"), 0);
}

#[tokio::test]
async fn chat_refreshes_an_expired_copilot_token() {
    let fake = serve(|request| match path(request) {
        "/copilot_internal/v2/token" => (200, copilot(now() + 3600)),
        "/chat/completions" => (200, chat_answer()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    connected(&state, now() - 10, Some("vieux-jeton")).await;

    let (status, payload) = post(
        &state,
        "/api/ai/chat",
        json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "bonjour" }] }),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{payload}");
    let refresh = fake.find("GET /copilot_internal/v2/token");
    assert!(
        refresh.contains("authorization: token gh-token"),
        "{refresh}"
    );
    let upstream = fake.find("POST /chat/completions");
    assert!(
        upstream.contains("authorization: Bearer copilot-token"),
        "{upstream}"
    );
    let tokens = state
        .copilot_tokens()
        .await
        .expect("coffre")
        .expect("jetons");
    assert_eq!(tokens.copilot_token.as_deref(), Some("copilot-token"));
    assert_eq!(tokens.login.as_deref(), Some("roman"));
}

#[tokio::test]
async fn a_refused_chat_is_a_502_with_an_actionable_message() {
    let fake = serve(|request| match path(request) {
        "/chat/completions" => (401, json!({ "error": "unauthorized" }).to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    connected(&state, now() + 3600, Some("copilot-token")).await;

    let (status, payload) = post(
        &state,
        "/api/ai/chat",
        json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "bonjour" }] }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{payload}");
    assert_eq!(payload["kind"], "copilot");
    assert_eq!(
        payload["error"],
        "GitHub a refusé l'accès Copilot : vérifie ton abonnement ou reconnecte-toi."
    );
}

#[tokio::test]
async fn chat_gives_up_after_its_timeout() {
    let fake = serve_silent().await;
    let mut settings = settings(&fake);
    settings.chat_timeout = Duration::from_millis(300);
    let (_directory, state) = state(settings).await;
    connected(&state, now() + 3600, Some("copilot-token")).await;

    let (status, payload) = post(
        &state,
        "/api/ai/chat",
        json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "bonjour" }] }),
    )
    .await;

    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT, "{payload}");
    assert_eq!(payload["kind"], "copilot");
}

#[tokio::test]
async fn an_unreadable_chat_answer_is_a_502() {
    let fake = serve(|request| match path(request) {
        "/chat/completions" => (200, "<html>passerelle</html>".to_string()),
        _ => (404, "{}".to_string()),
    })
    .await;
    let (_directory, state) = state(settings(&fake)).await;
    connected(&state, now() + 3600, Some("copilot-token")).await;

    let (status, payload) = post(
        &state,
        "/api/ai/chat",
        json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "bonjour" }] }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{payload}");
    assert_eq!(payload["kind"], "copilot");
    let message = payload["error"].as_str().expect("message");
    assert!(message.contains("illisible"), "{message}");
}

#[test]
fn the_copilot_secret_round_trips_and_old_variants_stay_readable() {
    let secret = AccountSecrets::LlmCopilot {
        github_token: "gh-token".to_string(),
        copilot_token: Some("copilot-token".to_string()),
        expires_at: Some(1_800_000_000),
        login: Some("roman".to_string()),
    };
    let stored = serde_json::to_string(&secret).expect("sérialisation");
    assert!(stored.contains("\"kind\":\"llm_copilot\""), "{stored}");
    let back: AccountSecrets = serde_json::from_str(&stored).expect("relecture");
    assert_eq!(back, secret);

    let minimal: AccountSecrets = serde_json::from_str(
        r#"{"kind":"llm_copilot","github_token":"gh","copilot_token":null,"expires_at":null,"login":null}"#,
    )
    .expect("jetons seuls");
    assert_eq!(
        minimal,
        AccountSecrets::LlmCopilot {
            github_token: "gh".to_string(),
            copilot_token: None,
            expires_at: None,
            login: None,
        }
    );

    let password: AccountSecrets =
        serde_json::from_str(r#"{"kind":"password","password":"secret"}"#).expect("ancienne forme");
    assert_eq!(
        password,
        AccountSecrets::Password {
            password: "secret".to_string()
        }
    );
    let legacy: AccountSecrets = serde_json::from_str(r#"{"kind":"sync_account","token":"jeton"}"#)
        .expect("forme de synchronisation");
    assert_eq!(
        legacy,
        AccountSecrets::SyncAccount {
            token: "jeton".to_string()
        }
    );
}
