//! MIME parsing on top of `mail-parser`.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use mail_parser::{Address as RawAddress, HeaderValue, MessageParser, MimeHeaders, PartType};

use crate::error::MailError;
use crate::model::{Address, AttachmentMeta, PgpState};
use crate::pgp::{self, PgpDetail, PgpKeyring};

const PREVIEW_LEN: usize = 200;

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedMessage {
    pub subject: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub date: Option<DateTime<Utc>>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub attachments: Vec<AttachmentMeta>,
    pub pgp: PgpState,
    pub pgp_detail: Option<PgpDetail>,
    pub preview: String,
}

/// One attachment with its decoded bytes, ready to be written to disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentBody {
    pub filename: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// Parses a message and, when it is PGP/MIME, verifies its signature and
/// decrypts its body with the keys of `keyring`. The cleartext body of an
/// encrypted message replaces the ciphertext; the envelope headers stay those
/// of the outer message.
pub fn parse_message_with_keys(
    raw: &[u8],
    keyring: &PgpKeyring,
) -> Result<ParsedMessage, MailError> {
    let mut parsed = parse_message(raw)?;
    match parsed.pgp {
        PgpState::None => {}
        PgpState::Signed => parsed.pgp_detail = Some(pgp::mime::verify(raw, keyring)),
        PgpState::Encrypted => {
            let opened = pgp::mime::open(raw, keyring);
            parsed.pgp_detail = Some(opened.detail);
            match opened.entity {
                Some(entity) => clear_body(&mut parsed, &entity),
                None => {
                    parsed.body_text = None;
                    parsed.body_html = None;
                    parsed.attachments.clear();
                    parsed.preview = String::new();
                }
            }
        }
    }
    Ok(parsed)
}

/// Replaces the body of `parsed` with the one of the decrypted MIME entity.
fn clear_body(parsed: &mut ParsedMessage, entity: &[u8]) {
    let Ok(inner) = parse_message(entity) else {
        return;
    };
    parsed.body_text = inner.body_text;
    parsed.body_html = inner.body_html;
    parsed.attachments = inner.attachments;
    parsed.preview = inner.preview;
}

/// The decoded bytes of the `index`-th attachment of a raw message, in the very
/// order `parse_message` lists them. `None` when the message carries no such
/// part. A PGP/MIME message is opened first: its attachments live in the
/// cleartext entity, not in the envelope.
pub fn attachment_body(
    raw: &[u8],
    index: usize,
    keyring: &PgpKeyring,
) -> Result<Option<AttachmentBody>, MailError> {
    let message = parse(raw)?;
    match pgp_state(&message) {
        PgpState::Encrypted => match pgp::mime::open(raw, keyring).entity {
            Some(entity) => Ok(attachment_of_message(&parse(&entity)?, index)),
            None => Ok(None),
        },
        PgpState::None | PgpState::Signed => Ok(attachment_of_message(&message, index)),
    }
}

fn attachment_of_message(
    message: &mail_parser::Message<'_>,
    index: usize,
) -> Option<AttachmentBody> {
    message.attachments().nth(index).map(|part| AttachmentBody {
        filename: part.attachment_name().unwrap_or("attachment").to_string(),
        mime: mime_of(part),
        data: part.contents().to_vec(),
    })
}

fn parse(raw: &[u8]) -> Result<mail_parser::Message<'_>, MailError> {
    MessageParser::default()
        .parse(raw)
        .ok_or_else(|| MailError::Mime("could not parse message".to_string()))
}

/// Parses a raw RFC 5322 message. Decodes transfer encodings and RFC 2047
/// encoded words.
pub fn parse_message(raw: &[u8]) -> Result<ParsedMessage, MailError> {
    let message = parse(raw)?;

    let body_html = html_source(&message).and_then(|html| sanitize_html(&html));
    let body_text = text_body_of(&message, body_html.as_deref());
    let preview = body_text.as_deref().map(preview_of).unwrap_or_default();

    let references = header_texts(message.references())
        .iter()
        .flat_map(|value| crate::threading::split_ids(value))
        .collect();

    let in_reply_to = header_texts(message.in_reply_to())
        .first()
        .and_then(|value| crate::threading::split_ids(value).into_iter().next());

    let attachments = message
        .attachments()
        .map(|part| AttachmentMeta {
            filename: part.attachment_name().unwrap_or("attachment").to_string(),
            mime: mime_of(part),
            size: part.len() as u64,
            inline: matches!(part.body, PartType::InlineBinary(_))
                || part.content_disposition().is_some_and(|cd| cd.is_inline()),
        })
        .collect();

    Ok(ParsedMessage {
        subject: message.subject().unwrap_or_default().to_string(),
        from: message
            .from()
            .and_then(|from| addresses(from).into_iter().next())
            .unwrap_or_default(),
        to: message.to().map(|to| addresses(to)).unwrap_or_default(),
        cc: message.cc().map(|cc| addresses(cc)).unwrap_or_default(),
        date: message.date().and_then(to_utc),
        message_id: message.message_id().map(clean_message_id),
        in_reply_to,
        references,
        body_text,
        body_html,
        attachments,
        pgp: pgp_state(&message),
        pgp_detail: None,
        preview,
    })
}

