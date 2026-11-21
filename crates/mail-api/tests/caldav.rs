//! CalDAV en lecture seule : découverte des calendriers et récupération des
//! événements, servies par un faux serveur WebDAV en boucle locale.

use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, Method, Request, StatusCode, Uri};
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

/// `Basic base64("roman:secret")`.
const AUTHORIZATION: &str = "Basic cm9tYW46c2VjcmV0";

const PRINCIPAL_ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop><D:current-user-principal><D:href>/principals/roman/</D:href></D:current-user-principal></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const HOME_ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/principals/roman/</D:href>
    <D:propstat>
      <D:prop><C:calendar-home-set><D:href>/dav/roman/</D:href></C:calendar-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const COLLECTIONS_ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:response>
    <D:href>/dav/roman/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/travail/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Travail</D:displayname>
        <C:calendar-description>Réunions &amp; revues</C:calendar-description>
        <A:calendar-color>#FF8C00FF</A:calendar-color>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/perso/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Perso</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const TRAVAIL_REPORT: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/roman/travail/reunion.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const EMPTY_REPORT: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:"/>"#;

const ICS: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
BEGIN:VEVENT\r\n\
UID:reunion-caldav\r\n\
SUMMARY:Revue de sprint\r\n\
DTSTART;TZID=Europe/Paris:20240315T140000\r\n\
DTEND;TZID=Europe/Paris:20240315T150000\r\n\
LOCATION:Visioconférence\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

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

async fn dav(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(AUTHORIZATION);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "identifiants refusés").into_response();
    }
    let depth = headers
        .get("depth")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let xml = |body: &str| {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
            body.to_string(),
        )
            .into_response()
    };
    match (method.as_str(), uri.path(), depth) {
        ("PROPFIND", "/dav/", "0") => xml(PRINCIPAL_ANSWER),
        ("PROPFIND", "/principals/roman/", "0") => xml(HOME_ANSWER),
        ("PROPFIND", "/dav/roman/", "1") => xml(COLLECTIONS_ANSWER),
        ("REPORT", "/dav/roman/travail/", _) => xml(TRAVAIL_REPORT),
        ("REPORT", "/dav/roman/perso/", _) => xml(EMPTY_REPORT),
        ("GET", "/dav/roman/travail/reunion.ics", _) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/calendar; charset=utf-8")],
            ICS.to_string(),
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, "introuvable").into_response(),
    }
}

/// Serves the fake CalDAV server and returns its `/dav/` URL.
async fn serve() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("écoute");
    let address = listener.local_addr().expect("adresse locale");
    let server = Router::new()
        .route("/", any(dav))
        .route("/{*path}", any(dav));
    tokio::spawn(async move {
        axum::serve(listener, server)
            .await
            .expect("serveur de test");
    });
    format!("http://{address}/dav/")
}

async fn call(
    state: &Arc<AppState>,
    method: Method,
    path: &str,
    payload: Option<Value>,
) -> (StatusCode, Bytes) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {}", state.token()));
    let body = match payload {
        Some(payload) => {
            builder = builder.header("content-type", "application/json");
            Body::from(payload.to_string())
        }
        None => Body::empty(),
    };
    let response = app(state.clone())
        .oneshot(builder.body(body).expect("requête"))
        .await
        .expect("réponse");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("corps");
    (status, body)
}

async fn post(state: &Arc<AppState>, path: &str, payload: Value) -> (StatusCode, Bytes) {
    call(state, Method::POST, path, Some(payload)).await
}

fn json(body: &Bytes) -> Value {
    serde_json::from_slice(body).expect("corps JSON")
}

fn credentials(url: &str) -> Value {
    json!({ "url": url, "username": "roman", "password": "secret" })
}

#[tokio::test]
async fn discovery_lists_the_calendar_collections() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(&state, "/api/calendars/caldav/discover", credentials(&url)).await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let calendars = json(&body);
    assert_eq!(calendars.as_array().expect("liste").len(), 2);
    assert_eq!(calendars[0]["name"], "Travail");
    assert_eq!(calendars[0]["description"], "Réunions & revues");
    assert_eq!(calendars[0]["color"], "#FF8C00FF");
    assert_eq!(calendars[1]["name"], "Perso");
    assert!(calendars[0]["href"]
        .as_str()
        .expect("href")
        .ends_with("/dav/roman/travail/"));
}

