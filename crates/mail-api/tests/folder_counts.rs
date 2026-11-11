//! Offline tests for `/api/accounts/{id}/folder-counts`.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use lavande_mail::model::{Address, Flags, Message, PgpState};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

async fn state() -> (TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let state = AppState::open(directory.path(), TlsOptions::default())
        .await
        .expect("état");
    (directory, Arc::new(state))
}

fn seed(directory: &Path) {
    let accounts = json!([{
        "id": "perso",
        "label": "Perso",
        "email": "roman@lavande.mail",
        "username": "roman@lavande.mail",
        "imap": { "host": "imap.lavande.mail", "port": 993, "encryption": "tls" },
        "smtp": { "host": "smtp.lavande.mail", "port": 465, "encryption": "tls" },
        "auth": { "kind": "password", "password": "secret" }
    }]);
    fs::write(
        directory.join("accounts.json"),
        serde_json::to_vec_pretty(&accounts).expect("json"),
    )
    .expect("accounts.json");
}

fn message(uid: u32, folder: &str, unread: bool) -> Message {
    Message {
        account_id: "perso".to_string(),
        folder_path: folder.to_string(),
        uid,
        uidvalidity: 1,
        thread_id: format!("t{uid}"),
        message_id: Some(format!("<m{uid}@x>")),
        in_reply_to: None,
        references: Vec::new(),
        from: Address {
            name: None,
            email: "marc@mail.fr".to_string(),
        },
        to: Vec::new(),
        cc: Vec::new(),
        subject: format!("Sujet {uid}"),
        date: None,
        flags: Flags {
            unread,
            starred: false,
            answered: false,
        },
        size: 10,
        pgp: PgpState::None,
        preview: String::new(),
        body_text: None,
        body_html: None,
        attachments: Vec::new(),
    }
}

async fn call(state: &Arc<AppState>, uri: &str) -> (StatusCode, Bytes) {
    let request = Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {}", state.token()))
        .body(Body::empty())
        .expect("requête");
    let response = app(state.clone())
        .oneshot(request)
        .await
        .expect("le routeur répond");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("corps");
    (status, body)
}

#[tokio::test]
async fn folder_counts_report_totals_and_unread() {
    let (directory, state) = state().await;
    seed(directory.path());
    state
        .store()
        .upsert_message(&message(1, "INBOX", true))
        .expect("insert");
    state
        .store()
        .upsert_message(&message(2, "INBOX", false))
        .expect("insert");
    state
        .store()
        .upsert_message(&message(3, "Spam", true))
        .expect("insert");

    let (status, body) = call(&state, "/api/accounts/perso/folder-counts").await;
    assert_eq!(status, StatusCode::OK);
    let counts: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(
        counts,
        json!([
            { "path": "INBOX", "total": 2, "unread": 1 },
            { "path": "Spam", "total": 1, "unread": 1 },
        ])
    );
}

#[tokio::test]
async fn folder_counts_of_an_unknown_account_is_a_404() {
    let (_directory, state) = state().await;
    let (status, _) = call(&state, "/api/accounts/absent/folder-counts").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
