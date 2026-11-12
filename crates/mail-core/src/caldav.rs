//! CalDAV client (RFC 4791), read-only.
//!
//! Discovery walks `current-user-principal`, then `calendar-home-set`, then
//! lists the collections whose `resourcetype` carries `calendar`; a server
//! handing out a calendar URL directly is used as that single collection.
//! Events come from a `calendar-query` REPORT listing the resources, each one
//! fetched and parsed by [`crate::ics::parse_events`]; a server refusing the
//! REPORT falls back to a `PROPFIND` listing of the collection.
//!
//! Credentials travel in a Basic header only: they never enter a URL, a log
//! line or an error message. Writing (`PUT`, `DELETE`) is out of scope.
//!
//! The server URL is caller supplied and fetched as is: like the ICS import,
//! the LAN stays reachable (self-hosted servers are the use case). Only `http`
//! and `https` are accepted and an URL carrying credentials is refused.

use std::time::Duration;

use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::name::QName;
use quick_xml::Reader;
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};

use crate::error::MailError;
use crate::ics::{parse_events, ExternalEvent, MAX_ICS_BYTES, MAX_ICS_EVENTS};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Largest WebDAV answer (PROPFIND, REPORT) read from the server.
const MAX_XML_BYTES: usize = 2 * 1024 * 1024;

/// Deepest XML nesting accepted; a deeper answer is not a WebDAV one.
const MAX_XML_DEPTH: usize = 32;

/// Deepest redirect chain followed for one request.
const MAX_REDIRECTS: usize = 3;

/// Calendars read out of one account.
pub const MAX_CALDAV_CALENDARS: usize = 50;

/// Resources listed inside one collection.
pub const MAX_CALDAV_RESOURCES: usize = 5_000;

const PRINCIPAL_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#
);

const HOME_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">"#,
    r#"<d:prop><c:calendar-home-set/></d:prop></d:propfind>"#
);

const COLLECTIONS_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" "#,
    r#"xmlns:a="http://apple.com/ns/ical/">"#,
    r#"<d:prop><d:resourcetype/><d:displayname/><c:calendar-description/>"#,
    r#"<a:calendar-color/></d:prop></d:propfind>"#
);

const MEMBERS_REPORT: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">"#,
    r#"<d:prop><d:getetag/></d:prop>"#,
    r#"<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/>"#,
    r#"</c:comp-filter></c:filter></c:calendar-query>"#
);

const MEMBERS_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:">"#,
    r#"<d:prop><d:resourcetype/><d:getcontenttype/></d:prop></d:propfind>"#
);

/// One calendar collection as the settings need it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalendarCollection {
    /// Absolute URL of the collection.
    pub href: String,
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
}

/// Read-only CalDAV client. Holds the password for the lifetime of the calls
/// and never prints it: no `Debug`, no secret in an error message.
pub struct CaldavClient {
    base: Url,
    username: String,
    password: String,
    http: reqwest::Client,
}

