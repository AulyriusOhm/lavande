//! Écriture CalDAV : création, mise à jour et suppression d'un événement sur
//! une source persistée, servies par un faux serveur WebDAV en boucle locale.

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

const PRINCIPAL_ANSWER: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<D:multistatus xmlns:D='DAV:'>
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop><D:current-user-principal><D:href>/principals/roman/</D:href></D:current-user-principal></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const HOME_ANSWER: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<D:multistatus xmlns:D='DAV:' xmlns:C='urn:ietf:params:xml:ns:caldav'>
  <D:response>
    <D:href>/principals/roman/</D:href>
    <D:propstat>
      <D:prop><C:calendar-home-set><D:href>/dav/roman/</D:href></C:calendar-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const COLLECTIONS_ANSWER: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<D:multistatus xmlns:D='DAV:' xmlns:C='urn:ietf:params:xml:ns:caldav'>
  <D:response>
    <D:href>/dav/roman/travail/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Travail</D:displayname></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/perso/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Perso</D:displayname></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

/// The ETag of `reunion.ics`, as a server quotes it.
const ETAG_ANSWER: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<D:multistatus xmlns:D='DAV:'>
  <D:response>
    <D:href>/dav/roman/travail/reunion.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>&quot;1&quot;</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

/// What our own `PUT` must look like: a whole `VCALENDAR` with one `VEVENT`.
fn calendar(body: &Bytes) -> bool {
    let text = String::from_utf8_lossy(body);
    text.starts_with("BEGIN:VCALENDAR\r\n")
        && text.contains("\r\nUID:")
        && text.contains("\r\nSUMMARY:")
        && text.contains("\r\nDTSTART")
        && text.contains("\r\nDTSTAMP:")
        && text.contains("PRODID:-//Lavande//Agenda//FR")
        && text.ends_with("END:VCALENDAR\r\n")
}

async fn dav(method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
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
    let if_match = headers
        .get("if-match")
        .and_then(|value| value.to_str().ok());
    let if_none_match = headers
        .get("if-none-match")
        .and_then(|value| value.to_str().ok());
    let xml = |body: &str| {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
            body.to_string(),
        )
            .into_response()
    };
    let stale = || (StatusCode::PRECONDITION_FAILED, "condition refusée").into_response();
    if method == Method::PUT && !calendar(&body) {
        return (StatusCode::BAD_REQUEST, "iCalendar refusé").into_response();
    }
    match (method.as_str(), uri.path(), depth) {
        ("PROPFIND", "/dav/", "0") => xml(PRINCIPAL_ANSWER),
        ("PROPFIND", "/principals/roman/", "0") => xml(HOME_ANSWER),
        ("PROPFIND", "/dav/roman/", "1") => xml(COLLECTIONS_ANSWER),
        ("PROPFIND", "/dav/roman/travail/reunion.ics", "0") => xml(ETAG_ANSWER),
        ("PROPFIND", "/dav/roman/travail/secours.ics", "0") => {
            (StatusCode::METHOD_NOT_ALLOWED, "PROPFIND refusé").into_response()
        }
        ("GET", "/dav/roman/travail/secours.ics", _) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/calendar; charset=utf-8"),
                (header::ETAG, "\"5\""),
            ],
            "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        )
            .into_response(),
        ("PUT", "/dav/roman/travail/secours.ics", _) => match if_match {
            Some("\"5\"") => (StatusCode::OK, [(header::ETAG, "\"6\"")]).into_response(),
            _ => stale(),
        },
        ("PUT", "/dav/roman/travail/reunion.ics", _) => match if_match {
            Some("\"1\"") => (StatusCode::OK, [(header::ETAG, "\"2\"")]).into_response(),
            _ => stale(),
        },
        ("PUT", _, _) => match if_none_match {
            Some("*") => (StatusCode::CREATED, [(header::ETAG, "\"7\"")]).into_response(),
            _ => stale(),
        },
        ("DELETE", "/dav/roman/travail/reunion.ics", _) => match if_match {
            Some("\"1\"") => StatusCode::NO_CONTENT.into_response(),
            _ => stale(),
        },
        ("DELETE", _, _) => (StatusCode::NOT_FOUND, "introuvable").into_response(),
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

