//! CardDAV address book of a mail account (RFC 6352).
//!
//! The client discovers the address books of the account the way a calendar
//! client finds its collections — `current-user-principal`, then
//! `addressbook-home-set`, then the collections announcing an `addressbook`
//! resource type — and falls back to `<base>/<email>/Contacts`, the collection
//! Zimbra exposes, when the discovery answers nothing.
//!
//! Cards are read with [`parse_card`], a deliberately small vCard reader: the
//! display name (`FN`) and the address (`EMAIL`) are what the contact list of
//! the agenda needs; a card too broken to yield an address is skipped and
//! counted, never fatal.
//!
//! Credentials travel in a Basic header only: they never enter a URL, a log line
//! or an error message, and the client has no `Debug`.

use std::time::Duration;

use quick_xml::escape::{partial_escape, unescape};
use quick_xml::events::Event;
use quick_xml::name::QName;
use quick_xml::Reader;
use reqwest::{Method, StatusCode, Url};

use crate::error::MailError;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 3;

/// Largest DAV answer read, in bytes: an address book of a company directory is
/// far bigger than a calendar.
const MAX_DAV_BYTES: usize = 16 * 1024 * 1024;

/// Deepest XML tree accepted, so a hostile answer cannot exhaust the stack.
const MAX_XML_DEPTH: usize = 32;

/// Collections read at most in one sync.
const MAX_ADDRESSBOOKS: usize = 10;

/// Cards kept at most in one sync.
pub const MAX_CARDS: usize = 5000;

/// Member URLs asked at most in one `addressbook-multiget` report.
const MAX_MULTIGET_HREFS: usize = 200;

/// Address books of the principal, relative to the URL the client was given.
const PRINCIPAL_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#
);

const HOME_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">"#,
    r#"<d:prop><card:addressbook-home-set/></d:prop></d:propfind>"#
);

const COLLECTIONS_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>"#
);

/// Members of a collection, the collection itself answering first.
const MEMBERS_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>"#
);

/// Opening of an `addressbook-multiget` report: the `<d:href>` of the members
/// asked follow, then [`MULTIGET_END`].
const MULTIGET_QUERY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">"#,
    r#"<d:prop><d:getetag/><card:address-data/></d:prop>"#
);

const MULTIGET_END: &str = "</card:addressbook-multiget>";

/// One address the address book lists.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Contact {
    /// `FN` of the card; absent when the producer wrote none.
    pub name: Option<String>,
    pub email: String,
}

/// What one sync read out of the address books: the entries, and the cards too
/// broken to yield an address.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Directory {
    pub contacts: Vec<Contact>,
    pub skipped: usize,
}

/// CardDAV client. Holds the password for the lifetime of the calls and never
/// prints it: no `Debug`, no secret in an error message.
pub struct CarddavClient {
    base: Url,
    username: String,
    password: String,
    http: reqwest::Client,
}