impl CaldavClient {
    pub fn new(base: &str, username: &str, password: &str) -> Result<Self, MailError> {
        let base = endpoint(base)?;
        let username = username.trim();
        if username.is_empty() {
            return Err(MailError::Config(
                "CalDAV : nom d'utilisateur vide".to_string(),
            ));
        }
        if password.is_empty() {
            return Err(MailError::Config("CalDAV : mot de passe vide".to_string()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Lavande/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| MailError::Caldav(format!("client HTTP CalDAV : {error}")))?;
        Ok(Self {
            base,
            username: username.to_string(),
            password: password.to_string(),
            http,
        })
    }

    /// Calendars of the account, or the single collection the URL points at.
    pub async fn discover(&self) -> Result<Vec<CalendarCollection>, MailError> {
        if let Some(home) = self.calendar_home().await? {
            let collections = self.collections(&home).await?;
            if !collections.is_empty() {
                return Ok(collections);
            }
        }
        match self.own_collection(&self.base).await? {
            Some(collection) => Ok(vec![collection]),
            None => Err(MailError::Caldav(format!(
                "aucun calendrier CalDAV à {}",
                address(&self.base)
            ))),
        }
    }

    /// Every `VEVENT` of `calendar_href`, or of every discovered calendar.
    ///
    /// A resource that answers badly or does not parse is skipped and traced at
    /// debug level: one broken event must not blank the agenda. Transport and
    /// authentication failures are raised.
    pub async fn events(
        &self,
        calendar_href: Option<&str>,
    ) -> Result<Vec<ExternalEvent>, MailError> {
        let collections = match calendar_href.map(str::trim).filter(|href| !href.is_empty()) {
            Some(href) => vec![CalendarCollection {
                href: resolve(&self.base, href)?.to_string(),
                ..CalendarCollection::default()
            }],
            None => self.discover().await?,
        };
        let mut events = Vec::new();
        for collection in collections.iter().take(MAX_CALDAV_CALENDARS) {
            if events.len() >= MAX_ICS_EVENTS {
                break;
            }
            let url = endpoint(&collection.href)?;
            let source = if collection.name.is_empty() {
                collection.href.clone()
            } else {
                collection.name.clone()
            };
            for resource in self.resources(&url).await? {
                if events.len() >= MAX_ICS_EVENTS {
                    break;
                }
                match self.resource(&resource).await {
                    Ok(content) => match parse_events(&content, Some(&source)) {
                        Ok(parsed) => events.extend(parsed),
                        Err(error) => tracing::debug!(
                            %error,
                            resource = %address(&resource),
                            "ressource CalDAV illisible, ignorée"
                        ),
                    },
                    Err(error @ (MailError::Auth(_) | MailError::Caldav(_))) => return Err(error),
                    Err(error) => tracing::debug!(
                        %error,
                        resource = %address(&resource),
                        "ressource CalDAV ignorée"
                    ),
                }
            }
        }
        events.truncate(MAX_ICS_EVENTS);
        Ok(events)
    }

    async fn calendar_home(&self) -> Result<Option<Url>, MailError> {
        let Some(principal) = self.principal().await? else {
            return Ok(None);
        };
        let answer = self.propfind(&principal, "0", HOME_QUERY).await?;
        ensure_authorized(&answer, &principal)?;
        if !answer.status.is_success() {
            return Ok(None);
        }
        let responses = parse_multistatus(&answer.body)?;
        Ok(responses
            .iter()
            .find_map(|response| response.nested_href("calendar-home-set"))
            .and_then(|href| resolve(&principal, href).ok()))
    }

    async fn principal(&self) -> Result<Option<Url>, MailError> {
        let answer = self.propfind(&self.base, "0", PRINCIPAL_QUERY).await?;
        ensure_authorized(&answer, &self.base)?;
        if !answer.status.is_success() {
            return Ok(None);
        }
        let responses = parse_multistatus(&answer.body)?;
        Ok(responses
            .iter()
            .find_map(|response| response.nested_href("current-user-principal"))
            .and_then(|href| resolve(&self.base, href).ok()))
    }

    async fn collections(&self, home: &Url) -> Result<Vec<CalendarCollection>, MailError> {
        let answer = self.propfind(home, "1", COLLECTIONS_QUERY).await?;
        ensure_authorized(&answer, home)?;
        if !answer.status.is_success() {
            return Ok(Vec::new());
        }
        let responses = parse_multistatus(&answer.body)?;
        Ok(responses
            .iter()
            .filter_map(|response| collection(home, response))
            .take(MAX_CALDAV_CALENDARS)
            .collect())
    }

    async fn own_collection(&self, url: &Url) -> Result<Option<CalendarCollection>, MailError> {
        let answer = self.propfind(url, "0", COLLECTIONS_QUERY).await?;
        ensure_authorized(&answer, url)?;
        if !answer.status.is_success() {
            return Ok(None);
        }
        let responses = parse_multistatus(&answer.body)?;
        Ok(responses
            .iter()
            .find_map(|response| collection(url, response)))
    }

    async fn resources(&self, collection: &Url) -> Result<Vec<Url>, MailError> {
        let answer = self
            .send(
                method("REPORT"),
                collection,
                Some("1"),
                Some(MEMBERS_REPORT),
                MAX_XML_BYTES,
            )
            .await?;
        ensure_authorized(&answer, collection)?;
        if answer.status.is_success() {
            let responses = parse_multistatus(&answer.body)?;
            return Ok(members(collection, &responses));
        }
        let answer = self.propfind(collection, "1", MEMBERS_QUERY).await?;
        ensure_authorized(&answer, collection)?;
        if !answer.status.is_success() {
            return Err(MailError::Caldav(format!(
                "{} répond {}",
                address(collection),
                answer.status.as_u16()
            )));
        }
        let responses = parse_multistatus(&answer.body)?;
        Ok(members(collection, &responses))
    }

    async fn resource(&self, url: &Url) -> Result<String, MailError> {
        let answer = self
            .send(method("GET"), url, None, None, MAX_ICS_BYTES)
            .await?;
        ensure_authorized(&answer, url)?;
        if !answer.status.is_success() {
            return Err(MailError::InvalidData(format!(
                "{} répond {}",
                address(url),
                answer.status.as_u16()
            )));
        }
        Ok(answer.body)
    }

    async fn propfind(&self, url: &Url, depth: &str, body: &str) -> Result<Answer, MailError> {
        self.send(
            method("PROPFIND"),
            url,
            Some(depth),
            Some(body),
            MAX_XML_BYTES,
        )
        .await
    }

    async fn send(
        &self,
        method: Method,
        url: &Url,
        depth: Option<&str>,
        body: Option<&str>,
        limit: usize,
    ) -> Result<Answer, MailError> {
        let mut target = url.clone();
        for _ in 0..=MAX_REDIRECTS {
            let mut request = self
                .http
                .request(method.clone(), target.clone())
                .basic_auth(&self.username, Some(&self.password));
            if let Some(depth) = depth {
                request = request.header("Depth", depth);
            }
            if let Some(body) = body {
                request = request
                    .header("Content-Type", "application/xml; charset=utf-8")
                    .body(body.to_string());
            }
            let response = request.send().await.map_err(|error| {
                MailError::Caldav(format!("{} injoignable : {error}", address(&target)))
            })?;
            let status = response.status();
            if matches!(
                status,
                StatusCode::MOVED_PERMANENTLY
                    | StatusCode::FOUND
                    | StatusCode::TEMPORARY_REDIRECT
                    | StatusCode::PERMANENT_REDIRECT
            ) {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        MailError::Caldav(format!(
                            "{} redirige sans adresse ({})",
                            address(&target),
                            status.as_u16()
                        ))
                    })?;
                target = resolve(&target, &location)?;
                continue;
            }
            let body = answer_body(response, limit).await?;
            return Ok(Answer { status, body });
        }
        Err(MailError::Caldav(format!(
            "trop de redirections pour {}",
            address(url)
        )))
    }
}