/// A source whose credentials are in the vault, without going through the
/// setup route: the writes are what these tests cover.
async fn stored_source(state: &Arc<AppState>, url: &str, href: Option<&str>) -> String {
    state
        .add_calendar_source(
            "Travail",
            url,
            href.map(str::to_string),
            AccountSecrets::Caldav {
                username: "roman".to_string(),
                password: "secret".to_string(),
            },
        )
        .await
        .expect("source")
        .id
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

const TRAVAIL: Option<&str> = Some("/dav/roman/travail/");

#[tokio::test]
async fn an_event_is_created_in_a_stored_source() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events/create"),
        Some(json!({
            "title": "Revue de sprint",
            "date": "2024-03-15",
            "start": "14:00",
            "end": "15:00",
            "location": "Bureau",
            "description": "Point hebdomadaire"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let event = json(&body);
    let uid = event["uid"].as_str().expect("uid");
    assert!(uid.ends_with("@lavande"), "uid : {uid}");
    assert_eq!(event["title"], "Revue de sprint");
    assert_eq!(event["date"], "2024-03-15");
    assert_eq!(event["start"], "14:00");
    assert_eq!(event["end"], "15:00");
    assert_eq!(event["all_day"], false);
    assert_eq!(event["location"], "Bureau");
    assert_eq!(event["description"], "Point hebdomadaire");
    assert_eq!(event["source"], "Travail");
    assert_eq!(event["etag"], "\"7\"");
}

#[tokio::test]
async fn an_event_without_hours_is_a_whole_day() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events/create"),
        Some(json!({ "title": "Journée off", "date": "2024-03-20" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "corps : {body:?}");
    let event = json(&body);
    assert_eq!(event["all_day"], true);
    assert_eq!(event["start"], Value::Null);
    assert_eq!(event["end"], Value::Null);
}

#[tokio::test]
async fn an_event_is_updated_with_the_current_etag() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    let (status, body) = call(
        &state,
        Method::PUT,
        &format!("/api/calendars/caldav/sources/{id}/events/reunion"),
        Some(json!({
            "title": "Revue de sprint (déplacée)",
            "date": "2024-03-15",
            "start": "16:00",
            "end": "17:00"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    let event = json(&body);
    assert_eq!(event["uid"], "reunion");
    assert_eq!(event["title"], "Revue de sprint (déplacée)");
    assert_eq!(event["start"], "16:00");
    assert_eq!(event["etag"], "\"2\"");
}

/// A server refusing the PROPFIND leaves the `ETag` header of a `GET`.
#[tokio::test]
async fn an_event_is_updated_from_the_etag_of_a_get() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    let (status, body) = call(
        &state,
        Method::PUT,
        &format!("/api/calendars/caldav/sources/{id}/events/secours"),
        Some(json!({ "title": "Secours", "date": "2024-03-15" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "corps : {body:?}");
    assert_eq!(json(&body)["etag"], "\"6\"");
}

#[tokio::test]
async fn a_stale_etag_is_a_conflict() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    let (status, body) = call(
        &state,
        Method::PUT,
        &format!("/api/calendars/caldav/sources/{id}/events/reunion"),
        Some(json!({
            "title": "Revue de sprint",
            "date": "2024-03-15",
            "start": "16:00",
            "end": "17:00",
            "etag": "\"vieux\""
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "corps : {body:?}");
    let error = json(&body);
    assert_eq!(error["kind"], "caldav");
    let message = error["error"].as_str().expect("message");
    assert!(message.contains("412"), "message : {message}");
    assert!(!message.contains("secret"), "message : {message}");
}

#[tokio::test]
async fn an_event_is_deleted_with_its_etag() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    let (status, body) = call(
        &state,
        Method::DELETE,
        &format!("/api/calendars/caldav/sources/{id}/events/reunion?etag=%221%22"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "corps : {body:?}");
    assert!(body.is_empty());
}

#[tokio::test]
async fn deleting_an_unknown_event_is_a_404() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    let (status, body) = call(
        &state,
        Method::DELETE,
        &format!("/api/calendars/caldav/sources/{id}/events/inconnu"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "store");
}

#[tokio::test]
async fn a_write_to_an_unknown_source_is_a_404() {
    let (_directory, state) = state().await;
    let (status, body) = call(
        &state,
        Method::POST,
        "/api/calendars/caldav/sources/inconnue/events/create",
        Some(json!({ "title": "Revue", "date": "2024-03-15" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "corps : {body:?}");
}

#[tokio::test]
async fn a_write_needs_a_single_calendar() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, None).await;
    let (status, body) = call(
        &state,
        Method::POST,
        &format!("/api/calendars/caldav/sources/{id}/events/create"),
        Some(json!({ "title": "Revue", "date": "2024-03-15" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "corps : {body:?}");
    assert_eq!(json(&body)["kind"], "caldav");
}

#[tokio::test]
async fn an_event_without_a_title_or_a_date_is_refused() {
    let (_directory, state) = state().await;
    let url = serve().await;
    let id = stored_source(&state, &url, TRAVAIL).await;
    for payload in [
        json!({ "date": "2024-03-15" }),
        json!({ "title": "Revue" }),
        json!({ "title": "Revue", "date": "15/03/2024" }),
        json!({ "title": "Revue", "date": "2024-03-15", "start": "9h" }),
    ] {
        let (status, body) = call(
            &state,
            Method::POST,
            &format!("/api/calendars/caldav/sources/{id}/events/create"),
            Some(payload.clone()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "corps : {body:?} pour {payload}"
        );
    }
}

/// Serveur CalDAV réel : `CALDAV_TEST_URL`, `CALDAV_TEST_USER`,
/// `CALDAV_TEST_PASSWORD`, `CALDAV_TEST_CALENDAR` (Zimbra, Nextcloud, iCloud…).
#[tokio::test]
#[ignore]
async fn a_real_server_is_written() {
    let url = std::env::var("CALDAV_TEST_URL").expect("CALDAV_TEST_URL");
    let username = std::env::var("CALDAV_TEST_USER").expect("CALDAV_TEST_USER");
    let password = std::env::var("CALDAV_TEST_PASSWORD").expect("CALDAV_TEST_PASSWORD");
    let href = std::env::var("CALDAV_TEST_CALENDAR").expect("CALDAV_TEST_CALENDAR");
    let client =
        lavande_mail::caldav::CaldavClient::new(&url, &username, &password).expect("client");
    let uid = lavande_mail::ics::event_uid(None);
    let event = lavande_mail::ics::ExternalEvent {
        uid: Some(uid.clone()),
        title: "Test Lavande".to_string(),
        date: "2024-03-15".to_string(),
        start: Some("14:00".to_string()),
        end: Some("15:00".to_string()),
        ..Default::default()
    };
    let created = client
        .put_event(&href, &event, None)
        .await
        .expect("création");
    let current = client.get_etag(&href, &uid).await.expect("etag");
    assert!(
        created.is_some() || current.is_some(),
        "ni la réponse au PUT ni le PROPFIND ne donnent d'ETag"
    );
    let etag = current.or(created).expect("etag");
    let mut updated = event.clone();
    updated.title = "Test Lavande (modifié)".to_string();
    let after = client
        .put_event(&href, &updated, Some(&etag))
        .await
        .expect("mise à jour");
    client
        .delete_event(&href, &uid, after.as_deref().or(Some(&etag)))
        .await
        .expect("suppression");
}
