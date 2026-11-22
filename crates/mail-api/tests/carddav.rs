//! Offline tests for `/api/accounts/{id}/carddav/sync`: the router is driven
//! directly, the address book is served by a fake CardDAV server on the
//! loopback interface. No network.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use lavande_mail::model::{Address, Flags, Folder, FolderRole, Message, PgpState};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

const PRINCIPAL: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop><D:current-user-principal><D:href>/principals/users/roman/</D:href></D:current-user-principal></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const HOME: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/principals/users/roman/</D:href>
    <D:propstat>
      <D:prop><card:addressbook-home-set><D:href>/dav/roman/</D:href></card:addressbook-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

const COLLECTIONS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/roman/Contacts/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><card:addressbook/></D:resourcetype>
        <D:displayname>Contacts</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

/// Two readable cards and one that carries no address.
const CARDS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/roman/Contacts/camille.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag><card:address-data>BEGIN:VCARD
VERSION:3.0
FN:Camille Roy
EMAIL;TYPE=INTERNET:camille@studio-lilas.fr
END:VCARD
</card:address-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/Contacts/marc.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"2"</D:getetag><card:address-data>BEGIN:VCARD
VERSION:4.0
FN:Marc Delaunay
EMAIL:marc@mail.fr
END:VCARD
</card:address-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/Contacts/casse.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"3"</D:getetag><card:address-data>BEGIN:VCARD
VERSION:3.0
FN:Sans adresse
END:VCARD
</card:address-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

/// The same book with one card gone: what a second sync must mirror.
const CARDS_REDUCED: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/roman/Contacts/camille.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag><card:address-data>BEGIN:VCARD
VERSION:3.0
FN:Camille Roy
EMAIL;TYPE=INTERNET:camille@studio-lilas.fr
END:VCARD
</card:address-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

/// Faux serveur DAV : `answers` associe « METHODE chemin » à sa réponse, tout le
/// reste répond 404. Le nombre d'appels est compté par route.
async fn serve(answers: Vec<(&'static str, &'static str)>) -> (String, Arc<Vec<AtomicUsize>>) {
    let counts = Arc::new(
        answers
            .iter()
            .map(|_| AtomicUsize::new(0))
            .collect::<Vec<_>>(),
    );
    let seen = counts.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("écoute");
    let address = listener.local_addr().expect("adresse locale");
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let answers = answers.clone();
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                let mut length = 0usize;
                let mut head = None;
                while let Ok(read) = socket.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&buffer).to_string();
                    if head.is_none() {
                        if let Some(end) = text.find("\r\n\r\n") {
                            length = text[..end]
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().ok())?
                                })
                                .unwrap_or(0);
                            head = Some(end + 4);
                        }
                    }
                    if let Some(start) = head {
                        if buffer.len() >= start + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&buffer).to_string();
                let mut parts = request
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .split_whitespace();
                let method = parts.next().unwrap_or_default();
                let path = parts.next().unwrap_or_default();
                let key = format!("{method} {path}");
                let response = match answers.iter().position(|(route, _)| *route == key) {
                    Some(index) => {
                        seen[index].fetch_add(1, Ordering::Relaxed);
                        let body = answers[index].1;
                        format!(
                            "HTTP/1.1 207 Multi-Status\r\n\
                             Content-Type: application/xml; charset=utf-8\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    }
                    None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\
                             Connection: close\r\n\r\n"
                        .to_string(),
                };
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (format!("http://{address}/dav/"), counts)
}

fn account(imap_host: &str) -> Value {
    json!({
        "id": "perso",
        "label": "Perso",
        "email": "roman@lavande.mail",
        "username": "roman@lavande.mail",
        "imap": { "host": imap_host, "port": 993, "encryption": "tls" },
        "smtp": { "host": imap_host, "port": 465, "encryption": "tls" },
        "auth": { "kind": "password", "password": "secret" }
    })
}

async fn state_in(directory: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::open_with(
            directory,
            TlsOptions::default(),
            Default::default(),
            SecretBackend::File,
        )
        .await
        .expect("état"),
    )
}

fn seed_account(directory: &Path, imap_host: &str) {
    fs::write(
        directory.join("accounts.json"),
        serde_json::to_vec_pretty(&[account(imap_host)]).expect("json"),
    )
    .expect("accounts.json");
}

