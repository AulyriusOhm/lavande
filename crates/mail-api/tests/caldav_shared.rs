//! Agendas partagés : collections d'un serveur CalDAV, choix de la collection
//! d'un compte (celle d'un collègue comprise) et changement de collection d'une
//! source existante, servis par un faux serveur WebDAV en boucle locale.

use std::fs;
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
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
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

const REPORT: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/roman/travail/reunion.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const ICS: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
BEGIN:VEVENT\r\n\
UID:reunion-partagee\r\n\
SUMMARY:Revue de sprint\r\n\
DTSTART:20240315T140000Z\r\n\
DTEND:20240315T150000Z\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

/// Le serveur de `roman` : deux collections à lui, plus le calendrier partagé
/// de `collegue`, qu'une ACL rend lisible.
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
        ("REPORT", "/dav/roman/travail/", _) => xml(REPORT),
        ("REPORT", "/dav/roman/perso/", _) => {
            xml(r#"<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"/>"#)
        }
        ("REPORT", "/dav/collegue/Calendar/", _) => xml(REPORT),
        ("GET", "/dav/roman/travail/reunion.ics", _) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/calendar; charset=utf-8")],
            ICS.to_string(),
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, "introuvable").into_response(),
    }
}

/// Sert le faux serveur et rend son URL de base (`/dav/`).
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

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .expect("url")
        .host_str()
        .expect("hôte")
        .to_string()
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
        "username": "roman",
        "imap": { "host": host, "port": 993, "encryption": "tls" },
        "smtp": { "host": "smtp.exemple.tld", "port": 465, "encryption": "tls" },
        "auth": { "kind": "password", "password": "secret-en-clair" },
    })
}