struct Answer {
    status: StatusCode,
    body: String,
}

/// Reads the whole body, refusing more than `limit` bytes.
async fn answer_body(mut response: reqwest::Response, limit: usize) -> Result<String, MailError> {
    if let Some(announced) = response.content_length() {
        if announced > limit as u64 {
            return Err(too_large(limit));
        }
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| MailError::Caldav(format!("réponse interrompue : {error}")))?
    {
        if buffer.len() + chunk.len() > limit {
            return Err(too_large(limit));
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer).map_err(|_| MailError::Caldav("réponse CalDAV non UTF-8".to_string()))
}

fn too_large(limit: usize) -> MailError {
    MailError::Caldav(format!(
        "réponse CalDAV trop volumineuse (maximum {limit} octets)"
    ))
}

fn ensure_authorized(answer: &Answer, url: &Url) -> Result<(), MailError> {
    match answer.status {
        StatusCode::UNAUTHORIZED => Err(MailError::Auth(format!(
            "identifiants CalDAV refusés par {} (401)",
            address(url)
        ))),
        StatusCode::FORBIDDEN => Err(MailError::Auth(format!(
            "accès CalDAV interdit par {} (403)",
            address(url)
        ))),
        _ => Ok(()),
    }
}

/// `PROPFIND`/`REPORT` are extensions of the standard methods.
fn method(name: &'static str) -> Method {
    Method::from_bytes(name.as_bytes()).expect("méthode WebDAV connue")
}

/// Parses `raw`, then refuses anything but an `http`/`https` URL without
/// credentials: the caller's URL is fetched as is, only the scheme is policed.
fn endpoint(raw: &str) -> Result<Url, MailError> {
    let url = Url::parse(raw.trim())
        .map_err(|error| MailError::Config(format!("URL CalDAV invalide : {error}")))?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(MailError::Config(format!(
                "schéma d'URL refusé : « {scheme} » (http ou https)"
            )))
        }
    }
    if url.host_str().is_none() {
        return Err(MailError::Config("URL CalDAV sans hôte".to_string()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(MailError::Config(
            "l'URL CalDAV ne doit pas porter d'identifiants".to_string(),
        ));
    }
    Ok(url)
}

fn resolve(base: &Url, reference: &str) -> Result<Url, MailError> {
    let joined = base
        .join(reference.trim())
        .map_err(|error| MailError::Caldav(format!("lien WebDAV illisible : {error}")))?;
    endpoint(joined.as_str())
}

/// Host and path of `url`: what an error message may show.
fn address(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}{}", url.path()),
        (Some(host), None) => format!("{host}{}", url.path()),
        (None, _) => url.path().to_string(),
    }
}