#[tokio::test]
async fn events_are_read_from_one_calendar() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let mut payload = credentials(&url);
    payload["calendar_href"] = json!("/dav/roman/travail/");
    let (status, body) = post(&state, "/api/calendars/caldav/events", payload).await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let events = json(&body);
    assert_eq!(events.as_array().expect("liste").len(), 1);
    assert_eq!(events[0]["uid"], "reunion-caldav");
    assert_eq!(events[0]["title"], "Revue de sprint");
    assert_eq!(events[0]["date"], "2024-03-15");
    assert_eq!(events[0]["start"], "14:00");
    assert_eq!(events[0]["end"], "15:00");
    assert_eq!(events[0]["timezone"], "Europe/Paris");
    assert_eq!(events[0]["location"], "Visioconférence");
    let source = events[0]["source"].as_str().expect("source");
    assert!(source.ends_with("/dav/roman/travail/"), "source : {source}");
}

#[tokio::test]
async fn every_discovered_calendar_is_read() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(&state, "/api/calendars/caldav/events", credentials(&url)).await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let events = json(&body);
    assert_eq!(events.as_array().expect("liste").len(), 1);
    assert_eq!(events[0]["title"], "Revue de sprint");
}

#[tokio::test]
async fn a_refused_password_is_an_auth_error() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/discover",
        json!({ "url": url, "username": "roman", "password": "mauvais-secret" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "corps : {body:?}");
    let error = json(&body);
    assert_eq!(error["kind"], "auth");
    let message = error["error"].as_str().expect("message");
    assert!(message.contains("401"), "message : {message}");
    assert!(!message.contains("mauvais-secret"), "message : {message}");
    assert!(!message.contains("secret"), "message : {message}");
}