async fn link_account(directory: &TempDir, state: &Arc<AppState>, account: Value) {
    let id = account["id"].as_str().expect("id").to_string();
    fs::write(
        directory.path().join("accounts.json"),
        serde_json::to_vec_pretty(&[account]).expect("json"),
    )
    .expect("accounts.json");
    state
        .secrets()
        .put(
            &id,
            &AccountSecrets::Password {
                password: "secret".to_string(),
            },
        )
        .await
        .expect("secret du compte");
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

fn json(body: &Bytes) -> Value {
    serde_json::from_slice(body).expect("corps JSON")
}

fn credentials(url: &str) -> Value {
    json!({ "url": url, "username": "roman", "password": "secret" })
}

#[tokio::test]
async fn the_collections_of_a_server_are_listed() {
    let (_directory, state) = state().await;
    let url = serve().await;

    let (status, body) = call(
        &state,
        Method::POST,
        "/api/calendars/caldav/collections",
        Some(credentials(&url)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let collections = json(&body);
    assert_eq!(collections.as_array().expect("liste").len(), 2);
    assert_eq!(collections[0]["name"], "Travail");
    assert!(collections[0]["href"]
        .as_str()
        .expect("href")
        .ends_with("/dav/roman/travail/"));
    assert!(!String::from_utf8_lossy(&body).contains("secret"));
}

#[tokio::test]
async fn a_collection_of_a_colleague_is_kept_on_the_source() {
    let (directory, state) = state().await;
    let url = serve().await;
    let host = host_of(&url);
    link_account(
        &directory,
        &state,
        account("perso", &host, "roman@exemple.tld"),
    )
    .await;

    let (status, body) = call(
        &state,
        Method::POST,
        "/api/calendars/caldav/sources/from-account",
        Some(json!({
            "account_id": "perso",
            "url": url,
            "calendar_href": "/dav/collegue/Calendar/",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let source = json(&body);
    assert!(source["calendar_href"]
        .as_str()
        .expect("href")
        .ends_with("/dav/collegue/Calendar/"));
    let id = source["id"].as_str().expect("id").to_string();

    let text = fs::read_to_string(directory.path().join("calendars.json")).expect("calendars.json");
    assert!(text.contains("collegue"), "{text}");

    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let events = json(&body);
    assert_eq!(events[0]["title"], "Revue de sprint");
}

#[tokio::test]
async fn a_collection_of_another_server_is_refused() {
    let (directory, state) = state().await;
    let url = serve().await;
    let host = host_of(&url);
    link_account(
        &directory,
        &state,
        account("perso", &host, "roman@exemple.tld"),
    )
    .await;

    let (status, body) = call(
        &state,
        Method::POST,
        "/api/calendars/caldav/sources/from-account",
        Some(json!({
            "account_id": "perso",
            "url": url,
            "calendar_href": "https://ailleurs.tld/dav/x/Calendar/",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "caldav");
    assert!(json(&body)["error"]
        .as_str()
        .expect("message")
        .contains("même serveur"));
    let text = fs::read_to_string(directory.path().join("calendars.json")).unwrap_or_default();
    assert!(!text.contains("ailleurs"), "{text}");
}

#[tokio::test]
async fn the_collections_of_an_account_come_from_the_vault() {
    let (directory, state) = state().await;
    let url = serve().await;
    let host = host_of(&url);
    link_account(
        &directory,
        &state,
        account("perso", &host, "roman@exemple.tld"),
    )
    .await;

    let (status, body) = call(
        &state,
        Method::GET,
        &format!("/api/accounts/perso/caldav/collections?url={url}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let collections = json(&body);
    assert_eq!(collections.as_array().expect("liste").len(), 2);
    assert_eq!(collections[1]["name"], "Perso");
    assert!(!String::from_utf8_lossy(&body).contains("secret"));
}

#[tokio::test]
async fn a_source_collection_is_read_then_changed() {
    let (_directory, state) = state().await;
    let url = serve().await;

    let (status, body) = call(
        &state,
        Method::POST,
        "/api/calendars/caldav/sources",
        Some(json!({
            "url": url,
            "username": "roman",
            "password": "secret",
            "name": "Travail",
            "calendar_href": "/dav/roman/travail/",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let id = json(&body)["id"].as_str().expect("id").to_string();

    let (status, body) = call(
        &state,
        Method::GET,
        &format!("/api/calendars/caldav/sources/{id}/collections"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    assert_eq!(json(&body).as_array().expect("liste").len(), 2);

    let (status, body) = call(
        &state,
        Method::PATCH,
        &format!("/api/calendars/caldav/sources/{id}"),
        Some(json!({ "calendar_href": "/dav/collegue/Calendar/" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let source = json(&body);
    assert_eq!(source["id"], id);
    assert!(source["calendar_href"]
        .as_str()
        .expect("href")
        .ends_with("/dav/collegue/Calendar/"));

    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    assert_eq!(json(&body)[0]["title"], "Revue de sprint");

    let (status, body) = call(
        &state,
        Method::PATCH,
        &format!("/api/calendars/caldav/sources/{id}"),
        Some(json!({ "calendar_href": "/dav/roman/disparu/" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "corps : {body:?}");
    assert_eq!(
        state
            .calendar_source(&id)
            .expect("source")
            .calendar_href
            .as_deref(),
        source["calendar_href"].as_str()
    );
}

#[tokio::test]
async fn a_source_update_is_validated() {
    let (_directory, state) = state().await;
    let url = serve().await;

    let (status, body) = call(
        &state,
        Method::POST,
        "/api/calendars/caldav/sources",
        Some(json!({ "url": url, "username": "roman", "password": "secret", "name": "Travail" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let id = json(&body)["id"].as_str().expect("id").to_string();

    let (status, body) = call(
        &state,
        Method::PATCH,
        &format!("/api/calendars/caldav/sources/{id}"),
        Some(json!({ "calendar_href": "  " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert!(json(&body)["error"]
        .as_str()
        .expect("message")
        .contains("chemin du calendrier"));

    let (status, body) = call(
        &state,
        Method::PATCH,
        &format!("/api/calendars/caldav/sources/{id}"),
        Some(json!({ "calendar_href": "https://ailleurs.tld/autre/" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert!(json(&body)["error"]
        .as_str()
        .expect("message")
        .contains("même serveur"));

    let (status, body) = call(
        &state,
        Method::PATCH,
        "/api/calendars/caldav/sources/inconnu",
        Some(json!({ "calendar_href": "/dav/roman/travail/" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "corps : {body:?}");

    let (status, body) = call(
        &state,
        Method::PATCH,
        &format!("/api/calendars/caldav/sources/{id}"),
        Some(json!({ "calendar_href": null })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    assert_eq!(json(&body)["calendar_href"], Value::Null);
}
