//! Zimbra SOAP : `GetInfo`, filtres et message d'absence d'un compte, servis par
//! un faux Zimbra en boucle locale et appelés par le routeur, sans réseau.

use std::fs;
use std::sync::{Arc, Mutex};

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

/// Deux règles : la première dans le sous-ensemble du client, la seconde avec
/// une action qu'il ne sait pas réécrire.
const FILTERS_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
    "Body":{"GetFilterRulesResponse":{"_jsns":"urn:zimbraMail","filterRules":[{"filterRule":[
    {"name":"facture","active":true,
     "filterTests":[{"condition":"anyof","headerTest":[
        {"header":"Subject","stringComparison":"contains","value":"facture"}]}],
     "filterActions":[{"actionFileInto":[{"folderPath":"Factures"}]}]},
    {"name":"alerte","active":true,
     "filterTests":[{"condition":"allof","addressTest":[
        {"header":"from","part":"domain","stringComparison":"is","value":"exemple.tld"}]}],
     "filterActions":[{"actionNotify":[{"a":"autre@exemple.tld"}]}]}]}]}}}"#;

const VACATION_ANSWER: &str = r#"{"Body":{"GetPrefsResponse":{"_jsns":"urn:zimbraAccount","pref":[
    {"name":"zimbraPrefOutOfOfficeReplyEnabled","_content":"TRUE"},
    {"name":"zimbraPrefOutOfOfficeReply","_content":"Absent jusqu'à lundi."},
    {"name":"zimbraPrefOutOfOfficeFromDate","_content":"20260101000000Z"},
    {"name":"zimbraPrefOutOfOfficeUntilDate","_content":""}]}}}"#;

const WRITTEN_ANSWER: &str = r#"{"Body":{"ModifyFilterRulesResponse":{"_jsns":"urn:zimbraMail"}}}"#;

const PREFS_WRITTEN: &str = r#"{"Body":{"ModifyPrefsResponse":{"_jsns":"urn:zimbraAccount"}}}"#;

/// Faux Zimbra : une réponse par opération, et les corps reçus dans l'ordre.
#[derive(Clone)]
struct Zimbra {
    auth: &'static str,
    info: &'static str,
    filters: &'static str,
    written: &'static str,
    prefs: &'static str,
    prefs_written: &'static str,
    seen: Arc<Mutex<Vec<Value>>>,
}

