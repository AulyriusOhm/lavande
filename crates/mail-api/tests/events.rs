//! Flux SSE : un événement diffusé arrive au client abonné.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures::StreamExt;
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::dto::FolderReport;
use lavande_mail_api::events::Event;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use tempfile::TempDir;
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

#[tokio::test]
async fn a_published_event_reaches_the_stream() {
    let (_directory, state) = state().await;
    let request = Request::builder()
        .uri(format!("/api/events?token={}", state.token()))
        .body(Body::empty())
        .expect("requête");
    let response = app(state.clone()).oneshot(request).await.expect("réponse");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );

    let mut body = response.into_body().into_data_stream();
    state.events().publish(Event {
        kind: "folder-updated",
        account_id: "perso".to_string(),
        folder_path: "INBOX".to_string(),
        report: Some(FolderReport::new("INBOX", Default::default())),
    });

    let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("événement attendu")
        .expect("chunk")
        .expect("octets");
    let text = String::from_utf8_lossy(&chunk);
    assert!(text.contains("event: mail"), "{text}");
    assert!(text.contains("\"folder-updated\""), "{text}");
    assert!(text.contains("\"account_id\":\"perso\""), "{text}");
}