fn label(url: &Url) -> String {
    let segment = url
        .path_segments()
        .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()));
    match segment {
        Some(segment) => segment.to_string(),
        None => url.host_str().unwrap_or_default().to_string(),
    }
}

fn collection(base: &Url, response: &DavResponse) -> Option<CalendarCollection> {
    if !response.is_calendar() || response.href().trim().is_empty() {
        return None;
    }
    let url = resolve(base, response.href()).ok()?;
    let name = response
        .property("displayname")
        .map(str::to_string)
        .unwrap_or_else(|| label(&url));
    Some(CalendarCollection {
        href: url.to_string(),
        name,
        description: response
            .property("calendar-description")
            .map(str::to_string),
        color: response.property("calendar-color").map(str::to_string),
    })
}

fn members(collection: &Url, responses: &[DavResponse]) -> Vec<Url> {
    let mut resources = Vec::new();
    for response in responses {
        if resources.len() == MAX_CALDAV_RESOURCES {
            break;
        }
        let href = response.href().trim();
        if href.is_empty() || href.ends_with('/') {
            continue;
        }
        let Ok(url) = resolve(collection, href) else {
            continue;
        };
        if url == *collection {
            continue;
        }
        resources.push(url);
    }
    resources
}

/// One `<response>` of a `multistatus` answer. Element names are compared on
/// their local part, so CalDAV, DAV and Apple namespaces are read alike.
#[derive(Debug, Default)]
struct DavResponse {
    values: Vec<(String, String)>,
    resource_types: Vec<String>,
}

