//! `clientConfig v1.1` discovery: Thunderbird's ISPDB, then the domain's own
//! autoconfig document, then a probe of the usual host names.
//!
//! Answers are cached per domain; a failure is remembered for a few minutes
//! only, so a server that comes back is seen again quickly.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lavande_mail::config::Encryption;
use lavande_mail::error::MailError;
use lavande_mail::http::client_builder;
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::QName;
use quick_xml::Reader;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;

use crate::dto::{AuthKind, DiscoverResponse, Source, SuggestedEndpoint};

const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(3);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);
const SUCCESS_TTL: Duration = Duration::from_secs(3600);
const FAILURE_TTL: Duration = Duration::from_secs(300);
const MAX_CACHED_DOMAINS: usize = 512;

const EMAIL_ADDRESS: &str = "%EMAILADDRESS%";
const EMAIL_LOCAL_PART: &str = "%EMAILLOCALPART%";
const EMAIL_DOMAIN: &str = "%EMAILDOMAIN%";

const IMAP_HOSTS: [&str; 3] = ["imap", "mail", ""];
const SMTP_HOSTS: [&str; 3] = ["smtp", "mail", ""];
const IMAP_PORT: u16 = 993;
const SMTP_TLS_PORT: u16 = 465;
const SMTP_STARTTLS_PORT: u16 = 587;

/// Where the chain looks. The tests swap the URLs for a local server.
#[derive(Clone, Debug)]
pub struct DiscoveryEndpoints {
    pub ispdb: String,
    pub autoconfig: String,
    pub well_known: String,
    pub plain_autoconfig: String,
    pub guess: bool,
}

impl Default for DiscoveryEndpoints {
    fn default() -> Self {
        Self {
            ispdb: "https://autoconfig.thunderbird.net/v1.1".to_string(),
            autoconfig: "https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={email}"
                .to_string(),
            well_known:
                "https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress={email}"
                    .to_string(),
            plain_autoconfig: "http://autoconfig.{domain}/mail/config-v1.1.xml".to_string(),
            guess: true,
        }
    }
}

/// A usable `clientConfig`, placeholders included: the username is only
/// resolved against the address that asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub provider: Option<String>,
    pub display_name: Option<String>,
    pub incoming: Server,
    pub outgoing: Server,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub encryption: Encryption,
    pub username: String,
    pub auth: Vec<AuthKind>,
}

impl Server {
    /// `username` with the `clientConfig` placeholders replaced.
    pub fn username_for(&self, email: &str) -> String {
        let (local, domain) = email.rsplit_once('@').unwrap_or((email, ""));
        self.username
            .replace(EMAIL_ADDRESS, email)
            .replace(EMAIL_LOCAL_PART, local)
            .replace(EMAIL_DOMAIN, domain)
    }

    fn response(&self, email: &str) -> SuggestedEndpoint {
        SuggestedEndpoint {
            host: self.host.clone(),
            port: self.port,
            encryption: self.encryption,
            username: self.username_for(email),
        }
    }
}

#[derive(Clone)]
struct Template {
    source: Source,
    url: Option<String>,
    config: Config,
}

impl Template {
    fn response(&self, email: &str) -> DiscoverResponse {
        let mut auth = self.config.incoming.auth.clone();
        auth.extend(self.config.outgoing.auth.iter().copied());
        auth.sort();
        auth.dedup();
        DiscoverResponse {
            found: true,
            source: Some(self.source),
            url: self.url.clone(),
            provider: self.config.provider.clone(),
            display_name: self.config.display_name.clone(),
            incoming: Some(self.config.incoming.response(email)),
            outgoing: Some(self.config.outgoing.response(email)),
            auth,
            reason: None,
        }
    }
}

struct Entry {
    expires: Instant,
    config: Option<Template>,
}

pub struct Discovery {
    client: reqwest::Client,
    endpoints: DiscoveryEndpoints,
    tls: Arc<ClientConfig>,
    cache: Mutex<HashMap<String, Entry>>,
}

