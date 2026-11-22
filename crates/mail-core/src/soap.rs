//! Zimbra SOAP client, JSON flavour: login, generic call, `GetInfo`.
//!
//! Zimbra serves every operation on one endpoint, `/service/soap`: the `Body`
//! names the operation and its namespace, the `AuthResponse` hands out the
//! `authToken` reused in the `Header.context` of the following calls. Both sides
//! speak JSON (`fmt=json`), so no XML is built or parsed here.
//!
//! The endpoint is the mail server of the account (`https://<hôte IMAP>/service/soap`):
//! the password travels in the `AuthRequest` body only, never in a URL, a log
//! line or an error message, and the token is not printed either. A token the
//! server no longer accepts is negotiated again once, then the refusal is
//! reported.

use std::sync::Mutex;
use std::time::Duration;

use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::MailError;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Largest SOAP answer read from the server.
const MAX_SOAP_BYTES: usize = 4 * 1024 * 1024;

/// Longest fault text kept in an error message.
const MAX_FAULT_CHARS: usize = 200;

/// The reply is JSON because the request body is: the server decides on the
/// body it parses, whatever the media type announces.
const CONTENT_TYPE: &str = "application/soap+xml; charset=utf-8";

const ACCEPT: &str = "application/json";

const ACCOUNT_NS: &str = "urn:zimbraAccount";
const ZIMBRA_NS: &str = "urn:zimbra";

/// Codes the server sends when the presented token is missing, expired or
/// refused: only a new `AuthRequest` can answer them. The server prefixes them
/// with the namespace of the component refusing (`account.AUTH_FAILED`,
/// `service.AUTH_REQUIRED`), so only the last segment is compared.
const AUTH_CODES: [&str; 3] = ["AUTH_FAILED", "AUTH_EXPIRED", "AUTH_REQUIRED"];

/// `AuthResponse`: the token every later call presents and the lifetime the
/// server announced, when it did. Its `Debug` masks the token.
#[derive(Clone, Deserialize, Serialize)]
pub struct AuthToken {
    #[serde(rename = "authToken")]
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<i64>,
}

impl std::fmt::Debug for AuthToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthToken")
            .field("token", &"<masqué>")
            .field("lifetime", &self.lifetime)
            .finish()
    }
}

/// What `GetInfo` says about the authenticated account.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AccountInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// JSON-SOAP client of one Zimbra account. It holds the password and the token
/// and prints neither: no `Debug`, no secret in an error message.
pub struct SoapClient {
    endpoint: Url,
    account: String,
    password: String,
    token: Mutex<Option<String>>,
    http: reqwest::Client,
}

impl SoapClient {
    pub fn new(endpoint: &str, account: &str, password: &str) -> Result<Self, MailError> {
        let account = account.trim();
        if account.is_empty() {
            return Err(MailError::Config("SOAP : compte vide".to_string()));
        }
        if password.is_empty() {
            return Err(MailError::Config("SOAP : mot de passe vide".to_string()));
        }
        let mut endpoint = parse_endpoint(endpoint)?;
        if endpoint.query().is_none() {
            endpoint.set_query(Some("fmt=json"));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Lavande/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| MailError::Soap(format!("client HTTP SOAP : {error}")))?;
        Ok(Self {
            endpoint,
            account: account.to_string(),
            password: password.to_string(),
            token: Mutex::new(None),
            http,
        })
    }

    /// Logs the account in: the password goes in the `AuthRequest` body, the
    /// answer becomes the session token.
    pub async fn authenticate(&self) -> Result<AuthToken, MailError> {
        let operation = json!({"AuthRequest": {
            "_jsns": ACCOUNT_NS,
            "account": {"by": "name", "_content": self.account},
            "password": self.password,
        }});
        let answer: AuthToken = answer(self.post(operation, None).await?)?;
        if answer.token.trim().is_empty() {
            return Err(MailError::Auth(format!(
                "{} n'a renvoyé aucun jeton",
                self.address()
            )));
        }
        self.store_token(answer.token.clone());
        Ok(answer)
    }

    /// One operation: `operation` is the `Body` (`{"GetInfoRequest": {...}}`)
    /// and the matching `...Response` is deserialized into `T`. A token the
    /// server refused is renewed once before the call is replayed.
    pub async fn request<T: DeserializeOwned>(&self, operation: Value) -> Result<T, MailError> {
        let token = match self.cached_token() {
            Some(token) => token,
            None => self.authenticate().await?.token,
        };
        let body = match self.post(operation.clone(), Some(&token)).await {
            Ok(body) => body,
            Err(error @ MailError::Auth(_)) => {
                tracing::debug!(%error, "jeton Zimbra refusé, renouvelé");
                let token = self.authenticate().await?.token;
                self.post(operation, Some(&token)).await?
            }
            Err(error) => return Err(error),
        };
        answer(body)
    }