#[tokio::test]
async fn an_url_out_of_http_is_refused() {
    let (_directory, state) = state().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/discover",
        json!({ "url": "ftp://exemple.tld/dav/", "username": "roman", "password": "secret" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "config");
}

#[tokio::test]
async fn missing_credentials_are_refused() {
    let (_directory, state) = state().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/discover",
        json!({ "url": "https://caldav.exemple.tld/dav/", "username": "", "password": "" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "caldav");
}

#[tokio::test]
async fn a_stored_source_keeps_its_credentials_out_of_every_file_and_answer() {
    let (directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources",
        json!({ "url": url, "username": "roman", "password": "secret", "name": "Travail" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let source = json(&body);
    assert_eq!(source["id"], "travail");
    assert_eq!(source["name"], "Travail");
    assert_eq!(source["url"], url);
    assert_eq!(source["calendar_href"], Value::Null);
    let answer = String::from_utf8_lossy(&body);
    assert!(!answer.contains("secret"), "réponse : {answer}");
    assert!(!answer.contains("roman"), "réponse : {answer}");

    let path = directory.path().join("calendars.json");
    let text = fs::read_to_string(&path).expect("calendars.json");
    assert!(text.contains("Travail"), "{text}");
    assert!(!text.contains("secret"), "{text}");
    assert!(!text.contains("roman"), "{text}");
    #[cfg(unix)]
    {
        let mode = fs::metadata(&path).expect("fichier").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    assert_eq!(
        state.secrets().get("caldav:travail").await.expect("secret"),
        Some(lavande_mail_api::secrets::AccountSecrets::Caldav {
            username: "roman".to_string(),
            password: "secret".to_string(),
        })
    );
}

#[tokio::test]
async fn a_stored_source_reads_its_events_without_credentials_in_the_request() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources",
        json!({
            "url": url,
            "username": "roman",
            "password": "secret",
            "name": "Travail",
            "calendar_href": "/dav/roman/travail/"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let id = json(&body)["id"].as_str().expect("id").to_string();
    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let events = json(&body);
    assert_eq!(events.as_array().expect("liste").len(), 1);
    assert_eq!(events[0]["title"], "Revue de sprint");
}

#[tokio::test]
async fn a_source_without_a_collection_reads_every_discovered_calendar() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources",
        json!({ "url": url, "username": "roman", "password": "secret" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let source = json(&body);
    let host = reqwest::Url::parse(&url)
        .expect("url")
        .host_str()
        .expect("hôte")
        .to_string();
    assert_eq!(source["name"], host);
    let id = source["id"].as_str().expect("id").to_string();
    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    assert_eq!(json(&body).as_array().expect("liste").len(), 1);
}

#[tokio::test]
async fn a_refused_password_stores_nothing() {
    let (directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources",
        json!({ "url": url, "username": "roman", "password": "mauvais-secret" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "corps : {body:?}");
    assert!(state.calendar_sources().expect("sources").is_empty());
    assert!(!directory.path().join("calendars.json").exists());
    assert!(!directory.path().join("secrets.enc").exists());
}

#[tokio::test]
async fn sources_are_listed_under_unique_ids_and_deleted_with_their_secret() {
    let (directory, state) = state().await;
    let url = serve().await;
    let mut ids = Vec::new();
    for _ in 0..2 {
        let (status, body) = post(
            &state,
            "/api/calendars/caldav/sources",
            json!({ "url": url, "username": "roman", "password": "secret", "name": "Perso" }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
        ids.push(json(&body)["id"].as_str().expect("id").to_string());
    }
    assert_eq!(ids, vec!["perso", "perso-2"]);

    let (status, body) = call(&state, Method::GET, "/api/calendars/caldav/sources", None).await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let sources = json(&body);
    assert_eq!(sources.as_array().expect("liste").len(), 2);
    let answer = String::from_utf8_lossy(&body);
    assert!(!answer.contains("secret"), "réponse : {answer}");
    assert!(!answer.contains("username"), "réponse : {answer}");

    let (status, _) = call(
        &state,
        Method::DELETE,
        "/api/calendars/caldav/sources/perso",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        state.secrets().get("caldav:perso").await.expect("secret"),
        None
    );
    assert_eq!(
        state.secrets().get("caldav:perso-2").await.expect("secret"),
        Some(lavande_mail_api::secrets::AccountSecrets::Caldav {
            username: "roman".to_string(),
            password: "secret".to_string(),
        })
    );
    let (status, body) = call(&state, Method::GET, "/api/calendars/caldav/sources", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body).as_array().expect("liste").len(), 1);

    let (status, _) = call(
        &state,
        Method::DELETE,
        "/api/calendars/caldav/sources/perso",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(directory.path().join("calendars.json").exists());
}

#[tokio::test]
async fn the_events_of_an_unknown_source_are_a_404() {
    let (_directory, state) = state().await;
    let (status, body) = call(
        &state,
        Method::POST,
        "/api/calendars/caldav/sources/inconnu/events",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn a_stored_source_survives_a_restart() {
    let (directory, state) = state().await;
    let url = serve().await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources",
        json!({
            "url": url,
            "username": "roman",
            "password": "secret",
            "name": "Travail",
            "calendar_href": "/dav/roman/travail/"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");

    let reopened = Arc::new(
        AppState::open_with(
            directory.path(),
            TlsOptions::default(),
            Default::default(),
            SecretBackend::File,
        )
        .await
        .expect("état rouvert"),
    );
    let (status, body) = call(
        &reopened,
        Method::POST,
        "/api/calendars/caldav/sources/travail/events",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    assert_eq!(json(&body).as_array().expect("liste").len(), 1);
}

/// Un compte mail tel que `accounts.json` le range, secrets mis à part.
fn account(id: &str, host: &str, email: &str) -> Value {
    json!({
        "id": id,
        "label": "Perso",
        "email": email,
        "username": "roman",
        "imap": { "host": host, "port": 993, "encryption": "tls" },
        "smtp": { "host": host, "port": 465, "encryption": "tls" },
        "auth": { "kind": "password", "password": "secret" }
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

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .expect("url")
        .host_str()
        .expect("hôte")
        .to_string()
}

/// Faux Zimbra : la découverte ne répond pas, seul `/dav/<email>/Calendar` existe.
async fn dav_zimbra(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(AUTHORIZATION);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "identifiants refusés").into_response();
    }
    match (method.as_str(), uri.path()) {
        ("REPORT", "/dav/roman@exemple.tld/Calendar") => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
            TRAVAIL_REPORT,
        )
            .into_response(),
        ("GET", "/dav/roman/travail/reunion.ics") => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/calendar; charset=utf-8")],
            ICS,
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, "introuvable").into_response(),
    }
}

/// Sert le faux Zimbra et rend son URL de base (`/dav/`).
async fn serve_zimbra() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("écoute");
    let address = listener.local_addr().expect("adresse locale");
    let server = Router::new()
        .route("/", any(dav_zimbra))
        .route("/{*path}", any(dav_zimbra));
    tokio::spawn(async move {
        axum::serve(listener, server)
            .await
            .expect("serveur de test");
    });
    format!("http://{address}/dav/")
}

#[tokio::test]
async fn the_calendar_of_a_mail_account_borrows_its_credentials() {
    let (directory, state) = state().await;
    let url = serve().await;
    let host = host_of(&url);
    link_account(
        &directory,
        &state,
        account("perso", &host, "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret".to_string(),
        },
    )
    .await;

    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources/from-account",
        json!({ "account_id": "perso", "url": url }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let source = json(&body);
    assert_eq!(source["account_id"], "perso");
    assert_eq!(source["name"], host);
    assert_eq!(source["calendar_href"], Value::Null);
    let answer = String::from_utf8_lossy(&body);
    assert!(!answer.contains("secret"), "réponse : {answer}");
    assert!(!answer.contains("roman"), "réponse : {answer}");

    let text = fs::read_to_string(directory.path().join("calendars.json")).expect("calendars.json");
    assert!(text.contains("perso"), "{text}");
    assert!(!text.contains("secret"), "{text}");

    let id = source["id"].as_str().expect("id").to_string();
    assert_eq!(
        state
            .secrets()
            .get(&format!("caldav:{id}"))
            .await
            .expect("secret"),
        None
    );

    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    assert_eq!(json(&body).as_array().expect("liste").len(), 1);
}

#[tokio::test]
async fn an_oauth_account_has_no_caldav_calendar() {
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

    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources/from-account",
        json!({ "account_id": "gmail" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    let error = json(&body);
    assert_eq!(error["kind"], "caldav");
    let message = error["error"].as_str().expect("message");
    assert!(message.contains("Google"), "message : {message}");
    assert!(!message.contains("secret"), "message : {message}");
    assert!(state.calendar_sources().expect("sources").is_empty());
    assert!(!directory.path().join("calendars.json").exists());
}

#[tokio::test]
async fn a_silent_server_stores_no_source() {
    let (directory, state) = state().await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port libre");
    let port = listener.local_addr().expect("adresse").port();
    drop(listener);
    link_account(
        &directory,
        &state,
        account("perso", "127.0.0.1", "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret".to_string(),
        },
    )
    .await;

    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources/from-account",
        json!({ "account_id": "perso", "url": format!("http://127.0.0.1:{port}/dav/") }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "corps : {body:?}");
    assert!(state.calendar_sources().expect("sources").is_empty());
    assert!(!directory.path().join("calendars.json").exists());
}

#[tokio::test]
async fn the_account_password_never_leaves_its_own_server() {
    let (directory, state) = state().await;
    link_account(
        &directory,
        &state,
        account("perso", "mail.exemple.tld", "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret".to_string(),
        },
    )
    .await;

    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources/from-account",
        json!({ "account_id": "perso", "url": "https://autre.exemple.tld/dav/" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert!(state.calendar_sources().expect("sources").is_empty());

    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources/from-account",
        json!({ "account_id": "perso", "url": "http://mail.exemple.tld/dav/" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert!(state.calendar_sources().expect("sources").is_empty());
}

#[tokio::test]
async fn the_zimbra_calendar_is_used_when_discovery_fails() {
    let (directory, state) = state().await;
    let url = serve_zimbra().await;
    link_account(
        &directory,
        &state,
        account("perso", &host_of(&url), "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret".to_string(),
        },
    )
    .await;

    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources/from-account",
        json!({ "account_id": "perso", "url": url }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let source = json(&body);
    let href = source["calendar_href"].as_str().expect("calendar_href");
    assert!(
        href.ends_with("/dav/roman@exemple.tld/Calendar"),
        "href : {href}"
    );

    let id = source["id"].as_str().expect("id").to_string();
    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let events = json(&body);
    assert_eq!(events.as_array().expect("liste").len(), 1);
    assert_eq!(events[0]["title"], "Revue de sprint");
}

#[tokio::test]
async fn a_source_of_a_removed_account_says_so() {
    let (directory, state) = state().await;
    let url = serve().await;
    link_account(
        &directory,
        &state,
        account("perso", &host_of(&url), "roman@exemple.tld"),
        AccountSecrets::Password {
            password: "secret".to_string(),
        },
    )
    .await;
    let (status, body) = post(
        &state,
        "/api/calendars/caldav/sources/from-account",
        json!({ "account_id": "perso", "url": url }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let id = json(&body)["id"].as_str().expect("id").to_string();

    fs::remove_file(directory.path().join("accounts.json")).expect("compte supprimé");
    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "corps : {body:?}");
    let message = json(&body)["error"].as_str().expect("message").to_string();
    assert!(message.contains("n'existe plus"), "message : {message}");
}

/// Serveur CalDAV réel : `CALDAV_TEST_URL`, `CALDAV_TEST_USER`,
/// `CALDAV_TEST_PASSWORD` (Zimbra, Nextcloud, iCloud…).
#[tokio::test]
#[ignore]
async fn a_real_server_is_read() {
    let url = std::env::var("CALDAV_TEST_URL").expect("CALDAV_TEST_URL");
    let username = std::env::var("CALDAV_TEST_USER").expect("CALDAV_TEST_USER");
    let password = std::env::var("CALDAV_TEST_PASSWORD").expect("CALDAV_TEST_PASSWORD");
    let client =
        lavande_mail::caldav::CaldavClient::new(&url, &username, &password).expect("client");
    let collections = client.discover().await.expect("découverte");
    assert!(!collections.is_empty(), "aucun calendrier découvert");
    for collection in &collections {
        let events = client
            .events(Some(&collection.href))
            .await
            .expect("événements");
        println!("{} : {} événement(s)", collection.name, events.len());
    }
}