/// The HTML body of a parsed message, exactly as the sender wrote it.
fn html_source(message: &mail_parser::Message<'_>) -> Option<String> {
    html_body_of(message).and_then(|index| message.body_html(index).map(|html| html.into_owned()))
}

fn html_body_of(message: &mail_parser::Message<'_>) -> Option<usize> {
    (0..message.html_body_count()).find(|index| {
        matches!(
            message.html_part(*index).map(|part| &part.body),
            Some(PartType::Html(_))
        )
    })
}

fn text_body_of(message: &mail_parser::Message<'_>, body_html: Option<&str>) -> Option<String> {
    let text_index = (0..message.text_body_count()).find(|index| {
        matches!(
            message.text_part(*index).map(|part| &part.body),
            Some(PartType::Text(_))
        )
    });
    let body = match text_index {
        Some(index) => clean_text(&message.body_text(index)?),
        None => clean_text(&html_to_text(body_html?)?),
    };
    (!body.is_empty()).then_some(body)
}

/// Repli texte du HTML assaini : les balises de bloc deviennent des sauts de
/// ligne (sinon les cellules d'un tableau se collent), les autres disparaissent,
/// puis le texte est débarrassé de ses caractères invisibles et de ses espaces.
fn html_to_text(html: &str) -> Option<String> {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for character in html.chars() {
        match character {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let name = tag
                    .trim_start_matches('/')
                    .split([' ', '/'])
                    .next()
                    .unwrap_or("");
                if matches!(
                    name,
                    "p" | "br"
                        | "div"
                        | "tr"
                        | "li"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "blockquote"
                        | "pre"
                ) {
                    text.push('\n');
                } else if matches!(name, "td" | "th") {
                    text.push(' ');
                }
            }
            _ if in_tag => tag.push(character),
            _ => text.push(character),
        }
    }
    let decoded = decode_entities(&text);
    (!decoded.trim().is_empty()).then_some(decoded)
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn pgp_state(message: &mail_parser::Message<'_>) -> PgpState {
    if message
        .parts
        .iter()
        .any(|part| part.is_content_type("multipart", "encrypted"))
    {
        PgpState::Encrypted
    } else if message
        .parts
        .iter()
        .any(|part| part.is_content_type("multipart", "signed"))
    {
        PgpState::Signed
    } else {
        PgpState::None
    }
}

fn header_texts(value: &HeaderValue<'_>) -> Vec<String> {
    match value {
        HeaderValue::TextList(list) => list.iter().map(|text| text.to_string()).collect(),
        HeaderValue::Text(text) => vec![text.to_string()],
        _ => Vec::new(),
    }
}

fn addresses(address: &RawAddress<'_>) -> Vec<Address> {
    address
        .iter()
        .map(|addr| Address {
            name: addr.name().map(|name| name.to_string()),
            email: addr.address().unwrap_or_default().to_string(),
        })
        .collect()
}

fn mime_of(part: &mail_parser::MessagePart<'_>) -> String {
    match part.content_type() {
        Some(content_type) => match &content_type.c_subtype {
            Some(subtype) => format!("{}/{}", content_type.c_type, subtype),
            None => content_type.c_type.to_string(),
        },
        None => "application/octet-stream".to_string(),
    }
}

fn clean_message_id(value: &str) -> String {
    value
        .trim()
        .trim_matches(|c| c == '<' || c == '>')
        .to_string()
}