impl Zimbra {
    fn new() -> Self {
        Self {
            auth: AUTH_ANSWER,
            info: INFO_ANSWER,
            filters: FILTERS_ANSWER,
            written: WRITTEN_ANSWER,
            prefs: VACATION_ANSWER,
            prefs_written: PREFS_WRITTEN,
            seen: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.seen.lock().expect("journal").clone()
    }
}

async fn soap_answer(State(zimbra): State<Zimbra>, body: String) -> Response {
    let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    zimbra.seen.lock().expect("journal").push(request.clone());
    let called = &request["Body"];
    let answer = if called.get("AuthRequest").is_some() {
        zimbra.auth
    } else if called.get("GetInfoRequest").is_some() {
        zimbra.info
    } else if called.get("GetFilterRulesRequest").is_some() {
        zimbra.filters
    } else if called.get("ModifyFilterRulesRequest").is_some() {
        zimbra.written
    } else if called.get("GetPrefsRequest").is_some() {
        zimbra.prefs
    } else if called.get("ModifyPrefsRequest").is_some() {
        zimbra.prefs_written
    } else {
        FAILURE_ANSWER
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

fn oauth_account(id: &str, email: &str) -> Value {
    json!({
        "id": id,
        "label": "Google",
        "email": email,
        "username": email,
        "imap": { "host": "imap.gmail.com", "port": 993, "encryption": "tls" },
        "smtp": { "host": "smtp.gmail.com", "port": 465, "encryption": "tls" },
        "auth": { "kind": "o_auth2", "client_id": "client",
                  "token_endpoint": "https://oauth2.googleapis.com/token" },
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

async fn link_password_account(directory: &TempDir, state: &Arc<AppState>, host: &str) -> String {
    link_account(
        directory,
        state,
        account("pro", host, "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret-en-clair".to_string(),
        },
    )
    .await;
    "pro".to_string()
}

async fn send(
    state: &Arc<AppState>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Bytes) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {}", state.token()));
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request
        .body(match body {
            Some(value) => Body::from(serde_json::to_vec(&value).expect("corps")),
            None => Body::empty(),
        })
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

async fn get(state: &Arc<AppState>, uri: &str) -> (StatusCode, Bytes) {
    send(state, "GET", uri, None).await
}

fn json(body: &Bytes) -> Value {
    serde_json::from_slice(body).expect("JSON")
}

fn text(body: &Bytes) -> String {
    String::from_utf8_lossy(body).to_string()
}

#[tokio::test]
async fn the_info_of_a_password_account_is_read() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra.clone()).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = get(&state, "/api/accounts/pro/zimbra/info").await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let info = json(&body);
    assert_eq!(info["name"], "roman@exemple.tld");
    assert_eq!(info["id"], "7f2c");
    assert_eq!(info["version"], "9.0.0_GA_4642");
    let text = text(&body);
    assert!(!text.contains("jeton-1"), "{text}");
    assert!(!text.contains("secret-en-clair"), "{text}");
}

#[tokio::test]
async fn an_oauth_account_has_no_zimbra_info() {
    let (directory, state) = state().await;
    link_account(
        &directory,
        &state,
        oauth_account("gmail", "roman@gmail.com"),
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
    let zimbra = Zimbra {
        auth: REFUSED_ANSWER,
        ..Zimbra::new()
    };
    let host = serve(zimbra).await;
    link_password_account(&directory, &state, &host).await;

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
    let zimbra = Zimbra {
        filters: FAILURE_ANSWER,
        ..Zimbra::new()
    };
    let host = serve(zimbra).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = get(&state, "/api/accounts/pro/zimbra/filters").await;
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

#[tokio::test]
async fn the_filters_of_the_account_are_listed() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = get(&state, "/api/accounts/pro/zimbra/filters").await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let rules = json(&body);
    assert_eq!(rules[0]["name"], "facture");
    assert_eq!(rules[0]["active"], true);
    assert_eq!(rules[0]["condition"], "anyof");
    assert_eq!(rules[0]["read_only"], false);
    assert_eq!(rules[0]["tests"][0]["kind"], "header");
    assert_eq!(rules[0]["tests"][0]["header"], "Subject");
    assert_eq!(rules[0]["tests"][0]["comparison"], "contains");
    assert_eq!(rules[0]["actions"][0]["kind"], "file_into");
    assert_eq!(rules[0]["actions"][0]["folder_path"], "Factures");
    assert_eq!(rules[1]["name"], "alerte");
    assert_eq!(rules[1]["read_only"], true);
    let text = text(&body);
    assert!(!text.contains("jeton-1"), "{text}");
}

#[tokio::test]
async fn a_filter_is_added_to_the_server_list() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra.clone()).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = send(
        &state,
        "POST",
        "/api/accounts/pro/zimbra/filters",
        Some(json!({
            "action": "add",
            "rule": {
                "name": "dossier",
                "active": true,
                "condition": "allof",
                "tests": [{ "kind": "address", "header": "from", "part": "domain",
                            "comparison": "notis", "value": "exemple.tld" }],
                "actions": [{ "kind": "file_into", "folder_path": "Archive" }],
                "read_only": false,
            },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "corps : {body:?}");

    let requests = zimbra.requests();
    let sent = requests
        .iter()
        .find_map(|request| request["Body"].get("ModifyFilterRulesRequest"))
        .expect("ModifyFilterRules");
    assert_eq!(sent["_jsns"], "urn:zimbraMail");
    let rules = sent["filterRules"].as_array().expect("filterRules");
    assert_eq!(rules.len(), 3, "{sent}");
    assert_eq!(rules[0]["filterRule"][0]["name"], "facture");
    let added = &rules[2]["filterRule"][0];
    assert_eq!(added["name"], "dossier");
    assert_eq!(added["filterTests"][0]["condition"], "allof");
    assert_eq!(
        added["filterTests"][0]["addressTest"][0]["stringComparison"],
        "is"
    );
    assert_eq!(added["filterTests"][0]["addressTest"][0]["negative"], true);
    assert_eq!(
        added["filterActions"][0]["actionFileInto"][0]["folderPath"],
        "Archive"
    );
    assert!(!sent.to_string().contains("secret-en-clair"));
}

#[tokio::test]
async fn a_filter_is_deleted_from_the_server_list() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra.clone()).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = send(
        &state,
        "POST",
        "/api/accounts/pro/zimbra/filters",
        Some(json!({ "action": "delete", "rule": { "name": "facture" } })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "corps : {body:?}");

    let requests = zimbra.requests();
    let sent = requests
        .iter()
        .find_map(|request| request["Body"].get("ModifyFilterRulesRequest"))
        .expect("ModifyFilterRules");
    let rules = sent["filterRules"].as_array().expect("filterRules");
    assert_eq!(rules.len(), 1, "{sent}");
    assert_eq!(rules[0]["filterRule"][0]["name"], "alerte");
}

#[tokio::test]
async fn an_advanced_filter_is_never_rewritten() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra.clone()).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = send(
        &state,
        "POST",
        "/api/accounts/pro/zimbra/filters",
        Some(json!({
            "action": "modify",
            "rule": {
                "name": "alerte",
                "active": false,
                "condition": "allof",
                "tests": [{ "kind": "size", "comparison": "over", "size": "1M" }],
                "actions": [{ "kind": "keep" }],
            },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    let error = json(&body);
    assert_eq!(error["kind"], "zimbra");
    assert!(error["error"].as_str().expect("message").contains("Zimbra"));
    assert!(zimbra
        .requests()
        .iter()
        .all(|request| request["Body"].get("ModifyFilterRulesRequest").is_none()));
}

#[tokio::test]
async fn an_unknown_filter_is_not_found() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = send(
        &state,
        "POST",
        "/api/accounts/pro/zimbra/filters",
        Some(json!({ "action": "delete", "rule": { "name": "fantôme" } })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "zimbra");
}

#[tokio::test]
async fn a_filter_without_condition_is_refused() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = send(
        &state,
        "POST",
        "/api/accounts/pro/zimbra/filters",
        Some(json!({
            "action": "add",
            "rule": {
                "name": "vide",
                "active": true,
                "condition": "anyof",
                "tests": [],
                "actions": [{ "kind": "keep" }],
            },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    let message = json(&body)["error"].as_str().expect("message").to_string();
    assert!(message.contains("aucune condition"), "{message}");
}

#[tokio::test]
async fn the_vacation_answer_of_the_account_is_read() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra.clone()).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = get(&state, "/api/accounts/pro/zimbra/vacation").await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let vacation = json(&body);
    assert_eq!(vacation["enabled"], true);
    assert_eq!(vacation["message"], "Absent jusqu'à lundi.");
    assert_eq!(vacation["from"], "2026-01-01");
    assert_eq!(vacation["until"], Value::Null);
    let requests = zimbra.requests();
    let asked = requests
        .iter()
        .find_map(|request| request["Body"].get("GetPrefsRequest"))
        .expect("GetPrefs");
    assert_eq!(
        asked["pref"][3]["name"], "zimbraPrefOutOfOfficeUntilDate",
        "{asked}"
    );
}

#[tokio::test]
async fn the_vacation_answer_is_saved_with_zimbra_dates() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra.clone()).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = send(
        &state,
        "PUT",
        "/api/accounts/pro/zimbra/vacation",
        Some(json!({
            "enabled": true,
            "message": "De retour lundi.",
            "from": "2026-01-01",
            "until": "2026-01-15",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "corps : {body:?}");

    let requests = zimbra.requests();
    let attrs = requests
        .iter()
        .find_map(|request| request["Body"].get("ModifyPrefsRequest"))
        .map(|request| &request["_attrs"])
        .expect("ModifyPrefs");
    assert_eq!(attrs["zimbraPrefOutOfOfficeReplyEnabled"], "TRUE");
    assert_eq!(attrs["zimbraPrefOutOfOfficeReply"], "De retour lundi.");
    assert_eq!(attrs["zimbraPrefOutOfOfficeFromDate"], "20260101000000Z");
    assert_eq!(attrs["zimbraPrefOutOfOfficeUntilDate"], "20260115235959Z");
}

#[tokio::test]
async fn a_vacation_answer_with_a_broken_date_is_refused() {
    let (directory, state) = state().await;
    let zimbra = Zimbra::new();
    let host = serve(zimbra.clone()).await;
    link_password_account(&directory, &state, &host).await;

    let (status, body) = send(
        &state,
        "PUT",
        "/api/accounts/pro/zimbra/vacation",
        Some(json!({
            "enabled": true,
            "message": "Absent.",
            "from": "01/01/2026",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    let message = json(&body)["error"].as_str().expect("message").to_string();
    assert!(message.contains("AAAA-MM-JJ"), "{message}");
    assert!(zimbra
        .requests()
        .iter()
        .all(|request| request["Body"].get("ModifyPrefsRequest").is_none()));
}

#[tokio::test]
async fn an_oauth_account_has_no_filters() {
    let (directory, state) = state().await;
    link_account(
        &directory,
        &state,
        oauth_account("gmail", "roman@gmail.com"),
        AccountSecrets::OAuth2 {
            client_secret: "secret-client".to_string(),
            refresh_token: "secret-refresh".to_string(),
        },
    )
    .await;

    let (status, body) = get(&state, "/api/accounts/gmail/zimbra/filters").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "zimbra");
}
