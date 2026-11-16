//! Offline tests for `/api/accounts/{id}/threads/{thread_id}`: the router is
//! driven directly, the store is seeded by hand, no IMAP.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use lavande_mail::model::{Address, AttachmentMeta, Flags, Message, PgpState};
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

fn message(uid: u32, folder: &str, thread: &str, day: u32, name: &str) -> Message {
    Message {
        account_id: "perso".to_string(),
        folder_path: folder.to_string(),
        uid,
        uidvalidity: 1,
        thread_id: thread.to_string(),
        message_id: Some(format!("<m{uid}@x>")),
        in_reply_to: None,
        references: Vec::new(),
        from: Address {
            name: Some(name.to_string()),
            email: format!("{}@mail.fr", name.to_lowercase()),
        },
        to: Vec::new(),
        cc: Vec::new(),
        subject: "Planning".to_string(),
        date: chrono::TimeZone::with_ymd_and_hms(&chrono::Utc, 2026, 11, day, 10, 0, 0).single(),
        flags: Flags::default(),
        size: 10,
        pgp: PgpState::None,
        pgp_detail: None,
        preview: format!("preview {uid}"),
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
async fn a_thread_comes_back_with_every_folder() {
    let (directory, state) = state().await;
    seed(directory.path());
    let mut answer = message(2, "Sent", "t1", 11, "Roman");
    answer.attachments.push(AttachmentMeta {
        filename: "planning.pdf".to_string(),
        mime: "application/pdf".to_string(),
        size: 42,
        inline: false,
    });
    for mail in [
        message(1, "INBOX", "t1", 10, "Marc"),
        answer,
        message(3, "Archive", "t1", 12, "Lea"),
        message(4, "INBOX", "t2", 9, "Lea"),
    ] {
        state.store().upsert_message(&mail).expect("insert");
    }

    let (status, body) = call(&state, "/api/accounts/perso/threads/t1").await;
    assert_eq!(status, StatusCode::OK);
    let thread: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(thread["id"], json!("t1"));
    assert_eq!(thread["count"], json!(3));
    assert_eq!(thread["primary"]["uid"], json!(3));
    assert_eq!(thread["primary"]["folder_path"], json!("Archive"));
    assert_eq!(thread["attachments"], json!(1));
    assert_eq!(
        thread["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .map(|message| {
                (
                    message["folder_path"].as_str().expect("dossier"),
                    message["uid"].as_u64().expect("uid"),
                )
            })
            .collect::<Vec<_>>(),
        vec![("Archive", 3), ("Sent", 2), ("INBOX", 1)]
    );
    assert_eq!(thread["messages"][2]["body_text"], Value::Null);
}

#[tokio::test]
async fn an_unknown_thread_is_a_404() {
    let (directory, state) = state().await;
    seed(directory.path());
    state
        .store()
        .upsert_message(&message(1, "INBOX", "t1", 10, "Marc"))
        .expect("insert");

    let (status, _) = call(&state, "/api/accounts/perso/threads/absent").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_thread_of_an_unknown_account_is_a_404() {
    let (_directory, state) = state().await;
    let (status, _) = call(&state, "/api/accounts/absent/threads/t1").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