fn to_utc(date: &mail_parser::DateTime) -> Option<DateTime<Utc>> {
    let naive = NaiveDate::from_ymd_opt(
        i32::from(date.year),
        u32::from(date.month),
        u32::from(date.day),
    )?
    .and_hms_opt(
        u32::from(date.hour),
        u32::from(date.minute),
        u32::from(date.second),
    )?;
    let minutes = i64::from(date.tz_hour) * 60 + i64::from(date.tz_minute);
    let offset = chrono::Duration::minutes(if date.tz_before_gmt {
        -minutes
    } else {
        minutes
    });
    Utc.from_utc_datetime(&naive).checked_sub_signed(offset)
}

/// Tags kept by `sanitize_html`: structure and inline emphasis only.
const HTML_TAGS: [&str; 28] = [
    "p",
    "br",
    "div",
    "span",
    "a",
    "ul",
    "ol",
    "li",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "blockquote",
    "code",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "hr",
];

/// The HTML body of a raw message with its remote images kept, ready to render
/// when the reader asks for them: `sanitize_html_with_images` output. A PGP/MIME
/// message is opened first, its HTML lives in the cleartext entity. `None` when
/// the message carries no HTML part, or when its encrypted body cannot be
/// opened with the keys at hand.
pub fn html_with_images(raw: &[u8], keyring: &PgpKeyring) -> Result<Option<String>, MailError> {
    let message = parse(raw)?;
    let entity = match pgp_state(&message) {
        PgpState::Encrypted => match pgp::mime::open(raw, keyring).entity {
            Some(entity) => Some(entity),
            None => return Ok(None),
        },
        PgpState::None | PgpState::Signed => None,
    };
    let source = match &entity {
        Some(entity) => parse(entity)?,
        None => message,
    };
    Ok(html_source(&source).and_then(|html| sanitize_html_with_images(&html)))
}

/// Strips everything a mail can use to break out of the message view: only the
/// tags of `HTML_TAGS` survive, with `href` (http/https/mailto only), `title`,
/// `colspan` and `rowspan`. `script`/`style` keep nothing, images (tracking
/// pixels) are dropped, `on*`/`style`/`srcset` and unknown tags lose their tag
/// but keep their text, links get `rel="noopener noreferrer"` and
/// `target="_blank"`. Returns `None` when no visible text is left.
pub fn sanitize_html(html: &str) -> Option<String> {
    let cleaned = html_sanitizer(false).clean(html).to_string();
    if visible_text(&cleaned).is_empty() {
        return None;
    }
    Some(open_in_new_tab(cleaned))
}

/// Same allow-list as `sanitize_html`, plus `img` with an absolute http(s)
/// `src`: the reader opted in for this message, showing its remote images is
/// what they asked for. `script`, `style`, `on*`, `srcset`, the inline `style`
/// attribute and `javascript:`/`data:`/`mailto:` sources are still dropped, and
/// the markup is sanitized here, on the server, never on the client.
pub fn sanitize_html_with_images(html: &str) -> Option<String> {
    let cleaned = html_sanitizer(true).clean(html).to_string();
    if visible_text(&cleaned).is_empty() && !cleaned.contains("<img") {
        return None;
    }
    Some(open_in_new_tab(cleaned))
}

/// Links leave the message view: they open in a new tab, never in the app's.
fn open_in_new_tab(cleaned: String) -> String {
    cleaned.replace("<a ", "<a target=\"_blank\" ")
}

/// `images` adds `img` to the allow-list and restricts its `src` further.
fn html_sanitizer(images: bool) -> ammonia::Builder<'static> {
    let mut tags: HashSet<&str> = HTML_TAGS.into_iter().collect();
    let mut attributes = HashMap::from([
        ("a", HashSet::from(["href"])),
        ("td", HashSet::from(["colspan", "rowspan"])),
        ("th", HashSet::from(["colspan", "rowspan"])),
    ]);
    if images {
        tags.insert("img");
        attributes.insert("img", HashSet::from(["src", "alt", "width", "height"]));
    }

    let mut builder = ammonia::Builder::default();
    builder
        .tags(tags)
        .tag_attributes(attributes)
        .generic_attributes(HashSet::from(["title"]))
        .url_schemes(HashSet::from(["http", "https", "mailto"]))
        .link_rel(Some("noopener noreferrer"));
    if images {
        builder.attribute_filter(image_source);
    }
    builder
}

/// `src` of an image: an absolute http(s) URL, nothing else. Ammonia already
/// refuses unknown schemes, but `mailto:` is allowed for `href` and must not
/// reach an image.
fn image_source<'a>(element: &str, attribute: &str, value: &'a str) -> Option<Cow<'a, str>> {
    if matches!((element, attribute), ("img", "src")) && !is_remote_url(value) {
        return None;
    }
    Some(value.into())
}

