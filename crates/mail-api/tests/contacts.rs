//! Offline tests for `/api/contacts`: the router is driven directly, the store
//! is seeded by hand, no IMAP.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use lavande_mail::model::{Address, Flags, Folder, FolderRole, Message, PgpState};
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

fn account(id: &str, email: &str) -> Value {
    json!({
        "id": id,
        "label": id,
        "email": email,
        "username": email,
        "imap": { "host": "imap.lavande.mail", "port": 993, "encryption": "tls" },
        "smtp": { "host": "smtp.lavande.mail", "port": 465, "encryption": "tls" },
        "auth": { "kind": "password", "password": "secret" }
    })
}

fn seed(directory: &Path, accounts: &[Value]) {
    fs::write(
        directory.join("accounts.json"),
        serde_json::to_vec_pretty(accounts).expect("json"),
    )
    .expect("accounts.json");
}

fn setup(directory: &Path, state: &Arc<AppState>) {
    seed(
        directory,
        &[
            account("perso", "roman@lavande.mail"),
            account("pro", "roman@pro.fr"),
        ],
    );
    for (id, email) in [("perso", "roman@lavande.mail"), ("pro", "roman@pro.fr")] {
        state.store().upsert_account(id, id, email).expect("compte");
        for (path, role) in [("INBOX", FolderRole::Inbox), ("Sent", FolderRole::Sent)] {
            state
                .store()
                .upsert_folder(&Folder {
                    account_id: id.to_string(),
                    path: path.to_string(),
                    name: path.to_string(),
                    role,
                    uidvalidity: 1,
                    uidnext: 9,
                    last_sync_at: None,
                    modseq: None,
                    delimiter: None,
                })
                .expect("dossier");
        }
    }
}