impl Discovery {
    pub fn new(endpoints: DiscoveryEndpoints) -> Result<Self, MailError> {
        let client = client_builder()
            .timeout(ATTEMPT_TIMEOUT)
            .user_agent(concat!("Lavande/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| MailError::Config(format!("client HTTP de découverte : {error}")))?;
        let roots = RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let tls = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            client,
            endpoints,
            tls: Arc::new(tls),
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// Never fails: "nothing found" is a normal answer, the address is assumed
    /// valid and `domain` already lowercased by the caller.
    pub async fn discover(&self, email: &str, domain: &str) -> DiscoverResponse {
        if let Some(cached) = self.cached(domain) {
            return match cached {
                Some(template) => template.response(email),
                None => {
                    DiscoverResponse::missing(format!("aucune configuration pour « {domain} »"))
                }
            };
        }
        let fetched = match timeout(DISCOVERY_TIMEOUT, self.fetch(email, domain)).await {
            Ok(fetched) => fetched,
            Err(_) => {
                tracing::debug!(domain, "découverte interrompue par le délai");
                return DiscoverResponse::missing(format!(
                    "délai de découverte dépassé pour « {domain} »"
                ));
            }
        };
        self.remember(domain, &fetched);
        match fetched {
            Some(template) => template.response(email),
            None => {
                DiscoverResponse::missing(format!("aucune configuration publiée pour « {domain} »"))
            }
        }
    }

    fn cached(&self, domain: &str) -> Option<Option<Template>> {
        let cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        let entry = cache.get(domain)?;
        (entry.expires > Instant::now()).then(|| entry.config.clone())
    }

    fn remember(&self, domain: &str, config: &Option<Template>) {
        let ttl = if config.is_some() {
            SUCCESS_TTL
        } else {
            FAILURE_TTL
        };
        let entry = Entry {
            expires: Instant::now() + ttl,
            config: config.clone(),
        };
        let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        if cache.len() >= MAX_CACHED_DOMAINS {
            cache.clear();
        }
        cache.insert(domain.to_string(), entry);
    }

    async fn fetch(&self, email: &str, domain: &str) -> Option<Template> {
        let quoted = percent_encode(email);
        let ispdb = format!("{}/{}", self.endpoints.ispdb.trim_end_matches('/'), domain);
        let candidates = [
            (Source::Ispdb, ispdb),
            (
                Source::Autoconfig,
                fill(&self.endpoints.autoconfig, domain, &quoted),
            ),
            (
                Source::WellKnown,
                fill(&self.endpoints.well_known, domain, &quoted),
            ),
            (
                Source::Autoconfig,
                fill(&self.endpoints.plain_autoconfig, domain, &quoted),
            ),
        ];
        let documents = candidates
            .iter()
            .map(|(source, url)| self.document(url, *source));
        if let Some(template) = futures::future::join_all(documents)
            .await
            .into_iter()
            .flatten()
            .next()
        {
            return Some(template);
        }
        if self.endpoints.guess {
            return self.probe(domain).await;
        }
        None
    }

    async fn document(&self, url: &str, source: Source) -> Option<Template> {
        let response = self.client.get(url).send().await.ok()?;
        if !response.status().is_success() {
            tracing::debug!(source = ?source, "document clientConfig absent");
            return None;
        }
        let body = response.text().await.ok()?;
        let config = parse(&body)?;
        tracing::debug!(source = ?source, "document clientConfig retenu");
        Some(Template {
            source,
            url: Some(url.to_string()),
            config,
        })
    }

    async fn probe(&self, domain: &str) -> Option<Template> {
        let mut incoming = None;
        for host in hosts(domain, &IMAP_HOSTS) {
            if self.banner(&host, IMAP_PORT, b"* OK").await {
                incoming = Some(probed(host, IMAP_PORT, Encryption::Tls));
                break;
            }
        }
        let incoming = incoming?;

        let mut outgoing = None;
        for host in hosts(domain, &SMTP_HOSTS) {
            if self.banner(&host, SMTP_TLS_PORT, b"220").await {
                outgoing = Some(probed(host, SMTP_TLS_PORT, Encryption::Tls));
                break;
            }
        }
        if outgoing.is_none() {
            for host in hosts(domain, &SMTP_HOSTS) {
                if self.reachable(&host, SMTP_STARTTLS_PORT).await {
                    outgoing = Some(probed(host, SMTP_STARTTLS_PORT, Encryption::StartTls));
                    break;
                }
            }
        }
        Some(Template {
            source: Source::Guess,
            url: None,
            config: Config {
                provider: None,
                display_name: None,
                incoming,
                outgoing: outgoing?,
            },
        })
    }

    /// Connects, hands the certificate to webpki and reads the greeting.
    async fn banner(&self, host: &str, port: u16, expected: &[u8]) -> bool {
        let attempt = async {
            let tcp = TcpStream::connect((host, port)).await.ok()?;
            let name = ServerName::try_from(host.to_string()).ok()?;
            let mut stream = TlsConnector::from(self.tls.clone())
                .connect(name, tcp)
                .await
                .ok()?;
            let mut buffer = [0u8; 128];
            let read = stream.read(&mut buffer).await.ok()?;
            Some(buffer[..read].starts_with(expected))
        };
        matches!(timeout(ATTEMPT_TIMEOUT, attempt).await, Ok(Some(true)))
    }

    async fn reachable(&self, host: &str, port: u16) -> bool {
        matches!(
            timeout(ATTEMPT_TIMEOUT, TcpStream::connect((host, port))).await,
            Ok(Ok(_))
        )
    }
}

fn probed(host: String, port: u16, encryption: Encryption) -> Server {
    Server {
        host,
        port,
        encryption,
        username: EMAIL_ADDRESS.to_string(),
        auth: Vec::new(),
    }
}

fn hosts(domain: &str, prefixes: &[&str]) -> Vec<String> {
    prefixes
        .iter()
        .map(|prefix| {
            if prefix.is_empty() {
                domain.to_string()
            } else {
                format!("{prefix}.{domain}")
            }
        })
        .collect()
}

fn fill(pattern: &str, domain: &str, email: &str) -> String {
    pattern
        .replace("{domain}", domain)
        .replace("{email}", email)
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// The first `imap` server that declares a usable authentication wins, then
/// any `imap` server; `pop3` is ignored. `None` when the document is not usable
/// as an account.
pub fn parse(xml: &str) -> Option<Config> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut provider = None;
    let mut display_name = None;
    let mut servers: Vec<RawServer> = Vec::new();
    let mut current: Option<RawServer> = None;

    loop {
        match reader.read_event().ok()? {
            Event::Start(start) => {
                let name = start.name().into_inner();
                match name {
                    "emailProvider" => provider = attribute(&start, "id"),
                    "incomingServer" | "outgoingServer" => {
                        current = Some(RawServer {
                            kind: attribute(&start, "type").unwrap_or_default(),
                            ..RawServer::default()
                        });
                    }
                    "displayName" if current.is_none() => {
                        display_name = Some(reader.read_text(QName(name)).ok()?.trim().to_string());
                    }
                    "hostname" | "port" | "socketType" | "username" | "authentication" => {
                        let text = reader.read_text(QName(name)).ok()?.trim().to_string();
                        if let Some(server) = current.as_mut() {
                            server.set(name, text);
                        }
                    }
                    _ => {}
                }
            }
            Event::End(end) => {
                if matches!(end.name().into_inner(), "incomingServer" | "outgoingServer") {
                    if let Some(server) = current.take() {
                        servers.push(server);
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    let incoming = choose(&servers, "imap", IMAP_PORT, 143)?;
    let outgoing = choose(&servers, "smtp", SMTP_TLS_PORT, SMTP_STARTTLS_PORT)?;
    Some(Config {
        provider: display_name.clone().or(provider),
        display_name,
        incoming,
        outgoing,
    })
}

fn choose(servers: &[RawServer], kind: &str, ssl_port: u16, starttls_port: u16) -> Option<Server> {
    let candidates: Vec<&RawServer> = servers
        .iter()
        .filter(|server| server.kind.eq_ignore_ascii_case(kind))
        .collect();
    let preferred = candidates
        .iter()
        .find(|server| server.supported())
        .or_else(|| candidates.first())?;
    preferred.resolve(ssl_port, starttls_port)
}

fn attribute(start: &BytesStart<'_>, name: &str) -> Option<String> {
    start
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.into_inner() == name)
        .map(|attribute| attribute.value.trim().to_string())
}

fn auth_kind(name: &str) -> Option<AuthKind> {
    let name = name.trim();
    if name.eq_ignore_ascii_case("oauth2") {
        Some(AuthKind::OAuth2)
    } else if name.eq_ignore_ascii_case("password-cleartext") || name.eq_ignore_ascii_case("plain")
    {
        Some(AuthKind::Password)
    } else {
        None
    }
}

#[derive(Default)]
struct RawServer {
    kind: String,
    host: Option<String>,
    port: Option<u16>,
    socket: Option<String>,
    username: Option<String>,
    auth: Vec<String>,
}

impl RawServer {
    fn set(&mut self, name: &str, value: String) {
        match name {
            "hostname" => self.host = Some(value),
            "port" => self.port = value.parse().ok(),
            "socketType" => self.socket = Some(value),
            "username" => self.username = Some(value),
            "authentication" => self.auth.push(value),
            _ => {}
        }
    }

    fn supported(&self) -> bool {
        self.auth
            .iter()
            .any(|declared| auth_kind(declared).is_some())
    }

    fn resolve(&self, ssl_port: u16, starttls_port: u16) -> Option<Server> {
        let host = self.host.as_deref()?.trim().to_ascii_lowercase();
        if host.is_empty() {
            return None;
        }
        let encryption = match self
            .socket
            .as_deref()
            .map(|socket| socket.trim().to_ascii_uppercase())
            .as_deref()
        {
            Some("STARTTLS") => Encryption::StartTls,
            Some("PLAIN") => Encryption::Plain,
            _ => Encryption::Tls,
        };
        let port = self.port.unwrap_or(match encryption {
            Encryption::StartTls => starttls_port,
            _ => ssl_port,
        });
        if port == 0 {
            return None;
        }
        let mut auth: Vec<AuthKind> = self
            .auth
            .iter()
            .filter_map(|declared| auth_kind(declared))
            .collect();
        auth.sort();
        auth.dedup();
        let username = self
            .username
            .as_deref()
            .map(str::trim)
            .filter(|username| !username.is_empty())
            .unwrap_or(EMAIL_ADDRESS);
        Some(Server {
            host,
            port,
            encryption,
            username: username.to_string(),
            auth,
        })
    }
}