fn is_remote_url(value: &str) -> bool {
    let head = value.trim_start().to_ascii_lowercase();
    head.starts_with("http://") || head.starts_with("https://")
}

/// Text left once the sanitized markup is reduced to its text content.
fn visible_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&#xa0;", " ")
        .replace("&#xA0;", " ");
    clean_text(&text)
}

/// Readable form of a body: zero-width and control characters go away,
/// non-breaking spaces become spaces, decorative separator runs and
/// bullet-only lines disappear, runs of spaces collapse. Paragraph breaks
/// survive, one per run of blank lines.
fn clean_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = Vec::new();
    for line in normalized.split('\n') {
        let line = clean_line(line);
        if line.is_empty() {
            if lines.last().is_some_and(|last| !last.is_empty()) {
                lines.push(String::new());
            }
        } else {
            lines.push(line);
        }
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.join("\n")
}

fn clean_line(line: &str) -> String {
    let mut cleaned = String::with_capacity(line.len());
    let mut separator: Vec<char> = Vec::new();
    let mut pending_space = false;
    for c in line.chars().chain(std::iter::once(' ')) {
        let c = if is_wide_space(c) { ' ' } else { c };
        if is_zero_width(c) {
            pending_space = true;
            continue;
        }
        if is_dropped(c) {
            continue;
        }
        if matches!(c, '-' | '_' | '=') {
            separator.push(c);
            continue;
        }
        if !separator.is_empty() {
            if separator.len() >= 3 {
                pending_space = true;
            } else {
                cleaned.extend(&separator);
            }
            separator.clear();
        }
        if c == ' ' {
            pending_space = true;
            continue;
        }
        if pending_space && !cleaned.is_empty() {
            cleaned.push(' ');
        }
        pending_space = false;
        cleaned.push(c);
    }
    if cleaned
        .chars()
        .all(|c| matches!(c, ' ' | '\u{2022}' | '\u{25CF}'))
    {
        return String::new();
    }
    cleaned
}

fn is_wide_space(c: char) -> bool {
    matches!(c, '\u{00A0}' | '\u{202F}' | '\u{2007}' | '\u{2009}')
}

/// Zero-width characters that stand between words: dropping them would glue
/// the two words, so they leave a space instead.
fn is_zero_width(c: char) -> bool {
    matches!(
        c,
        '\t' | '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{FEFF}'
    )
}

fn is_dropped(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{034F}' | '\u{200D}') || (c.is_control() && c != '\n')
}

/// First `PREVIEW_LEN` characters of the text on a single line, truncated on a
/// word boundary.
fn preview_of(text: &str) -> String {
    let compact = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    truncate_words(&compact, PREVIEW_LEN)
}