/// One message the mailbox traded with Marc, so the store holds a mail contact.
fn seed_mail_contact(state: &Arc<AppState>) {
    state
        .store()
        .upsert_account("perso", "Perso", "roman@lavande.mail")
        .expect("compte");
    let folder = Folder {
        account_id: "perso".to_string(),
        path: "INBOX".to_string(),
        name: "Boîte de réception".to_string(),
        role: FolderRole::Inbox,
        uidvalidity: 1,
        uidnext: 2,
        last_sync_at: None,
        modseq: None,
        delimiter: None,
    };
    state.store().upsert_folder(&folder).expect("dossier");
    let message = Message {
        account_id: "perso".to_string(),
        folder_path: "INBOX".to_string(),
        uid: 1,
        uidvalidity: 1,
        thread_id: "t-marc".to_string(),
        message_id: Some("<m1@mail.fr>".to_string()),
        in_reply_to: None,
        references: Vec::new(),
        from: Address {
            name: Some("Marc Delaunay".to_string()),
            email: "marc@mail.fr".to_string(),
        },
        to: vec![Address {
            name: None,
            email: "roman@lavande.mail".to_string(),
        }],
        cc: Vec::new(),
        subject: "Planning".to_string(),
        date: chrono::TimeZone::with_ymd_and_hms(&chrono::Utc, 2026, 11, 10, 10, 0, 0).single(),
        flags: Flags::default(),
        size: 128,
        pgp: PgpState::None,
        pgp_detail: None,
        preview: "Planning".to_string(),
        body_text: Some("Planning".to_string()),
        body_html: None,
        attachments: Vec::new(),
    };
    state
        .store()
        .upsert_message_with_attachment(&message, false)
        .expect("message rangé");
    state
        .store()
        .set_body(
            "perso",
            "INBOX",
            1,
            &lavande_mail::ParsedMessage {
                subject: "Planning".to_string(),
                from: message.from.clone(),
                to: message.to.clone(),
                cc: Vec::new(),
                date: message.date,
                message_id: message.message_id.clone(),
                in_reply_to: None,
                references: Vec::new(),
                body_text: Some("Planning".to_string()),
                body_html: None,
                attachments: Vec::new(),
                pgp: PgpState::None,
                pgp_detail: None,
                preview: "Planning".to_string(),
            },
        )
        .expect("corps rangé");
}

async fn call(state: &Arc<AppState>, mut request: Request<Body>) -> (StatusCode, Bytes) {
    if !request.headers().contains_key("authorization") {
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", state.token())
                .parse()
                .expect("en-tête"),
        );
    }
    let response = app(state.clone())
        .oneshot(request)
        .await
        .expect("le routeur répond");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("corps de la réponse");
    (status, body)
}

fn json_of(body: &Bytes) -> Value {
    serde_json::from_slice(body).expect("corps JSON")
}

fn sync_request(url: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/accounts/perso/carddav/sync")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "url": url }).to_string()))
        .expect("requête")
}

fn contacts_request(query: &str) -> Request<Body> {
    Request::builder()
        .uri(format!("/api/contacts?q={query}&limit=20"))
        .body(Body::empty())
        .expect("requête")
}

#[tokio::test]
async fn a_sync_fills_the_contact_list_from_the_address_book() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed_account(directory.path(), "127.0.0.1");
    let (url, _) = serve(vec![
        ("PROPFIND /dav/", PRINCIPAL),
        ("PROPFIND /principals/users/roman/", HOME),
        ("PROPFIND /dav/roman/", COLLECTIONS),
        ("REPORT /dav/roman/Contacts/", CARDS),
    ])
    .await;
    let state = state_in(directory.path()).await;
    seed_mail_contact(&state);

    let (status, body) = call(&state, sync_request(&url)).await;

    assert_eq!(status, StatusCode::OK, "{body:?}");
    let report = json_of(&body);
    assert_eq!(report["count"], 2);
    assert_eq!(report["skipped"], 1);

    // Le carnet remonte par la route existante : les suggestions n'ont rien à changer.
    let (status, body) = call(&state, contacts_request("camille")).await;
    assert_eq!(status, StatusCode::OK);
    let found = json_of(&body);
    assert_eq!(found.as_array().expect("liste").len(), 1);
    assert_eq!(found[0]["email"], "camille@studio-lilas.fr");
    assert_eq!(found[0]["name"], "Camille Roy");
    assert_eq!(found[0]["received"], 0);
    assert_eq!(found[0]["sent"], 0);
}