impl CarddavClient {
    pub fn new(base: &str, username: &str, password: &str) -> Result<Self, MailError> {
        let base = endpoint(base)?;
        let username = username.trim();
        if username.is_empty() {
            return Err(MailError::Config(
                "CardDAV : nom d'utilisateur vide".to_string(),
            ));
        }
        if password.is_empty() {
            return Err(MailError::Config("CardDAV : mot de passe vide".to_string()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Lavande/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| MailError::Carddav(format!("client HTTP CardDAV : {error}")))?;
        Ok(Self {
            base,
            username: username.to_string(),
            password: password.to_string(),
            http,
        })
    }

    /// Every contact of the account, discovered or taken from the Zimbra
    /// collection `<base>/<email>/Contacts`.
    pub async fn contacts(&self, email: &str) -> Result<Directory, MailError> {
        let books = self.addressbooks(email).await?;
        let mut book = Directory::default();
        for collection in books.iter().take(MAX_ADDRESSBOOKS) {
            let cards = self.cards(collection).await?;
            for card in cards {
                if book.contacts.len() == MAX_CARDS {
                    return Ok(book);
                }
                match parse_card(&card) {
                    Some(contact) => {
                        if !book
                            .contacts
                            .iter()
                            .any(|known| known.email.eq_ignore_ascii_case(&contact.email))
                        {
                            book.contacts.push(contact);
                        }
                    }
                    None => book.skipped += 1,
                }
            }
        }
        Ok(book)
    }

    /// Collections holding cards: the discovery, else the Zimbra collection.
    pub async fn addressbooks(&self, email: &str) -> Result<Vec<Url>, MailError> {
        match self.discover().await {
            Ok(books) if !books.is_empty() => return Ok(books),
            Ok(_) => tracing::debug!("aucun carnet découvert, collection Zimbra essayée"),
            // Un refus d'identifiants ou d'URL ne se replie pas : il se dit.
            Err(error @ (MailError::Auth(_) | MailError::Config(_))) => return Err(error),
            Err(error) => tracing::debug!(%error, "découverte CardDAV impossible, repli Zimbra"),
        }
        Ok(vec![zimbra_addressbook(&self.base, email)?])
    }

    async fn discover(&self) -> Result<Vec<Url>, MailError> {
        let answer = self.propfind(&self.base, "0", PRINCIPAL_QUERY).await?;
        ensure_authorized(&answer, &self.base)?;
        let principal = match answer.status {
            status if status.is_success() => parse_multistatus(&answer.body)?
                .iter()
                .find_map(|response| response.nested_href("current-user-principal"))
                .map(|href| resolve(&self.base, href))
                .transpose()?,
            _ => None,
        };
        let Some(principal) = principal else {
            return Ok(Vec::new());
        };
        let answer = self.propfind(&principal, "0", HOME_QUERY).await?;
        ensure_authorized(&answer, &principal)?;
        if !answer.status.is_success() {
            return Ok(Vec::new());
        }
        let home = parse_multistatus(&answer.body)?
            .iter()
            .find_map(|response| response.nested_href("addressbook-home-set"))
            .map(|href| resolve(&principal, href))
            .transpose()?;
        let Some(home) = home else {
            return Ok(Vec::new());
        };
        let answer = self.propfind(&home, "1", COLLECTIONS_QUERY).await?;
        ensure_authorized(&answer, &home)?;
        if !answer.status.is_success() {
            return Ok(Vec::new());
        }
        let mut books = Vec::new();
        for response in parse_multistatus(&answer.body)? {
            if !response.is_addressbook() {
                continue;
            }
            let href = response.href().trim();
            if href.is_empty() {
                continue;
            }
            let Ok(collection) = resolve(&home, href) else {
                continue;
            };
            // La collection elle-même n'est pas un carnet.
            if collection == home {
                continue;
            }
            books.push(collection);
        }
        Ok(books)
    }

    /// vCards of one collection, in the order the server lists them.
    ///
    /// The members are listed with a `PROPFIND` of the collection — Zimbra
    /// answers 400 to an `addressbook-query` report — then read in batches with
    /// an `addressbook-multiget` report.
    async fn cards(&self, collection: &Url) -> Result<Vec<String>, MailError> {
        let answer = self.propfind(collection, "1", MEMBERS_QUERY).await?;
        ensure_authorized(&answer, collection)?;
        if !answer.status.is_success() {
            return Err(status_error(collection, answer.status));
        }
        let mut members: Vec<String> = Vec::new();
        for response in parse_multistatus(&answer.body)? {
            let href = response.href().trim();
            if href.is_empty() {
                continue;
            }
            // La collection elle-même répond, en tête de liste.
            if resolve(collection, href)? == *collection {
                continue;
            }
            members.push(href.to_string());
        }
        let mut cards: Vec<String> = Vec::new();
        for batch in members.chunks(MAX_MULTIGET_HREFS) {
            let body = multiget_body(batch);
            let answer = self
                .send(("REPORT", &body), collection.clone(), Some("0"))
                .await?;
            ensure_authorized(&answer, collection)?;
            if !answer.status.is_success() {
                return Err(status_error(collection, answer.status));
            }
            for response in parse_multistatus(&answer.body)? {
                if let Some(card) = response.property("address-data") {
                    cards.push(card.to_string());
                }
            }
        }
        Ok(cards)
    }

    async fn propfind(
        &self,
        url: &Url,
        depth: &'static str,
        body: &str,
    ) -> Result<Answer, MailError> {
        self.send(("PROPFIND", body), url.clone(), Some(depth))
            .await
    }

    async fn send(
        &self,
        (method, body): (&'static str, &str),
        url: Url,
        depth: Option<&'static str>,
    ) -> Result<Answer, MailError> {
        let method = Method::from_bytes(method.as_bytes()).expect("méthode WebDAV connue");
        let mut target = url.clone();
        for _ in 0..=MAX_REDIRECTS {
            let mut request = self
                .http
                .request(method.clone(), target.clone())
                .basic_auth(&self.username, Some(&self.password))
                .header("Content-Type", "application/xml; charset=utf-8")
                .body(body.to_string());
            if let Some(depth) = depth {
                request = request.header("Depth", depth);
            }
            let response = request.send().await.map_err(|error| {
                MailError::Carddav(format!("{} injoignable : {error}", address(&target)))
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
                        MailError::Carddav(format!(
                            "{} redirige sans adresse ({})",
                            address(&target),
                            status.as_u16()
                        ))
                    })?;
                target = resolve(&target, &location)?;
                continue;
            }
            let body = answer_body(response, MAX_DAV_BYTES).await?;
            return Ok(Answer { status, body });
        }
        Err(MailError::Carddav(format!(
            "trop de redirections pour {}",
            address(&url)
        )))
    }
}

/// `addressbook-multiget` body asking the vCards of `hrefs`, escaped for XML.
fn multiget_body(hrefs: &[String]) -> String {
    let mut body = String::from(MULTIGET_QUERY);
    for href in hrefs {
        body.push_str("<d:href>");
        body.push_str(&partial_escape(href.as_str()));
        body.push_str("</d:href>");
    }
    body.push_str(MULTIGET_END);
    body
}

/// `<base>/<email>/Contacts`: la collection que Zimbra expose pour le compte.
fn zimbra_addressbook(base: &Url, email: &str) -> Result<Url, MailError> {
    let email = email.trim();
    if email.is_empty() {
        return Err(MailError::Carddav(
            "le compte n'a pas d'adresse pour dériver son carnet".to_string(),
        ));
    }
    let mut root = base.clone();
    if !root.path().ends_with('/') {
        let path = format!("{}/", root.path());
        root.set_path(&path);
    }
    root.join(&format!("{email}/Contacts/"))
        .map_err(|error| MailError::Carddav(format!("URL de carnet invalide : {error}")))
}

/// One vCard, read for what the contact list needs: the display name and the
/// address. `None` when the card yields no usable address.
///
/// Version 3.0 and 4.0 are read alike, a folded line (leading blank) and a
/// quoted-printable soft line break (`=` ending the line) are joined back, and
/// the first `EMAIL` announcing `TYPE=INTERNET` wins over the plain first one.
pub fn parse_card(card: &str) -> Option<Contact> {
    let mut name: Option<String> = None;
    let mut emails: Vec<String> = Vec::new();
    let mut internet: Option<String> = None;
    for line in logical_lines(card) {
        let Some((head, value)) = line.split_once(':') else {
            continue;
        };
        let mut parts = head.split(';');
        let key = parts.next().unwrap_or_default();
        let params: Vec<&str> = parts.collect();
        // `item1.EMAIL` : le préfixe de groupe ne change pas la propriété.
        let key = key
            .rsplit('.')
            .next()
            .unwrap_or(key)
            .trim()
            .to_ascii_uppercase();
        let value = text_value(value, &params);
        match key.as_str() {
            "FN" => {
                let value = unescape_text(&value);
                if !value.is_empty() && name.is_none() {
                    name = Some(value);
                }
            }
            "EMAIL" => {
                let value = unescape_text(&value).trim().to_string();
                if !value.contains('@') {
                    continue;
                }
                let plain = params
                    .iter()
                    .any(|param| param.to_ascii_uppercase().contains("INTERNET"));
                if plain && internet.is_none() {
                    internet = Some(value.clone());
                }
                emails.push(value);
            }
            _ => {}
        }
    }
    let email = internet.or_else(|| emails.first().cloned())?;
    Some(Contact { name, email })
}

/// Value of a property: quoted-printable decoded when the card says so.
fn text_value(value: &str, params: &[&str]) -> String {
    let quoted_printable = params.iter().any(|param| {
        let param = param.to_ascii_uppercase().replace([' ', '"'], "");
        param == "ENCODING=QUOTED-PRINTABLE" || param == "QUOTED-PRINTABLE"
    });
    match quoted_printable {
        true => decode_quoted_printable(value),
        false => value.to_string(),
    }
}

/// `=XX` bytes of a quoted-printable value; `=_` soft breaks are already gone.
fn decode_quoted_printable(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'=' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// vCard text escapes: `\,` `\;` `\n` `\\`.
fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            out.push(match character {
                'n' | 'N' => '\n',
                other => other,
            });
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        out.push(character);
    }
    out.trim().to_string()
}

/// Logical lines of a card: a folded line starts with a blank, a
/// quoted-printable value continues on a line after a trailing `=`.
fn logical_lines(card: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in card.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(last) = lines.last_mut() {
            if let Some(rest) = raw.strip_prefix([' ', '\t']) {
                last.push_str(rest);
                continue;
            }
            if last.ends_with('=') && is_quoted_printable(last) {
                last.pop();
                last.push_str(raw);
                continue;
            }
        }
        lines.push(raw.to_string());
    }
    lines
}