fn truncate_words(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let head: String = text.chars().take(limit).collect();
    let head = match head.rfind(' ') {
        Some(index) if index > 0 => &head[..index],
        _ => head.as_str(),
    };
    format!("{}…", head.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = concat!(
        "From: Camille <camille@studio-lilas.fr>\r\n",
        "To: roman@lavande.mail\r\n",
        "Subject: Factures\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: multipart/mixed; boundary=\"coupe\"\r\n",
        "\r\n",
        "--coupe\r\n",
        "Content-Type: text/plain; charset=utf-8\r\n",
        "\r\n",
        "Bonjour\r\n",
        "--coupe\r\n",
        "Content-Type: application/pdf; name=\"facture.pdf\"\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "Content-Disposition: attachment; filename=\"facture.pdf\"\r\n",
        "\r\n",
        "aGVsbG8=\r\n",
        "--coupe\r\n",
        "Content-Type: image/png; name=\"capture.png\"\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "Content-Disposition: inline; filename=\"capture.png\"\r\n",
        "\r\n",
        "aGVsbG8=\r\n",
        "--coupe--\r\n",
    );

    #[test]
    fn an_attachment_is_found_by_the_index_the_model_uses() {
        let parsed = parse_message(RAW.as_bytes()).expect("message");
        assert_eq!(parsed.attachments.len(), 2);

        let first = attachment_body(RAW.as_bytes(), 0, &PgpKeyring::default())
            .expect("lecture")
            .expect("première pièce jointe");
        assert_eq!(first.filename, "facture.pdf");
        assert_eq!(first.mime, "application/pdf");
        assert_eq!(first.data, b"hello");
        assert_eq!(first.data.len() as u64, parsed.attachments[0].size);

        let second = attachment_body(RAW.as_bytes(), 1, &PgpKeyring::default())
            .expect("lecture")
            .expect("seconde pièce jointe");
        assert_eq!(second.filename, "capture.png");
        assert_eq!(second.mime, "image/png");
    }

    #[test]
    fn an_index_past_the_last_attachment_is_none() {
        let body = attachment_body(RAW.as_bytes(), 2, &PgpKeyring::default()).expect("lecture");
        assert_eq!(body, None);
    }

    const HTML_RAW: &str = concat!(
        "From: Camille <camille@studio-lilas.fr>\r\n",
        "To: roman@lavande.mail\r\n",
        "Subject: Soldes\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: text/html; charset=utf-8\r\n",
        "\r\n",
        "<p>Soldes <img src=\"https://pix.example/solde.png\" alt=\"visuel\"></p>\r\n",
        "<script>alert(1)</script>\r\n",
    );

    #[test]
    fn an_image_survives_when_the_reader_asks_for_it() {
        let html = sanitize_html_with_images(
            "<p>Bonjour <img src=\"https://pix.example/t.gif\" alt=\"logo\" \
             onerror=\"alert(1)\" srcset=\"https://pix.example/2x.gif 2x\" \
             style=\"position:fixed\"></p><script>alert(1)</script>",
        )
        .expect("corps");
        assert!(
            html.contains(r#"<img src="https://pix.example/t.gif" alt="logo""#),
            "{html}"
        );
        assert!(!html.contains("onerror"), "{html}");
        assert!(!html.contains("srcset"), "{html}");
        assert!(!html.contains("style"), "{html}");
        assert!(!html.contains("script"), "{html}");
    }

    #[test]
    fn an_image_source_is_http_or_https_only() {
        let html = sanitize_html_with_images(
            "<p>Bonjour</p>\
             <img src=\"javascript:alert(1)\">\
             <img src=\"data:image/gif;base64,AAAA\">\
             <img src=\"mailto:pix@example.org\">\
             <img src=\"/relative/pixel.gif\">",
        )
        .expect("corps");
        assert!(!html.contains("src"), "{html}");
        assert!(!html.contains("javascript"), "{html}");
        assert!(!html.contains("data:"), "{html}");
        assert!(!html.contains("mailto:"), "{html}");
    }

    #[test]
    fn a_link_keeps_its_mailto_and_opens_in_a_new_tab() {
        let html =
            sanitize_html_with_images(r#"<p><a href="mailto:pix@example.org">Écrire</a></p>"#)
                .expect("corps");
        assert!(
            html.contains(r#"<a target="_blank" href="mailto:pix@example.org""#),
            "{html}"
        );
    }

    #[test]
    fn the_default_body_still_drops_every_image() {
        let html = sanitize_html(
            "<p>Soldes</p><img src=\"https://pix.example/solde.png\" alt=\"visuel\">",
        )
        .expect("corps");
        assert!(!html.contains("<img"), "{html}");
        assert!(!html.contains("pix.example"), "{html}");
    }

    #[test]
    fn an_image_only_message_has_no_default_body_but_has_one_with_images() {
        assert_eq!(
            sanitize_html("<img src=\"https://pix.example/solde.png\">"),
            None
        );
        let html = sanitize_html_with_images("<img src=\"https://pix.example/solde.png\">")
            .expect("corps");
        assert_eq!(html, r#"<img src="https://pix.example/solde.png">"#);
    }

    #[test]
    fn the_stored_body_and_the_on_demand_one_differ_by_the_images_only() {
        let stored = parse_message(HTML_RAW.as_bytes()).expect("message");
        let stored = stored.body_html.unwrap_or_default();
        assert!(stored.starts_with("<p>Soldes </p>"), "{stored}");
        assert!(!stored.contains("<img"), "{stored}");

        let html = html_with_images(HTML_RAW.as_bytes(), &PgpKeyring::default())
            .expect("lecture")
            .expect("corps html");
        assert!(
            html.contains(r#"<img src="https://pix.example/solde.png" alt="visuel">"#),
            "{html}"
        );
        assert!(!html.contains("script"), "{html}");
    }

    #[test]
    fn a_message_without_html_has_no_body_with_images() {
        assert_eq!(
            html_with_images(RAW.as_bytes(), &PgpKeyring::default()).expect("lecture"),
            None
        );
    }
}
