use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use lavande_mail::oauth::{xoauth2_payload, OAuth2Provider};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct Mock {
    endpoint: String,
    requests: Arc<AtomicUsize>,
    body: Arc<Mutex<Vec<u8>>>,
}

async fn mock(status: &'static str, response: &'static str) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("address");
    let requests = Arc::new(AtomicUsize::new(0));
    let body = Arc::new(Mutex::new(Vec::new()));
    let counter = Arc::clone(&requests);
    let captured = Arc::clone(&body);

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            *captured.lock().expect("lock") = read_request(&mut socket).await;
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.flush().await;
        }
    });

    Mock {
        endpoint: format!("http://{address}/token"),
        requests,
        body,
    }
}

async fn read_request(socket: &mut TcpStream) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 512];
    while let Ok(read) = socket.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        let Some(end) = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
        else {
            continue;
        };
        let length = buffer[..end]
            .split(|byte| *byte == b'\n')
            .filter_map(|line| line.strip_prefix(b"content-length: "))
            .next()
            .and_then(|value| std::str::from_utf8(value).ok())
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if buffer.len() >= end + length {
            break;
        }
    }
    buffer
}

#[test]
fn xoauth2_payload_is_exact() {
    assert_eq!(
        xoauth2_payload("roman@lavande.fr", "ya29.token"),
        "user=roman@lavande.fr\u{1}auth=Bearer ya29.token\u{1}\u{1}"
    );
}

#[tokio::test]
async fn access_token_is_cached_between_calls() {
    let server = mock(
        "200 OK",
        r#"{"access_token":"token-1","expires_in":3600,"token_type":"Bearer"}"#,
    )
    .await;
    let mut provider = OAuth2Provider::new(
        "client-id",
        "client-secret-value",
        "refresh-token-value",
        server.endpoint.clone(),
    );

    assert_eq!(provider.access_token().await.expect("first"), "token-1");
    assert_eq!(provider.access_token().await.expect("second"), "token-1");
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);

    let request = String::from_utf8(server.body.lock().expect("lock").clone()).expect("utf8");
    assert!(request.contains("grant_type=refresh_token"));
    assert!(request.contains("refresh_token=refresh-token-value"));
    assert!(request.contains("client_id=client-id"));
}

#[tokio::test]
async fn expired_token_is_refreshed_again() {
    let server = mock(
        "200 OK",
        r#"{"access_token":"token-1","expires_in":1,"token_type":"Bearer"}"#,
    )
    .await;
    let mut provider = OAuth2Provider::new("id", "secret", "refresh", server.endpoint.clone());

    provider.access_token().await.expect("first");
    provider.access_token().await.expect("second");
    assert_eq!(server.requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn oauth_error_is_readable_and_secret_free() {
    let server = mock(
        "400 Bad Request",
        r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
    )
    .await;
    let mut provider = OAuth2Provider::new(
        "client-id",
        "client-secret-value",
        "refresh-token-value",
        server.endpoint.clone(),
    );

    let error = provider.access_token().await.expect_err("must fail");
    let message = error.to_string();
    assert!(message.contains("invalid_grant"));
    assert!(message.contains("Token has been expired or revoked."));
    assert!(!message.contains("client-secret-value"));
    assert!(!message.contains("refresh-token-value"));
}