fn is_quoted_printable(line: &str) -> bool {
    line.to_ascii_uppercase().contains("QUOTED-PRINTABLE")
}

/// Raw body of a DAV answer, refused past `limit` bytes.
async fn answer_body(response: reqwest::Response, limit: usize) -> Result<String, MailError> {
    let mut buffer = Vec::new();
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|error| MailError::Carddav(format!("réponse interrompue : {error}")))?
    {
        if buffer.len() + chunk.len() > limit {
            return Err(MailError::Carddav(format!(
                "réponse CardDAV trop volumineuse (maximum {limit} octets)"
            )));
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer)
        .map_err(|_| MailError::Carddav("réponse CardDAV non UTF-8".to_string()))
}

/// The error of a DAV answer the client cannot use.
fn status_error(url: &Url, status: StatusCode) -> MailError {
    MailError::Carddav(format!("{} répond {}", address(url), status.as_u16()))
}

fn ensure_authorized(answer: &Answer, url: &Url) -> Result<(), MailError> {
    match answer.status {
        StatusCode::UNAUTHORIZED => Err(MailError::Auth(format!(
            "identifiants CardDAV refusés par {} (401)",
            address(url)
        ))),
        StatusCode::FORBIDDEN => Err(MailError::Auth(format!(
            "accès CardDAV interdit par {} (403)",
            address(url)
        ))),
        _ => Ok(()),
    }
}

