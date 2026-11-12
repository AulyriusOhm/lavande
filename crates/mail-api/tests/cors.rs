//! CORS du démon : seules les origines de la coquille et du dev server passent.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use tempfile::TempDir;
use tower::ServiceExt;

const LEGITIMATE: [&str; 5] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

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

fn preflight(origin: &str) -> Request<Body> {
    Request::builder()
        .method("OPTIONS")
        .uri("/api/accounts")
        .header(header::ORIGIN, origin)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PATCH")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization,content-type",
        )
        .body(Body::empty())
        .expect("requête")
}

fn get(origin: &str) -> Request<Body> {
    Request::builder()
        .uri("/api/health")
        .header(header::ORIGIN, origin)
        .body(Body::empty())
        .expect("requête")
}

fn header_value(response: &axum::response::Response, name: header::HeaderName) -> Option<&str> {
    response.headers().get(name)?.to_str().ok()
}

#[tokio::test]
async fn legitimate_origin_preflight_is_accepted() {
    let (_directory, state) = state().await;
    let router = app(state);
    for origin in LEGITIMATE {
        let response = router
            .clone()
            .oneshot(preflight(origin))
            .await
            .expect("réponse");
        assert_eq!(response.status(), StatusCode::OK, "origine {origin}");
        assert_eq!(
            header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(origin),
            "origine {origin}"
        );
        let methods = header_value(&response, header::ACCESS_CONTROL_ALLOW_METHODS).unwrap_or("");
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            assert!(methods.contains(method), "{method} absent de {methods}");
        }
        let headers = header_value(&response, header::ACCESS_CONTROL_ALLOW_HEADERS).unwrap_or("");
        for name in ["authorization", "content-type"] {
            assert!(headers.contains(name), "{name} absent de {headers}");
        }
        assert!(!methods.contains("TRACE") && !methods.contains("CONNECT"));
        assert!(!headers.contains('*'));
    }
}

#[tokio::test]
async fn foreign_origin_preflight_is_refused() {
    let (_directory, state) = state().await;
    let router = app(state);
    for origin in ["https://exemple.test", "http://localhost:3000", "null"] {
        let response = router
            .clone()
            .oneshot(preflight(origin))
            .await
            .expect("réponse");
        assert!(
            header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(),
            "origine {origin} ne doit recevoir aucun allow-origin"
        );
    }
}

#[tokio::test]
async fn legitimate_origin_response_carries_allow_origin() {
    let (_directory, state) = state().await;
    let router = app(state);
    let response = router
        .clone()
        .oneshot(get("tauri://localhost"))
        .await
        .expect("réponse");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some("tauri://localhost")
    );
}

#[tokio::test]
async fn foreign_origin_response_carries_no_allow_origin() {
    let (_directory, state) = state().await;
    let router = app(state);
    let response = router
        .clone()
        .oneshot(get("https://exemple.test"))
        .await
        .expect("réponse");
    assert!(
        header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(),
        "aucune origine tierce ne doit être acceptée"
    );
}

#[tokio::test]
async fn request_without_origin_is_untouched() {
    let (_directory, state) = state().await;
    let router = app(state);
    let request = Request::builder()
        .uri("/api/health")
        .body(Body::empty())
        .expect("requête");
    let response = router.clone().oneshot(request).await.expect("réponse");
    assert_eq!(response.status(), StatusCode::OK);
    assert!(header_value(&response, header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
}
