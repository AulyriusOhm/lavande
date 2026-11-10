//! `clientConfig v1.1` discovery: the recorded fixtures, the HTTP chain served
//! by a local server, and the two live cases kept behind `#[ignore]`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use lavande_mail::config::Encryption;
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::discovery::{parse, DiscoveryEndpoints};
use lavande_mail_api::dto::AuthKind;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;

const GMAIL: &str = include_str!("fixtures/ispdb_gmail.xml");
const LAPOSTE: &str = include_str!("fixtures/ispdb_laposte.xml");
const LANRO: &str = include_str!("fixtures/wellknown_lanro.xml");

const SYNTHETIC: &str = r#"<clientConfig version="1.1">
  <emailProvider id="exemple.fr">
    <domain>exemple.fr</domain>
    <displayName>Exemple</displayName>
    <incomingServer type="pop3">
      <hostname>pop.exemple.fr</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>IMAP.Exemple.FR</hostname>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%@%EMAILDOMAIN%</username>
      <authentication>GSSAPI</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.exemple.fr</hostname>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>"#;

fn state(endpoints: DiscoveryEndpoints) -> (TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let state =
        AppState::open_with(directory.path(), TlsOptions::default(), endpoints).expect("état");
    (directory, Arc::new(state))
}

async fn get(state: &Arc<AppState>, uri: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("requête");
    let response = app(state.clone())
        .oneshot(request)
        .await
        .expect("le routeur répond");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("corps de la réponse");
    (status, serde_json::from_slice(&body).expect("corps JSON"))
}

/// Every path answers with `body`, so no request can escape to the network.
async fn document_server(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("port libre");
    let address = listener.local_addr().expect("adresse");
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(answer(socket, body));
        }
    });
    format!("http://{address}")
}

async fn answer(mut socket: TcpStream, body: &'static str) {
    let mut request = [0u8; 2048];
    let _ = socket.read(&mut request).await;
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/xml\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// Answers 404 everywhere but on the `.well-known` path.
async fn well_known_server(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("port libre");
    let address = listener.local_addr().expect("adresse");
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(answer_routed(socket, body));
        }
    });
    format!("http://{address}")
}

async fn answer_routed(mut socket: TcpStream, body: &'static str) {
    let mut request = [0u8; 2048];
    let read = socket.read(&mut request).await.unwrap_or(0);
    let head = String::from_utf8_lossy(&request[..read]).into_owned();
    let response = if head.contains("/.well-known/autoconfig/") {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/xml\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    } else {
        "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string()
    };
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn mock_endpoints(base: &str) -> DiscoveryEndpoints {
    DiscoveryEndpoints {
        ispdb: format!("{base}/v1.1"),
        autoconfig: format!("{base}/mail/config-v1.1.xml?emailaddress={{email}}"),
        well_known: format!(
            "{base}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress={{email}}"
        ),
        plain_autoconfig: format!("{base}/mail/config-v1.1.xml"),
        guess: false,
    }
}

#[test]
fn parses_the_gmail_ispdb_document() {
    let config = parse(GMAIL).expect("gmail");
    assert_eq!(config.provider.as_deref(), Some("Google Mail"));
    assert_eq!(config.display_name.as_deref(), Some("Google Mail"));
    assert_eq!(config.incoming.host, "imap.gmail.com");
    assert_eq!(config.incoming.port, 993);
    assert_eq!(config.incoming.encryption, Encryption::Tls);
    assert_eq!(config.incoming.username, "%EMAILADDRESS%");
    assert_eq!(
        config.incoming.auth,
        vec![AuthKind::Password, AuthKind::OAuth2]
    );
    assert_eq!(config.outgoing.host, "smtp.gmail.com");
    assert_eq!(config.outgoing.port, 465);
    assert_eq!(config.outgoing.encryption, Encryption::Tls);
    assert_eq!(
        config.outgoing.auth,
        vec![AuthKind::Password, AuthKind::OAuth2]
    );
}

#[test]
fn parses_the_laposte_ispdb_document() {
    let config = parse(LAPOSTE).expect("laposte");
    assert_eq!(config.display_name.as_deref(), Some("LaPoste"));
    assert_eq!(config.incoming.host, "imap.laposte.net");
    assert_eq!(config.incoming.port, 993);
    assert_eq!(config.incoming.encryption, Encryption::Tls);
    assert_eq!(config.incoming.username, "%EMAILLOCALPART%");
    assert_eq!(config.incoming.auth, vec![AuthKind::Password]);
    assert_eq!(config.outgoing.host, "smtp.laposte.net");
    assert_eq!(config.outgoing.port, 465);
    assert_eq!(config.outgoing.username, "%EMAILLOCALPART%");
    assert_eq!(config.incoming.username_for("roman@laposte.net"), "roman");
}

#[test]
fn parses_the_lanro_well_known_document() {
    let config = parse(LANRO).expect("lanro");
    assert_eq!(config.display_name.as_deref(), Some("Courrier lanro.eu"));
    assert_eq!(config.incoming.host, "mail.lanro.eu");
    assert_eq!(config.incoming.port, 993);
    assert_eq!(config.incoming.encryption, Encryption::Tls);
    assert_eq!(config.outgoing.host, "mail.lanro.eu");
    assert_eq!(config.outgoing.port, 587);
    assert_eq!(config.outgoing.encryption, Encryption::StartTls);
    assert_eq!(config.outgoing.auth, vec![AuthKind::Password]);
    assert_eq!(
        config.incoming.username_for("roman@mail.lanro.eu"),
        "roman@mail.lanro.eu"
    );
}

#[test]
fn placeholders_and_defaults_are_resolved() {
    let config = parse(SYNTHETIC).expect("exemple.fr");
    assert_eq!(config.incoming.host, "imap.exemple.fr");
    assert_eq!(config.incoming.port, 143);
    assert_eq!(config.incoming.encryption, Encryption::StartTls);
    assert!(config.incoming.auth.is_empty(), "GSSAPI is not declarable");
    assert_eq!(
        config.incoming.username_for("roman@exemple.fr"),
        "roman@exemple.fr"
    );
    assert_eq!(config.outgoing.port, 587);
    assert_eq!(config.outgoing.username_for("roman@exemple.fr"), "roman");
}

#[test]
fn a_document_without_smtp_is_not_usable() {
    let only_incoming = r#"<clientConfig version="1.1"><emailProvider>
      <incomingServer type="imap"><hostname>imap.exemple.fr</hostname></incomingServer>
    </emailProvider></clientConfig>"#;
    assert!(parse(only_incoming).is_none());
    assert!(parse("<html><body>404</body></html>").is_none());
}

#[tokio::test]
async fn the_chain_starts_with_the_ispdb() {
    let base = document_server(GMAIL).await;
    let (_directory, state) = state(mock_endpoints(&base));
    let (status, payload) = get(&state, "/api/discover?email=roman@gmail.com").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["found"], true, "{payload}");
    assert_eq!(payload["source"], "ispdb");
    assert_eq!(payload["provider"], "Google Mail");
    assert_eq!(payload["display_name"], "Google Mail");
    assert!(payload["url"]
        .as_str()
        .expect("url")
        .ends_with("/v1.1/gmail.com"));
    assert_eq!(payload["incoming"]["host"], "imap.gmail.com");
    assert_eq!(payload["incoming"]["port"], 993);
    assert_eq!(payload["incoming"]["encryption"], "tls");
    assert_eq!(payload["incoming"]["username"], "roman@gmail.com");
    assert_eq!(payload["outgoing"]["host"], "smtp.gmail.com");
    assert_eq!(payload["outgoing"]["port"], 465);
    assert_eq!(payload["auth"], json!(["password", "oauth2"]));
    assert!(payload["reason"].is_null(), "{payload}");
}