#[tokio::test]
async fn a_second_sync_mirrors_the_cards_the_server_dropped() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed_account(directory.path(), "127.0.0.1");
    let (first, _) = serve(vec![
        ("PROPFIND /dav/", PRINCIPAL),
        ("PROPFIND /principals/users/roman/", HOME),
        ("PROPFIND /dav/roman/", COLLECTIONS),
        ("REPORT /dav/roman/Contacts/", CARDS),
    ])
    .await;
    let (second, _) = serve(vec![
        ("PROPFIND /dav/", PRINCIPAL),
        ("PROPFIND /principals/users/roman/", HOME),
        ("PROPFIND /dav/roman/", COLLECTIONS),
        ("REPORT /dav/roman/Contacts/", CARDS_REDUCED),
    ])
    .await;
    let state = state_in(directory.path()).await;

    let (status, body) = call(&state, sync_request(&first)).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(json_of(&body)["count"], 2);
    assert_eq!(
        json_of(&call(&state, contacts_request("marc")).await.1)
            .as_array()
            .expect("liste")
            .len(),
        1
    );

    let (status, body) = call(&state, sync_request(&second)).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let report = json_of(&body);
    assert_eq!(report["count"], 1);
    assert_eq!(report["skipped"], 0);

    // Marc n'est plus sur le serveur : il quitte le carnet, Camille reste.
    assert!(json_of(&call(&state, contacts_request("marc")).await.1)
        .as_array()
        .expect("liste")
        .is_empty());
    assert_eq!(
        json_of(&call(&state, contacts_request("camille")).await.1)
            .as_array()
            .expect("liste")
            .len(),
        1
    );
}

#[tokio::test]
async fn the_contact_of_a_mail_already_traded_survives_a_sync() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed_account(directory.path(), "127.0.0.1");
    let (url, counts) = serve(vec![
        ("PROPFIND /dav/", PRINCIPAL),
        ("PROPFIND /principals/users/roman/", HOME),
        ("PROPFIND /dav/roman/", COLLECTIONS),
        ("REPORT /dav/roman/Contacts/", CARDS_REDUCED),
    ])
    .await;
    let state = state_in(directory.path()).await;
    seed_mail_contact(&state);

    let (status, body) = call(&state, sync_request(&url)).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    // Marc reste : c'est une adresse échangée par mail, le carnet ne la touche pas.
    let (_, body) = call(&state, contacts_request("marc")).await;
    let found = json_of(&body);
    assert_eq!(found[0]["email"], "marc@mail.fr");
    assert_eq!(found[0]["name"], "Marc Delaunay");
    assert!(found[0]["received"].as_i64().unwrap_or_default() > 0);
    assert_eq!(counts[3].load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_url_outside_the_account_server_is_refused() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed_account(directory.path(), "127.0.0.1");
    let state = state_in(directory.path()).await;

    let (status, body) = call(&state, sync_request("https://ailleurs.tld/dav/")).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
    assert_eq!(json_of(&body)["kind"], "carddav");
}

#[tokio::test]
async fn a_refused_address_book_is_a_gateway_error() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed_account(directory.path(), "127.0.0.1");
    let (url, _) = serve(Vec::new()).await;
    let state = state_in(directory.path()).await;

    let (status, body) = call(&state, sync_request(&url)).await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body:?}");
    assert_eq!(json_of(&body)["kind"], "carddav");
    assert!(
        !String::from_utf8_lossy(&body).contains("secret"),
        "{body:?}"
    );
}

#[tokio::test]
async fn an_unknown_account_is_a_404() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    seed_account(directory.path(), "127.0.0.1");
    let state = state_in(directory.path()).await;

    let request = Request::builder()
        .method("POST")
        .uri("/api/accounts/inconnu/carddav/sync")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .expect("requête");
    let (status, _) = call(&state, request).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}