    /// `GetInfo` of the account: its name, its id and the server version.
    pub async fn get_info(&self) -> Result<AccountInfo, MailError> {
        self.request(json!({"GetInfoRequest": {"_jsns": ACCOUNT_NS}}))
            .await
    }

    /// One POST. `token` is `None` for the `AuthRequest` itself.
    async fn post(&self, operation: Value, token: Option<&str>) -> Result<Value, MailError> {
        let mut context = Map::new();
        context.insert("_jsns".to_string(), json!(ZIMBRA_NS));
        if let Some(token) = token {
            context.insert("authToken".to_string(), json!(token));
        }
        let payload = json!({"Header": {"context": Value::Object(context)}, "Body": operation});
        let response = self
            .http
            .post(self.endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, CONTENT_TYPE)
            .header(reqwest::header::ACCEPT, ACCEPT)
            .body(payload.to_string())
            .send()
            .await
            .map_err(|error| {
                MailError::Soap(format!("{} injoignable : {error}", self.address()))
            })?;
        let status = response.status();
        let text = answer_body(response).await?;
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            return Err(MailError::Auth(format!(
                "identifiants Zimbra refusés par {} ({})",
                self.address(),
                status.as_u16()
            )));
        }
        let answer: Value = serde_json::from_str(&text)
            .map_err(|error| MailError::Soap(format!("réponse SOAP illisible : {error}")))?;
        let body = answer
            .get("Body")
            .ok_or_else(|| MailError::Soap("réponse SOAP sans « Body »".to_string()))?;
        if let Some(fault) = fault(body) {
            return Err(fault.error());
        }
        Ok(body.clone())
    }

    /// The token of the last `AuthRequest`: the lock is taken and released here,
    /// so no guard can travel across the `await` of a call.
    fn cached_token(&self) -> Option<String> {
        self.token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn store_token(&self, token: String) {
        *self
            .token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(token);
    }

    /// Host and port of the endpoint: what an error message may show.
    fn address(&self) -> String {
        match (self.endpoint.host_str(), self.endpoint.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_string(),
            (None, _) => self.endpoint.path().to_string(),
        }
    }
}

/// SOAP endpoint of a mail account: the IMAP host, in HTTPS. A numeric loopback
/// host is joined in clear, the way the CalDAV source of a test account is.
pub fn account_endpoint(host: &str) -> String {
    let host = host.trim();
    let name = host.split(':').next().unwrap_or_default();
    let scheme = if name == "127.0.0.1" { "http" } else { "https" };
    format!("{scheme}://{host}/service/soap")
}

/// The `...Response` of a `Body`: the only named member of a successful answer.
fn answer<T: DeserializeOwned>(body: Value) -> Result<T, MailError> {
    let Value::Object(fields) = body else {
        return Err(MailError::Soap("réponse SOAP inattendue".to_string()));
    };
    let (name, value) = fields
        .into_iter()
        .find(|(name, _)| name.ends_with("Response"))
        .ok_or_else(|| MailError::Soap("réponse SOAP sans réponse nommée".to_string()))?;
    serde_json::from_value(value)
        .map_err(|error| MailError::Soap(format!("réponse {name} illisible : {error}")))
}

/// `Body.Fault` of a failed call: the code decides whether a new token can
/// help, the reason says what the server refused.
struct Fault {
    code: String,
    text: String,
}

impl Fault {
    fn error(self) -> MailError {
        let text: String = self.text.chars().take(MAX_FAULT_CHARS).collect();
        if is_auth_code(&self.code) {
            return MailError::Auth(format!("{} ({})", text, self.code));
        }
        MailError::Soap(format!("{} ({})", text, self.code))
    }
}

fn is_auth_code(code: &str) -> bool {
    let name = code.rsplit('.').next().unwrap_or(code);
    AUTH_CODES.contains(&name)
}

fn fault(body: &Value) -> Option<Fault> {
    let fault = body.get("Fault")?;
    let code = fault
        .pointer("/Detail/Error/Code")
        .or_else(|| fault.pointer("/Code/Value"))
        .and_then(Value::as_str)
        .unwrap_or("soap:SoapFault");
    let text = fault
        .pointer("/Reason/Text")
        .and_then(Value::as_str)
        .unwrap_or("requête refusée par le serveur Zimbra");
    Some(Fault {
        code: code.to_string(),
        text: text.to_string(),
    })
}