fn message(
    account_id: &str,
    folder_path: &str,
    uid: u32,
    sender: (&str, &str),
    recipients: &[(&str, &str)],
    day: u32,
) -> Message {
    Message {
        account_id: account_id.to_string(),
        folder_path: folder_path.to_string(),
        uid,
        uidvalidity: 1,
        thread_id: format!("t{uid}"),
        message_id: Some(format!("<m{uid}@x>")),
        in_reply_to: None,
        references: Vec::new(),
        from: Address {
            name: Some(sender.0.to_string()),
            email: sender.1.to_string(),
        },
        to: recipients
            .iter()
            .map(|(name, email)| Address {
                name: Some(name.to_string()),
                email: email.to_string(),
            })
            .collect(),
        cc: Vec::new(),
        subject: "Planning".to_string(),
        date: chrono::TimeZone::with_ymd_and_hms(&chrono::Utc, 2026, 11, day, 10, 0, 0).single(),
        flags: Flags::default(),
        size: 10,
        pgp: PgpState::None,
        pgp_detail: None,
        preview: "aperçu".to_string(),
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
async fn contacts_merge_every_account() {
    let (directory, state) = state().await;
    setup(directory.path(), &state);
    let store = state.store();
    store
        .upsert_message(&message(
            "perso",
            "INBOX",
            1,
            ("Marc", "marc@mail.fr"),
            &[("Roman", "roman@lavande.mail")],
            10,
        ))
        .expect("reçu");
    store
        .upsert_message(&message(
            "perso",
            "Sent",
            2,
            ("Roman", "roman@lavande.mail"),
            &[("Marc", "marc@mail.fr")],
            11,
        ))
        .expect("envoyé");
    store
        .upsert_message(&message(
            "pro",
            "INBOX",
            3,
            ("Marc Delaunay", "MARC@mail.fr"),
            &[("Roman", "roman@pro.fr")],
            12,
        ))
        .expect("reçu");
    store
        .upsert_message(&message(
            "pro",
            "INBOX",
            4,
            ("Lea", "lea@mail.fr"),
            &[("Roman", "roman@pro.fr")],
            9,
        ))
        .expect("reçu");

    let (status, body) = call(&state, "/api/contacts").await;
    assert_eq!(status, StatusCode::OK);
    let contacts: Value = serde_json::from_slice(&body).expect("json");
    let listed = contacts.as_array().expect("liste");
    assert_eq!(
        listed.len(),
        2,
        "les deux comptes, dédoublonnés : {listed:?}"
    );
    assert_eq!(
        listed[0]["email"],
        json!("marc@mail.fr"),
        "le plus fréquent d'abord"
    );
    assert_eq!(listed[0]["received"], json!(2));
    assert_eq!(listed[0]["sent"], json!(1));
    assert_eq!(
        listed[0]["name"],
        json!("Marc Delaunay"),
        "le nom le plus récent"
    );
    assert_eq!(listed[0]["last_seen"], json!("2026-11-12T10:00:00Z"));
    assert_eq!(listed[1]["email"], json!("lea@mail.fr"));
    assert_eq!(listed[1]["received"], json!(1));
}

#[tokio::test]
async fn own_addresses_of_every_account_are_left_out() {
    let (directory, state) = state().await;
    setup(directory.path(), &state);
    let store = state.store();
    store
        .upsert_message(&message(
            "perso",
            "INBOX",
            1,
            ("Roman", "roman@pro.fr"),
            &[("Roman", "roman@lavande.mail")],
            10,
        ))
        .expect("reçu");
    store
        .upsert_message(&message(
            "perso",
            "INBOX",
            2,
            ("Marc", "marc@mail.fr"),
            &[("Roman", "roman@lavande.mail")],
            11,
        ))
        .expect("reçu");

    let (status, body) = call(&state, "/api/contacts").await;
    assert_eq!(status, StatusCode::OK);
    let contacts: Value = serde_json::from_slice(&body).expect("json");
    let emails: Vec<&str> = contacts
        .as_array()
        .expect("liste")
        .iter()
        .map(|contact| contact["email"].as_str().expect("email"))
        .collect();
    assert_eq!(emails, ["marc@mail.fr"]);
}

#[tokio::test]
async fn the_query_filters_the_name_or_the_address() {
    let (directory, state) = state().await;
    setup(directory.path(), &state);
    let store = state.store();
    for (uid, name, email) in [
        (1, "Marc Delaunay", "marc@mail.fr"),
        (2, "Lea", "lea@atelier.fr"),
    ] {
        store
            .upsert_message(&message(
                "perso",
                "INBOX",
                uid,
                (name, email),
                &[("Roman", "roman@lavande.mail")],
                10,
            ))
            .expect("reçu");
    }

    for (query, expected) in [
        ("marc", 1),
        ("DELAUNAY", 1),
        ("atelier", 1),
        ("mail.fr", 1),
        ("fr", 2),
        ("", 2),
        ("inconnu", 0),
        ("%", 0),
        ("_", 0),
    ] {
        let (status, body) = call(&state, &format!("/api/contacts?q={query}")).await;
        assert_eq!(status, StatusCode::OK);
        let contacts: Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(
            contacts.as_array().expect("liste").len(),
            expected,
            "q={query} → {contacts:?}"
        );
    }
}

#[tokio::test]
async fn the_limit_is_clamped() {
    let (directory, state) = state().await;
    setup(directory.path(), &state);
    let store = state.store();
    for (uid, email) in [(1, "a@mail.fr"), (2, "b@mail.fr"), (3, "c@mail.fr")] {
        store
            .upsert_message(&message(
                "perso",
                "INBOX",
                uid,
                ("Quelqu'un", email),
                &[("Roman", "roman@lavande.mail")],
                10,
            ))
            .expect("reçu");
    }

    let (status, body) = call(&state, "/api/contacts?limit=2").await;
    assert_eq!(status, StatusCode::OK);
    let contacts: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(contacts.as_array().expect("liste").len(), 2);

    let (status, body) = call(&state, "/api/contacts?limit=0").await;
    assert_eq!(status, StatusCode::OK);
    let contacts: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(
        contacts.as_array().expect("liste").len(),
        1,
        "au moins une ligne"
    );
}