impl DavResponse {
    fn value(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(stored, _)| stored == key)
            .map(|(_, value)| value.as_str())
    }

    /// A property of `<prop>`, whatever the `propstat` nesting is.
    fn property(&self, name: &str) -> Option<&str> {
        let suffix = format!("/{name}");
        self.values
            .iter()
            .find(|(key, _)| key == name || key.ends_with(&suffix))
            .map(|(_, value)| value.as_str())
    }

    /// The `<href>` nested inside a property such as `calendar-home-set`.
    fn nested_href(&self, name: &str) -> Option<&str> {
        let suffix = format!("/{name}/href");
        self.values
            .iter()
            .find(|(key, _)| key.ends_with(&suffix))
            .map(|(_, value)| value.as_str())
    }

    fn href(&self) -> &str {
        self.value("href").unwrap_or_default()
    }

    fn is_calendar(&self) -> bool {
        self.resource_types.iter().any(|kind| kind == "calendar")
    }
}

fn parse_multistatus(body: &str) -> Result<Vec<DavResponse>, MailError> {
    let mut reader = Reader::from_str(body);
    let mut responses: Vec<DavResponse> = Vec::new();
    let mut current: Option<DavResponse> = None;
    let mut stack: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut root: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                let name = local_name(start.name());
                if root.is_none() {
                    root = Some(name.clone());
                }
                if name == "response" {
                    current = Some(DavResponse::default());
                }
                if let Some(response) = current.as_mut() {
                    if stack.last().map(String::as_str) == Some("resourcetype") {
                        response.resource_types.push(name.clone());
                    }
                }
                if stack.len() == MAX_XML_DEPTH {
                    return Err(deep());
                }
                text.clear();
                stack.push(name);
            }
            Ok(Event::Empty(start)) => {
                let name = local_name(start.name());
                if root.is_none() {
                    root = Some(name.clone());
                }
                if let Some(response) = current.as_mut() {
                    if stack.last().map(String::as_str) == Some("resourcetype") {
                        response.resource_types.push(name);
                    }
                }
            }
            Ok(Event::Text(chunk)) => {
                if current.is_some() {
                    text.push_str(&chunk);
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if current.is_some() {
                    text.push('&');
                    text.push_str(&reference);
                    text.push(';');
                }
            }
            Ok(Event::CData(chunk)) => {
                if current.is_some() {
                    text.push_str(&chunk);
                }
            }
            Ok(Event::End(end)) => {
                let name = local_name(end.name());
                stack.pop();
                let value = unescape(&text)
                    .map(|value| value.trim().to_string())
                    .unwrap_or_else(|_| text.trim().to_string());
                text.clear();
                if name == "response" {
                    if let Some(response) = current.take() {
                        responses.push(response);
                    }
                    continue;
                }
                let Some(index) = stack.iter().rposition(|name| name == "response") else {
                    continue;
                };
                let Some(response) = current.as_mut() else {
                    continue;
                };
                if !value.is_empty() {
                    let mut path: Vec<&str> =
                        stack[index + 1..].iter().map(String::as_str).collect();
                    path.push(&name);
                    response.values.push((path.join("/"), value));
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(MailError::Caldav(format!(
                    "réponse WebDAV illisible : {error}"
                )))
            }
        }
    }
    if root.is_none() && !body.trim().is_empty() {
        return Err(MailError::Caldav(
            "réponse WebDAV illisible : aucun élément XML".to_string(),
        ));
    }
    if !stack.is_empty() {
        return Err(MailError::Caldav(
            "réponse WebDAV illisible : document tronqué".to_string(),
        ));
    }
    Ok(responses)
}

fn deep() -> MailError {
    MailError::Caldav(format!(
        "réponse WebDAV trop profonde (maximum {MAX_XML_DEPTH} niveaux)"
    ))
}