#[tokio::test]
async fn the_chain_falls_through_to_the_domain_document() {
    let base = well_known_server(LANRO).await;
    let (_directory, state) = state(mock_endpoints(&base));
    let (status, payload) = get(&state, "/api/discover?email=roman@mail.lanro.eu").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["found"], true, "{payload}");
    assert_eq!(payload["source"], "well_known");
    assert!(payload["url"]
        .as_str()
        .expect("url")
        .contains("/.well-known/autoconfig/"));
    assert_eq!(payload["incoming"]["host"], "mail.lanro.eu");
    assert_eq!(payload["incoming"]["encryption"], "tls");
    assert_eq!(payload["outgoing"]["encryption"], "start_tls");
    assert_eq!(payload["outgoing"]["port"], 587);
    assert_eq!(payload["incoming"]["username"], "roman@mail.lanro.eu");
}

#[tokio::test]
async fn a_second_request_is_served_from_the_cache() {
    let base = document_server(LAPOSTE).await;
    let (_directory, state) = state(mock_endpoints(&base));
    let (_, first) = get(&state, "/api/discover?email=roman@laposte.net").await;
    assert_eq!(first["incoming"]["username"], "roman");
    let (_, second) = get(&state, "/api/discover?email=autre@laposte.net").await;
    assert_eq!(second["found"], true, "{second}");
    assert_eq!(second["incoming"]["username"], "autre");
    assert_eq!(second["url"], first["url"]);
}

#[tokio::test]
async fn an_unusable_document_is_not_found() {
    let base = document_server("<html><body>nope</body></html>").await;
    let (_directory, state) = state(mock_endpoints(&base));
    let (status, payload) = get(&state, "/api/discover?email=roman@exemple.fr").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["found"], false, "{payload}");
    assert!(payload["source"].is_null(), "{payload}");
    assert!(payload["reason"]
        .as_str()
        .is_some_and(|reason| !reason.is_empty()));
}

#[tokio::test]
async fn missing_or_invalid_address_is_a_400() {
    let (_directory, state) = state(mock_endpoints("http://127.0.0.1:9"));
    for uri in [
        "/api/discover?email=pasunemail",
        "/api/discover?email=roman%40",
        "/api/discover",
    ] {
        let (status, payload) = get(&state, uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(payload["kind"], "config", "{uri}");
        assert!(payload["error"]
            .as_str()
            .is_some_and(|text| !text.is_empty()));
    }
}

#[tokio::test]
#[ignore = "réseau : ISPDB puis autoconfig du domaine"]
async fn the_lanro_domain_is_discovered_live() {
    let (_directory, state) = state(DiscoveryEndpoints::default());
    let (status, payload) = get(&state, "/api/discover?email=roman@mail.lanro.eu").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["found"], true, "{payload}");
    assert_eq!(payload["incoming"]["host"], "mail.lanro.eu");
    assert_eq!(payload["incoming"]["port"], 993);
    assert_eq!(payload["incoming"]["encryption"], "tls");
    assert_eq!(payload["outgoing"]["host"], "mail.lanro.eu");
    assert_eq!(payload["outgoing"]["encryption"], "start_tls");
    assert_eq!(payload["auth"], json!(["password"]));
}

#[tokio::test]
#[ignore = "réseau : domaine inexistant"]
async fn an_unknown_domain_is_not_an_error_live() {
    let (_directory, state) = state(DiscoveryEndpoints::default());
    let (status, payload) = get(
        &state,
        "/api/discover?email=un-inexistant-xyz@example.invalid",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["found"], false, "{payload}");
    assert!(payload["source"].is_null(), "{payload}");
    assert!(payload["reason"]
        .as_str()
        .is_some_and(|reason| !reason.is_empty()));
}
