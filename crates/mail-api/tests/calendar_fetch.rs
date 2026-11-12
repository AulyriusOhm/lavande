//! Import d'un calendrier par URL : le démon télécharge, le test sert en
//! boucle locale.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::routing::get;
use axum::Router;
use lavande_mail::ics::MAX_ICS_BYTES;
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

const ICS: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
BEGIN:VEVENT\r\n\
UID:distance\r\n\
SUMMARY:Point à distance\r\n\
DTSTART;TZID=Europe/Paris:20240315T180000\r\n\
DTEND;TZID=Europe/Paris:20240315T190000\r\n\
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

/// Serves `body` at `/calendrier.ics` on a loopback port.
async fn serve(body: String) -> String {
    async fn calendar(State(body): State<String>) -> String {
        body
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("écoute");
    let address = listener.local_addr().expect("adresse locale");
    let server = Router::new()
        .route("/calendrier.ics", get(calendar))
        .with_state(body);
    tokio::spawn(async move {
        axum::serve(listener, server)
            .await
            .expect("serveur de test");
    });
    format!("http://{address}/calendrier.ics")
}

async fn import(state: &Arc<AppState>, payload: Value) -> (StatusCode, Bytes) {
    let request = Request::builder()
        .method("POST")
        .uri("/api/calendars/ics")
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

#[tokio::test]
async fn a_fetched_calendar_keeps_the_url_as_source() {
    let (_directory, state) = state().await;
    let url = serve(ICS.to_string()).await;
    let (status, body) = import(&state, json!({ "url": url })).await;

    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let events = json(&body);
    assert_eq!(events.as_array().expect("liste").len(), 1);
    assert_eq!(events[0]["uid"], "distance");
    assert_eq!(events[0]["date"], "2024-03-15");
    assert_eq!(events[0]["start"], "18:00");
    assert_eq!(events[0]["end"], "19:00");
    assert_eq!(events[0]["timezone"], "Europe/Paris");
    assert_eq!(events[0]["source"], url.as_str());
}

#[tokio::test]
async fn a_fetched_calendar_above_the_size_limit_is_refused() {
    let (_directory, state) = state().await;
    let url = serve("A".repeat(MAX_ICS_BYTES + 1)).await;
    let (status, body) = import(&state, json!({ "url": url })).await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body:?}");
    assert_eq!(json(&body)["kind"], "calendar");
}