fn local_name(name: QName<'_>) -> String {
    name.local_name().into_inner().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRINCIPAL_ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal>
          <D:href>/principals/users/roman/</D:href>
        </D:current-user-principal>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    const HOME_ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/principals/users/roman/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set>
          <d:href>https://caldav.exemple.tld/dav/roman/</d:href>
        </c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;

    const COLLECTIONS_ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/dav/roman/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/travail/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Travail</D:displayname>
        <C:calendar-description>Réunions &amp; revues</C:calendar-description>
        <A:calendar-color>#FF8C00FF</A:calendar-color>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/perso/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/contacts/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/></D:resourcetype>
        <D:displayname>Contacts</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    const REPORT_ANSWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/roman/travail/evenement-1.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/travail/evenement%202.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"2"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/travail/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    fn base() -> Url {
        Url::parse("https://caldav.exemple.tld/dav/").expect("URL")
    }

    #[test]
    fn the_current_user_principal_is_read() {
        let responses = parse_multistatus(PRINCIPAL_ANSWER).expect("multistatus");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].href(), "/dav/");
        let href = responses[0]
            .nested_href("current-user-principal")
            .expect("principal");
        assert_eq!(href, "/principals/users/roman/");
        assert_eq!(
            resolve(&base(), href).expect("URL").as_str(),
            "https://caldav.exemple.tld/principals/users/roman/"
        );
    }

    #[test]
    fn the_calendar_home_set_is_read_absolute_or_relative() {
        let responses = parse_multistatus(HOME_ANSWER).expect("multistatus");
        let href = responses[0].nested_href("calendar-home-set").expect("home");
        assert_eq!(
            resolve(&base(), href).expect("URL").as_str(),
            "https://caldav.exemple.tld/dav/roman/"
        );
    }

    #[test]
    fn only_calendar_collections_are_kept() {
        let responses = parse_multistatus(COLLECTIONS_ANSWER).expect("multistatus");
        let collections: Vec<CalendarCollection> = responses
            .iter()
            .filter_map(|response| collection(&base(), response))
            .collect();
        assert_eq!(collections.len(), 2);
        assert_eq!(
            collections[0].href,
            "https://caldav.exemple.tld/dav/roman/travail/"
        );
        assert_eq!(collections[0].name, "Travail");
        assert_eq!(
            collections[0].description.as_deref(),
            Some("Réunions & revues")
        );
        assert_eq!(collections[0].color.as_deref(), Some("#FF8C00FF"));
        assert_eq!(collections[1].name, "perso");
        assert_eq!(collections[1].description, None);
        assert_eq!(collections[1].color, None);
    }

    #[test]
    fn members_of_a_report_skip_the_collection_itself() {
        let responses = parse_multistatus(REPORT_ANSWER).expect("multistatus");
        let collection_url =
            Url::parse("https://caldav.exemple.tld/dav/roman/travail/").expect("URL");
        let resources = members(&collection_url, &responses);
        assert_eq!(
            resources.iter().map(|url| url.as_str()).collect::<Vec<_>>(),
            [
                "https://caldav.exemple.tld/dav/roman/travail/evenement-1.ics",
                "https://caldav.exemple.tld/dav/roman/travail/evenement%202.ics",
            ]
        );
    }

    #[test]
    fn a_multistatus_without_namespace_prefix_is_read() {
        let answer = r#"<multistatus xmlns="DAV:"><response><href>/dav/perso/</href>
            <propstat><PROP><resourcetype><collection/><calendar/></resourcetype>
            <displayname>Perso</displayname></PROP></propstat></response></multistatus>"#;
        let responses = parse_multistatus(answer).expect("multistatus");
        assert_eq!(responses.len(), 1);
        assert!(responses[0].is_calendar());
        assert_eq!(responses[0].property("displayname"), Some("Perso"));
        assert_eq!(
            resolve(&base(), responses[0].href()).expect("URL").as_str(),
            "https://caldav.exemple.tld/dav/perso/"
        );
    }

    #[test]
    fn an_invalid_answer_is_refused_without_panicking() {
        assert!(matches!(
            parse_multistatus("ceci n'est pas du XML"),
            Err(MailError::Caldav(_))
        ));
        assert!(matches!(
            parse_multistatus("<D:multistatus xmlns:D=\"DAV:\"><D:response>"),
            Err(MailError::Caldav(_))
        ));
        assert!(matches!(
            parse_multistatus("<a><b></a></b>"),
            Err(MailError::Caldav(_))
        ));
        assert!(matches!(parse_multistatus(""), Ok(ref responses) if responses.is_empty()));
        assert!(matches!(
            parse_multistatus("<D:multistatus xmlns:D=\"DAV:\"/>"),
            Ok(ref responses) if responses.is_empty()
        ));
    }

    #[test]
    fn a_response_without_href_is_ignored() {
        let answer = r#"<D:multistatus xmlns:D="DAV:"><D:response><D:propstat>
            <D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop>
            </D:propstat></D:response></D:multistatus>"#;
        let responses = parse_multistatus(answer).expect("multistatus");
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].href(), "");
        assert!(collection(&base(), &responses[0]).is_none());
    }

    #[test]
    fn a_deeply_nested_answer_is_refused() {
        let deep = format!(
            "{}{}",
            "<a>".repeat(MAX_XML_DEPTH + 1),
            "</a>".repeat(MAX_XML_DEPTH + 1)
        );
        assert!(matches!(
            parse_multistatus(&deep),
            Err(MailError::Caldav(_))
        ));
    }

    #[test]
    fn request_bodies_are_well_formed_xml() {
        for body in [
            PRINCIPAL_QUERY,
            HOME_QUERY,
            COLLECTIONS_QUERY,
            MEMBERS_REPORT,
            MEMBERS_QUERY,
        ] {
            let mut reader = Reader::from_str(body);
            loop {
                match reader.read_event() {
                    Ok(Event::Eof) => break,
                    Ok(_) => {}
                    Err(error) => panic!("corps de requête illisible : {error}"),
                }
            }
        }
    }

    #[test]
    fn only_http_urls_without_credentials_are_accepted() {
        assert!(endpoint("https://caldav.exemple.tld/dav/").is_ok());
        assert!(endpoint("http://192.168.1.10:8080/remote.php/dav/").is_ok());
        assert!(matches!(
            endpoint("ftp://exemple.tld/dav/"),
            Err(MailError::Config(_))
        ));
        assert!(matches!(
            endpoint("caldav.exemple.tld/dav/"),
            Err(MailError::Config(_))
        ));
        let with_credentials = endpoint("https://roman:secret-app-password@caldav.exemple.tld/");
        assert!(matches!(with_credentials, Err(MailError::Config(_))));
        let message = with_credentials.err().map(|error| error.to_string());
        assert!(
            !message.unwrap_or_default().contains("secret-app-password"),
            "le mot de passe ne doit pas fuir dans l'erreur"
        );
    }

    #[test]
    fn a_link_out_of_http_is_refused() {
        assert!(matches!(
            resolve(&base(), "file:///etc/passwd"),
            Err(MailError::Config(_))
        ));
        assert_eq!(
            resolve(&base(), "roman/travail/").expect("URL").as_str(),
            "https://caldav.exemple.tld/dav/roman/travail/"
        );
    }

    #[test]
    fn empty_credentials_are_refused() {
        assert!(matches!(
            CaldavClient::new("https://caldav.exemple.tld/dav/", "  ", "secret"),
            Err(MailError::Config(_))
        ));
        assert!(matches!(
            CaldavClient::new("https://caldav.exemple.tld/dav/", "roman", ""),
            Err(MailError::Config(_))
        ));
        assert!(CaldavClient::new("https://caldav.exemple.tld/dav/", "roman", "secret").is_ok());
    }

    #[test]
    fn an_answer_address_never_carries_credentials() {
        let url = Url::parse("https://caldav.exemple.tld:8443/dav/roman/").expect("URL");
        assert_eq!(address(&url), "caldav.exemple.tld:8443/dav/roman/");
        assert_eq!(label(&url), "roman");
        assert_eq!(
            label(&Url::parse("https://caldav.exemple.tld/").expect("URL")),
            "caldav.exemple.tld"
        );
    }
}