fn parse_endpoint(raw: &str) -> Result<Url, MailError> {
    let url = Url::parse(raw.trim())
        .map_err(|error| MailError::Config(format!("URL SOAP invalide : {error}")))?;
    match url.scheme() {
        "https" => {}
        "http" if url.host_str().is_some_and(is_loopback) => {}
        "http" => {
            return Err(MailError::Config(
                "SOAP : HTTPS requis hors boucle locale".to_string(),
            ))
        }
        scheme => {
            return Err(MailError::Config(format!(
                "schéma d'URL refusé : « {scheme} » (http ou https)"
            )))
        }
    }
    if url.host_str().is_none() {
        return Err(MailError::Config("URL SOAP sans hôte".to_string()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(MailError::Config(
            "l'URL SOAP ne doit pas porter d'identifiants".to_string(),
        ));
    }
    Ok(url)
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost")
}

async fn answer_body(mut response: reqwest::Response) -> Result<String, MailError> {
    if let Some(announced) = response.content_length() {
        if announced > MAX_SOAP_BYTES as u64 {
            return Err(too_large());
        }
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| MailError::Soap(format!("réponse interrompue : {error}")))?
    {
        if buffer.len() + chunk.len() > MAX_SOAP_BYTES {
            return Err(too_large());
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer).map_err(|_| MailError::Soap("réponse SOAP non UTF-8".to_string()))
}

fn too_large() -> MailError {
    MailError::Soap(format!(
        "réponse SOAP trop volumineuse (maximum {MAX_SOAP_BYTES} octets)"
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const AUTH_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
        "Body":{"AuthResponse":{"_jsns":"urn:zimbraAccount","authToken":"jeton-1","lifetime":43199999}}}"#;

    const EXPIRED_ANSWER: &str = r#"{"Body":{"Fault":{"Reason":{"Text":"auth credentials have expired"},
        "Detail":{"Error":{"Code":"service.AUTH_EXPIRED"}}}}}"#;

    /// The real server prefixes the code with the component that refused and
    /// answers HTTP 500, both copied from mailserver.grenoble.archi.fr.
    const REFUSED_ANSWER: &str = r#"{"Body":{"Fault":{"Code":{"Value":"soap:Sender"},
        "Reason":{"Text":"authentication failed for [roman]"},
        "Detail":{"Error":{"Code":"account.AUTH_FAILED"}}}}}"#;

    const FAILURE_ANSWER: &str = r#"{"Body":{"Fault":{"Code":{"Value":"soap:Receiver"},
        "Reason":{"Text":"service failure"},
        "Detail":{"Error":{"Code":"service.FAILURE"}}}}}"#;

    const INFO_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
        "Body":{"GetInfoResponse":{"_jsns":"urn:zimbraAccount",
        "name":"roman@exemple.tld","id":"7f2c","version":"9.0.0_GA_4642"}}}"#;

    /// Faux Zimbra : une réponse par requête, dans l'ordre, et les corps reçus.
    async fn serve(answers: Vec<&'static str>) -> (String, Arc<Mutex<Vec<Value>>>) {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("écoute");
        let address = listener.local_addr().expect("adresse locale");
        let received = Arc::new(Mutex::new(Vec::new()));
        let seen = received.clone();
        let mut answers = answers.into_iter();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let seen = seen.clone();
                let answer = answers.next().unwrap_or(r#"{"Body":{}}"#);
                tokio::spawn(async move {
                    if let Some(body) = read_request(&mut socket).await {
                        if let Ok(value) = serde_json::from_str::<Value>(&body) {
                            seen.lock().expect("journal").push(value);
                        }
                    }
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                        answer.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{address}/service/soap"), received)
    }

    /// Corps d'une requête, une fois l'en-tête et son `Content-Length` lus.
    async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<String> {
        use tokio::io::AsyncReadExt;

        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut start = None;
        let mut length = 0usize;
        while let Ok(read) = socket.read(&mut chunk).await {
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&buffer).to_string();
            if start.is_none() {
                if let Some(end) = text.find("\r\n\r\n") {
                    length = text[..end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    start = Some(end + 4);
                }
            }
            if let Some(begin) = start {
                if buffer.len() >= begin + length {
                    return String::from_utf8(buffer[begin..begin + length].to_vec()).ok();
                }
            }
        }
        None
    }

    #[tokio::test]
    async fn the_login_hands_out_the_token_get_info_uses() {
        let (url, received) = serve(vec![AUTH_ANSWER, INFO_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let info = client.get_info().await.expect("GetInfo");
        assert_eq!(info.name.as_deref(), Some("roman@exemple.tld"));
        assert_eq!(info.id.as_deref(), Some("7f2c"));
        assert_eq!(info.version.as_deref(), Some("9.0.0_GA_4642"));
        let requests = received.lock().expect("journal");
        assert_eq!(requests.len(), 2);
        let login = &requests[0]["Body"]["AuthRequest"];
        assert_eq!(login["_jsns"], "urn:zimbraAccount");
        assert_eq!(login["account"]["by"], "name");
        assert_eq!(login["account"]["_content"], "roman@exemple.tld");
        assert_eq!(login["password"], "secret");
        assert!(requests[0]["Header"]["context"].get("authToken").is_none());
        let call = &requests[1];
        assert!(call["Body"].get("GetInfoRequest").is_some());
        assert_eq!(call["Header"]["context"]["authToken"], "jeton-1");
        assert_eq!(call["Header"]["context"]["_jsns"], "urn:zimbra");
    }

    #[tokio::test]
    async fn the_token_stays_out_of_debug() {
        let (url, _) = serve(vec![AUTH_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let token = client.authenticate().await.expect("entrée");
        assert_eq!(token.token, "jeton-1");
        assert!(!format!("{token:?}").contains("jeton-1"));
    }

    #[tokio::test]
    async fn a_refused_login_never_echoes_the_password() {
        let (url, _) = serve(vec![REFUSED_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let error = client.get_info().await.expect_err("refus");
        assert!(matches!(error, MailError::Auth(_)), "{error}");
        assert!(error.to_string().contains("account.AUTH_FAILED"), "{error}");
        assert!(!error.to_string().contains("secret"), "{error}");
    }

    #[tokio::test]
    async fn a_soap_fault_the_token_cannot_fix_is_not_replayed() {
        let (url, received) = serve(vec![AUTH_ANSWER, FAILURE_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let error = client.get_info().await.expect_err("faute serveur");
        assert!(matches!(error, MailError::Soap(_)), "{error}");
        assert!(error.to_string().contains("service.FAILURE"), "{error}");
        let requests = received.lock().expect("journal");
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn an_expired_token_is_renewed_once() {
        let (url, received) =
            serve(vec![AUTH_ANSWER, EXPIRED_ANSWER, AUTH_ANSWER, INFO_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        client.authenticate().await.expect("entrée");
        let info = client
            .get_info()
            .await
            .expect("GetInfo après renouvellement");
        assert_eq!(info.name.as_deref(), Some("roman@exemple.tld"));
        let requests = received.lock().expect("journal");
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0]["Header"]["context"].get("authToken"), None);
        assert!(requests[1]["Body"].get("GetInfoRequest").is_some());
        assert!(requests[2]["Body"].get("AuthRequest").is_some());
        assert!(requests[3]["Body"].get("GetInfoRequest").is_some());
        assert_eq!(requests[3]["Header"]["context"]["authToken"], "jeton-1");
    }

    #[tokio::test]
    async fn a_silent_server_is_a_soap_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("écoute");
        let address = listener.local_addr().expect("adresse locale");
        drop(listener);
        let url = format!("http://{address}/service/soap");
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let error = client.get_info().await.expect_err("serveur absent");
        assert!(matches!(error, MailError::Soap(_)), "{error}");
        assert!(!error.to_string().contains("secret"), "{error}");
    }

    #[test]
    fn an_endpoint_outside_loopback_needs_https() {
        let error = match SoapClient::new("http://mail.exemple.tld/service/soap", "roman", "secret")
        {
            Ok(_) => panic!("http hors boucle locale accepté"),
            Err(error) => error,
        };
        assert!(matches!(error, MailError::Config(_)), "{error}");
        let client = SoapClient::new("https://mail.exemple.tld/service/soap", "roman", "secret")
            .expect("client");
        assert_eq!(
            client.endpoint.as_str(),
            "https://mail.exemple.tld/service/soap?fmt=json"
        );
    }

    #[test]
    fn the_account_endpoint_follows_the_imap_host() {
        assert_eq!(
            account_endpoint(" zimap.exemple.tld "),
            "https://zimap.exemple.tld/service/soap"
        );
        assert_eq!(
            account_endpoint("127.0.0.1:8080"),
            "http://127.0.0.1:8080/service/soap"
        );
    }
}