/// Parses `raw`, then refuses anything but an `http`/`https` URL without
/// credentials: the caller's URL is fetched as is, only the scheme is policed.
fn endpoint(raw: &str) -> Result<Url, MailError> {
    let url = Url::parse(raw.trim())
        .map_err(|error| MailError::Config(format!("URL CardDAV invalide : {error}")))?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(MailError::Config(format!(
                "schéma d'URL refusé : « {scheme} » (http ou https)"
            )))
        }
    }
    if url.host_str().is_none() {
        return Err(MailError::Config("URL CardDAV sans hôte".to_string()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(MailError::Config(
            "l'URL CardDAV ne doit pas porter d'identifiants".to_string(),
        ));
    }
    Ok(url)
}

fn resolve(base: &Url, reference: &str) -> Result<Url, MailError> {
    let joined = base
        .join(reference.trim())
        .map_err(|error| MailError::Carddav(format!("lien WebDAV illisible : {error}")))?;
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

struct Answer {
    status: StatusCode,
    body: String,
}

/// One `<response>` of a `multistatus` answer. Element names are compared on
/// their local part, so DAV and CardDAV namespaces are read alike.
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

    /// The `<href>` nested inside a property such as `addressbook-home-set`.
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

    fn is_addressbook(&self) -> bool {
        self.resource_types.iter().any(|kind| kind == "addressbook")
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
                return Err(MailError::Carddav(format!(
                    "réponse WebDAV illisible : {error}"
                )))
            }
        }
    }
    if root.is_none() && !body.trim().is_empty() {
        return Err(MailError::Carddav(
            "réponse WebDAV illisible : aucun élément XML".to_string(),
        ));
    }
    if !stack.is_empty() {
        return Err(MailError::Carddav(
            "réponse WebDAV illisible : document tronqué".to_string(),
        ));
    }
    Ok(responses)
}

