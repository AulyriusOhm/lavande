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
        new_mails: Vec::new(),
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

/// Compte OAuth2 en base, avec ses serveurs : de quoi déclencher une
/// reconnexion sans réseau.
async fn oauth_account(state: &Arc<AppState>) -> String {
    let config = lavande_mail::config::AccountConfig {
        id: "gmail".to_string(),
        label: "Gmail".to_string(),
        email: "roman@lavande.test".to_string(),
        username: "roman@lavande.test".to_string(),
        imap: lavande_mail::config::Endpoint {
            host: "127.0.0.1".to_string(),
            port: 9999,
            encryption: lavande_mail::config::Encryption::Tls,
        },
        smtp: lavande_mail::config::Endpoint {
            host: "127.0.0.1".to_string(),
            port: 9998,
            encryption: lavande_mail::config::Encryption::Tls,
        },
        auth: lavande_mail::config::AuthConfig::OAuth2 {
            client_id: "lavande-test".to_string(),
            client_secret: String::new(),
            refresh_token: "refresh-precedent".to_string(),
            token_endpoint: "https://oauth2.googleapis.com/token".to_string(),
        },
        synced_folders: None,
        ai_folders: None,
    };
    state.add_account(&config, &[]).await.expect("compte");
    config.id
}

/// Le veilleur réessaie toutes les 30 s : l'expiration ne doit être annoncée
/// qu'une fois, au passage de `false` à `true`, sinon le front reçoit la même
/// nouvelle en boucle.
#[tokio::test]
async fn a_revoked_authorization_is_announced_once() {
    let (_directory, state) = state().await;
    let account = oauth_account(&state).await;
    let request = Request::builder()
        .uri(format!("/api/events?token={}", state.token()))
        .body(Body::empty())
        .expect("requête");
    let response = app(state.clone()).oneshot(request).await.expect("réponse");
    let mut body = response.into_body().into_data_stream();

    state
        .mark_reauth_required(&account)
        .await
        .expect("marquage");
    state
        .mark_reauth_required(&account)
        .await
        .expect("second marquage");

    let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("événement attendu")
        .expect("chunk")
        .expect("octets");
    let text = String::from_utf8_lossy(&chunk);
    assert!(text.contains("event: mail"), "{text}");
    assert!(text.contains("\"account-reauth\""), "{text}");
    assert!(text.contains("\"account_id\":\"gmail\""), "{text}");
    assert!(text.contains("\"folder_path\":\"\""), "{text}");
    assert!(text.contains("\"report\":null"), "{text}");
    assert!(text.contains("\"new_mails\":[]"), "{text}");

    let again = tokio::time::timeout(Duration::from_millis(300), body.next()).await;
    assert!(again.is_err(), "un second marquage a republié : {again:?}");

    let stored = state.stored_account(&account).expect("compte");
    assert!(stored.needs_reauth, "le drapeau est persisté");
    state.clear_reauth(&account).await.expect("effacement");
    assert!(!state.stored_account(&account).expect("compte").needs_reauth);
}

/// Le drapeau ne s'écrit qu'une fois, même quand deux chemins (veilleur et
/// synchro) signalent la révocation en même temps.
#[tokio::test]
async fn marking_an_unknown_account_is_an_error() {
    let (_directory, state) = state().await;
    assert!(state.mark_reauth_required("absent").await.is_err());
    assert!(state.clear_reauth("absent").await.is_ok());
}
