//! CalDAV en lecture seule : découverte des calendriers et récupération des
//! événements, servies par un faux serveur WebDAV en boucle locale.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, Method, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::SecretBackend;
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

async fn post(state: &Arc<AppState>, path: &str, payload: Value) -> (StatusCode, Bytes) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", state.token()))
        .body(Body::from(payload.to_string()))
        .expect("requête");
    let response = app(state.clone()).oneshot(request).await.expect("réponse");
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