fn deep() -> MailError {
    MailError::Carddav(format!(
        "réponse WebDAV trop profonde (maximum {MAX_XML_DEPTH} niveaux)"
    ))
}

fn local_name(name: QName<'_>) -> String {
    name.local_name().into_inner().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jean Dupont\r\n\
         EMAIL;TYPE=INTERNET:jean.dupont@exemple.tld\r\nTEL:+33123456789\r\n\
         END:VCARD\r\n";

    #[test]
    fn a_card_yields_its_name_and_address() {
        let contact = parse_card(CARD).expect("carte lisible");
        assert_eq!(contact.name.as_deref(), Some("Jean Dupont"));
        assert_eq!(contact.email, "jean.dupont@exemple.tld");
    }

    #[test]
    fn a_card_without_a_name_keeps_its_address() {
        let contact =
            parse_card("BEGIN:VCARD\r\nVERSION:4.0\r\nEMAIL:contact@exemple.tld\r\nEND:VCARD\r\n")
                .expect("carte lisible");
        assert_eq!(contact.name, None);
        assert_eq!(contact.email, "contact@exemple.tld");
    }

    #[test]
    fn the_internet_address_wins_over_the_first_one() {
        let contact = parse_card(
            "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Studio Lilas\r\n\
             EMAIL;TYPE=WORK,VOICE:accueil@studio-lilas.fr\r\n\
             EMAIL;TYPE=INTERNET:camille@studio-lilas.fr\r\nEND:VCARD\r\n",
        )
        .expect("carte lisible");
        assert_eq!(contact.email, "camille@studio-lilas.fr");
    }

    #[test]
    fn a_folded_line_is_joined_back() {
        let contact = parse_card(
            "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Un nom beaucoup trop long pour la \r\n ligne\r\n\
             EMAIL:long@exemple.tld\r\nEND:VCARD\r\n",
        )
        .expect("carte lisible");
        assert_eq!(
            contact.name.as_deref(),
            Some("Un nom beaucoup trop long pour la ligne")
        );
    }

    #[test]
    fn a_quoted_printable_address_is_decoded() {
        let contact = parse_card(
            "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jean Dupont\r\n\
             EMAIL;ENCODING=QUOTED-PRINTABLE;TYPE=INTERNET:jean=2Edupont@exem=\r\nple.tld\r\n\
             END:VCARD\r\n",
        )
        .expect("carte lisible");
        assert_eq!(contact.email, "jean.dupont@exemple.tld");
    }

    #[test]
    fn a_quoted_printable_name_is_decoded() {
        let contact = parse_card(
            "BEGIN:VCARD\r\nVERSION:3.0\r\n\
             FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:R=C3=A9mi Delaunay\r\n\
             EMAIL:remi@exemple.tld\r\nEND:VCARD\r\n",
        )
        .expect("carte lisible");
        assert_eq!(contact.name.as_deref(), Some("Rémi Delaunay"));
    }

    #[test]
    fn a_grouped_property_is_read_like_a_plain_one() {
        let contact = parse_card(
            "BEGIN:VCARD\r\nVERSION:4.0\r\nitem1.FN:Camille Roy\r\n\
             item1.EMAIL;TYPE=work:camille@studio-lilas.fr\r\nEND:VCARD\r\n",
        )
        .expect("carte lisible");
        assert_eq!(contact.name.as_deref(), Some("Camille Roy"));
        assert_eq!(contact.email, "camille@studio-lilas.fr");
    }

    #[test]
    fn a_card_without_an_address_is_skipped() {
        assert_eq!(
            parse_card("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Sans adresse\r\nEND:VCARD\r\n"),
            None
        );
        assert_eq!(parse_card("ceci n'est pas une carte"), None);
        assert_eq!(parse_card(""), None);
        assert_eq!(
            parse_card("BEGIN:VCARD\r\nEMAIL:pas-une-adresse\r\nEND:VCARD\r\n"),
            None
        );
    }

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
    <D:href>/dav/roman/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
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
  <D:response>
    <D:href>/dav/roman/Calendar/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    const CARDS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/roman/Contacts/jean.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag><card:address-data>BEGIN:VCARD
VERSION:3.0
FN:Jean Dupont
EMAIL;TYPE=INTERNET:jean.dupont@exemple.tld
END:VCARD
</card:address-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/Contacts/camille.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"2"</D:getetag><card:address-data><![CDATA[BEGIN:VCARD
VERSION:4.0
FN:Camille Roy
EMAIL:camille@studio-lilas.fr
END:VCARD
]]></card:address-data></D:prop>
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

    /// Members of a collection: the collection itself, then the card URLs.
    const MEMBERS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>./</D:href>
    <D:propstat>
      <D:prop><D:getetag>"0"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>jean.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>camille.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"2"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>casse.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"3"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    /// The same collection without a member: the collection answers alone.
    const NO_MEMBERS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>./</D:href>
    <D:propstat>
      <D:prop><D:getetag>"0"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    /// Hrefs shaped like the ones Zimbra lists: absolute, and one carrying `&`.
    const MEMBERS_ESCAPED: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/roman/Contacts/</D:href>
    <D:propstat>
      <D:prop><D:getetag>"0"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/Contacts/3bc1eb6f-a517-4434-a862-0500b5863bb6:317.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"1"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/roman/Contacts/jean&amp;fils.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"2"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    /// Faux serveur DAV : `answers` associe « METHODE chemin » à sa réponse,
    /// tout le reste répond 404.
    async fn serve(answers: Vec<(&'static str, &'static str)>) -> Url {
        let answers: Vec<(&'static str, &'static str, u16)> = answers
            .into_iter()
            .map(|(route, body)| (route, body, 207))
            .collect();
        serve_status(answers).await
    }

    /// Racine DAV d'un faux serveur : la route vise `<hôte>/dav/`.
    fn dav_base(root: &Url) -> String {
        root.join("dav/").expect("URL").to_string()
    }

    /// Same server, with the status each answer carries.
    async fn serve_status(answers: Vec<(&'static str, &'static str, u16)>) -> Url {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("écoute");
        let address = listener.local_addr().expect("adresse locale");
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let answers = answers.clone();
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
                    let response = match answers.iter().find(|(route, _, _)| *route == key) {
                        Some((_, body, status)) => format!(
                            "HTTP/1.1 {status} Status\r\n\
                             Content-Type: application/xml; charset=utf-8\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        ),
                        None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\
                                 Connection: close\r\n\r\n"
                            .to_string(),
                    };
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Url::parse(&format!("http://{address}/")).expect("URL")
    }

    #[tokio::test]
    async fn the_addressbook_is_discovered_and_read() {
        let root = serve(vec![
            ("PROPFIND /dav/", PRINCIPAL),
            ("PROPFIND /principals/users/roman/", HOME),
            ("PROPFIND /dav/roman/", COLLECTIONS),
            ("PROPFIND /dav/roman/Contacts/", MEMBERS),
            ("REPORT /dav/roman/Contacts/", CARDS),
        ])
        .await;
        let client = CarddavClient::new(&dav_base(&root), "roman", "secret").expect("client");
        let book = client.contacts("roman@lavande.mail").await.expect("carnet");

        assert_eq!(book.contacts.len(), 2);
        assert_eq!(
            book.contacts[0],
            Contact {
                name: Some("Jean Dupont".to_string()),
                email: "jean.dupont@exemple.tld".to_string(),
            }
        );
        assert_eq!(
            book.contacts[1],
            Contact {
                name: Some("Camille Roy".to_string()),
                email: "camille@studio-lilas.fr".to_string(),
            }
        );
        // La carte sans adresse est comptée, pas fatale.
        assert_eq!(book.skipped, 1);
    }

    #[tokio::test]
    async fn a_silent_discovery_falls_back_to_the_zimbra_collection() {
        let root = serve(vec![
            ("PROPFIND /dav/roman@lavande.mail/Contacts/", MEMBERS),
            ("REPORT /dav/roman@lavande.mail/Contacts/", CARDS),
        ])
        .await;
        let client = CarddavClient::new(&dav_base(&root), "roman", "secret").expect("client");
        let books = client
            .addressbooks("roman@lavande.mail")
            .await
            .expect("carnet");
        assert_eq!(books.len(), 1);
        assert!(
            books[0]
                .as_str()
                .ends_with("/dav/roman@lavande.mail/Contacts/"),
            "{}",
            books[0]
        );

        let book = client.contacts("roman@lavande.mail").await.expect("carnet");
        assert_eq!(book.contacts.len(), 2);
        assert_eq!(book.skipped, 1);
    }

    #[tokio::test]
    async fn an_empty_collection_reads_no_card_without_a_report() {
        // Aucune route REPORT : un report envoyé recevrait 404 et échouerait.
        let root = serve(vec![
            ("PROPFIND /dav/", PRINCIPAL),
            ("PROPFIND /principals/users/roman/", HOME),
            ("PROPFIND /dav/roman/", COLLECTIONS),
            ("PROPFIND /dav/roman/Contacts/", NO_MEMBERS),
        ])
        .await;
        let client = CarddavClient::new(&dav_base(&root), "roman", "secret").expect("client");
        let book = client.contacts("roman@lavande.mail").await.expect("carnet");

        assert!(book.contacts.is_empty(), "{book:?}");
        assert_eq!(book.skipped, 0);
    }

    #[test]
    fn the_hrefs_of_a_report_are_escaped_for_xml() {
        let body = multiget_body(&["/dav/roman/Contacts/jean&fils.vcf".to_string()]);

        assert!(
            body.contains("<d:href>/dav/roman/Contacts/jean&amp;fils.vcf</d:href>"),
            "{body}"
        );
        assert!(!body.contains("jean&fils"), "{body}");
        assert!(body.ends_with(MULTIGET_END), "{body}");
    }

    #[tokio::test]
    async fn a_member_href_of_the_shape_zimbra_lists_is_read() {
        let root = serve(vec![
            ("PROPFIND /dav/", PRINCIPAL),
            ("PROPFIND /principals/users/roman/", HOME),
            ("PROPFIND /dav/roman/", COLLECTIONS),
            ("PROPFIND /dav/roman/Contacts/", MEMBERS_ESCAPED),
            ("REPORT /dav/roman/Contacts/", CARDS),
        ])
        .await;
        let client = CarddavClient::new(&dav_base(&root), "roman", "secret").expect("client");
        let book = client.contacts("roman@lavande.mail").await.expect("carnet");

        assert_eq!(book.contacts.len(), 2);
        assert_eq!(book.skipped, 1);
    }

    #[tokio::test]
    async fn a_refused_server_is_reported_without_the_secret() {
        let root = serve_status(vec![
            ("PROPFIND /dav/", "", 401),
            ("PROPFIND /dav/roman@lavande.mail/Contacts/", "", 401),
        ])
        .await;
        let client =
            CarddavClient::new(&dav_base(&root), "roman", "secret-app-password").expect("client");
        let error = client
            .contacts("roman@lavande.mail")
            .await
            .expect_err("refusé");
        assert!(matches!(error, MailError::Auth(_)), "{error}");
        assert!(
            !error.to_string().contains("secret-app-password"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn an_empty_email_cannot_derive_the_zimbra_collection() {
        let root = serve(Vec::new()).await;
        let client = CarddavClient::new(&dav_base(&root), "roman", "secret").expect("client");
        let error = client.contacts("  ").await.expect_err("sans adresse");
        assert!(matches!(error, MailError::Carddav(_)), "{error}");
    }

    #[test]
    fn a_url_with_credentials_is_refused() {
        let error =
            match CarddavClient::new("https://roman:secret@dav.exemple.tld/", "roman", "secret") {
                Ok(_) => panic!("URL avec identifiants acceptée"),
                Err(error) => error,
            };
        assert!(!error.to_string().contains("secret@"), "{error}");
        assert!(CarddavClient::new("ftp://dav.exemple.tld/", "roman", "secret").is_err());
        assert!(CarddavClient::new("dav.exemple.tld", "roman", "secret").is_err());
        assert!(CarddavClient::new("https://dav.exemple.tld/", "  ", "secret").is_err());
        assert!(CarddavClient::new("https://dav.exemple.tld/", "roman", "").is_err());
    }

    #[test]
    fn a_truncated_answer_is_refused() {
        assert!(matches!(
            parse_multistatus("<D:multistatus><D:response>"),
            Err(MailError::Carddav(_))
        ));
        assert!(matches!(
            parse_multistatus("pas du xml"),
            Err(MailError::Carddav(_))
        ));
    }
}
