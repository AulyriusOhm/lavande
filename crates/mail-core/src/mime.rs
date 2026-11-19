//! MIME parsing on top of `mail-parser`.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use cssparser::{
    parse_important, AtRuleParser, BasicParseErrorKind, CowRcStr, DeclarationParser, ParseError,
    Parser, ParserState, QualifiedRuleParser, RuleBodyItemParser, RuleBodyParser, StyleSheetParser,
    ToCss, Token,
};
use mail_parser::{Address as RawAddress, HeaderValue, MessageParser, MimeHeaders, PartType};

use crate::error::MailError;
use crate::model::{Address, AttachmentMeta, PgpState};
use crate::pgp::{self, PgpDetail, PgpKeyring};

const PREVIEW_LEN: usize = 200;

/// Largest inline image rendered from a body, decoded. Past it the image is
/// dropped instead of turning one mail into a multi-megabyte body.
pub(crate) const MAX_INLINE_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// The only image types rendered inline: those every mail client shows without
/// asking.
pub(crate) const INLINE_IMAGE_TYPES: [&str; 4] =
    ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Prefix of a `data:` URL the daemon renders.
const DATA_PREFIX: &str = "data:image/";

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

/// Parses what a message fetched by its headers alone carries: the envelope and
/// the PGP state, with the body, the preview, the attachments and the PGP detail
/// left empty for `fetch_body` to fill in.
pub fn parse_headers(raw: &[u8]) -> Result<ParsedMessage, MailError> {
    let mut parsed = parse_message(raw)?;
    parsed.body_text = None;
    parsed.body_html = None;
    parsed.preview.clear();
    parsed.attachments.clear();
    Ok(parsed)
}

/// Whether a raw header block announces an attachment. A sync only reads
/// headers: `multipart/mixed` is the one hint a message never opened gives, so
/// an attachment carried by a `multipart/alternative` stays invisible until the
/// message is opened and `set_body` writes the real list.
pub fn announces_attachments(raw: &[u8]) -> bool {
    String::from_utf8_lossy(raw)
        .to_ascii_lowercase()
        .contains("multipart/mixed")
}

/// Parses the headers of a message and derives an aperçu from the first bytes
/// of its body: `body_text`, `body_html` and the attachments stay empty, the
/// body itself is never kept. `snippet` is the raw `BODY[TEXT]` fragment the
/// server sent, which can be a MIME part of its own; anything that does not
/// read like prose leaves the aperçu empty.
pub fn parse_headers_with_snippet(raw: &[u8], snippet: &[u8]) -> Result<ParsedMessage, MailError> {
    let mut parsed = parse_headers(raw)?;
    parsed.preview = snippet_preview(raw, snippet);
    Ok(parsed)
}

fn snippet_preview(headers: &[u8], snippet: &[u8]) -> String {
    if snippet.is_empty() {
        return String::new();
    }
    let Ok(envelope) = parse(headers) else {
        return String::new();
    };
    if pgp_state(&envelope) == PgpState::Encrypted {
        return String::new();
    }
    let Some(raw) = headers_with_snippet(headers, snippet) else {
        return String::new();
    };
    let Ok(message) = parse(&raw) else {
        return String::new();
    };
    let body_html = html_source(&message).and_then(|html| sanitize_html(&html));
    let Some(body) = text_body_of(&message, body_html.as_deref()) else {
        return String::new();
    };
    if !reads_like_prose(&body) || leaks_a_boundary(&envelope, &body) {
        return String::new();
    }
    preview_of(&body)
}

/// The headers followed by the fragment the server sent as the body:
/// `mail-parser` then decodes the transfer encoding and the charset of the part
/// the fragment starts with, as it would for the whole message.
fn headers_with_snippet(headers: &[u8], snippet: &[u8]) -> Option<Vec<u8>> {
    let end = headers
        .iter()
        .rposition(|byte| !matches!(byte, b'\r' | b'\n'))?
        + 1;
    let mut raw = Vec::with_capacity(end + 4 + snippet.len());
    raw.extend_from_slice(&headers[..end]);
    raw.extend_from_slice(b"\r\n\r\n");
    raw.extend_from_slice(snippet);
    Some(raw)
}

/// A fragment cut inside an encoded part or a PGP armor reads as noise.
fn reads_like_prose(text: &str) -> bool {
    !text.contains("-----BEGIN PGP")
        && !text.split_whitespace().any(|word| {
            word.chars().count() > 40
                && word.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
                })
        })
}

fn leaks_a_boundary(envelope: &mail_parser::Message<'_>, text: &str) -> bool {
    envelope
        .parts
        .iter()
        .filter_map(|part| part.content_type())
        .filter_map(|content_type| content_type.attributes.as_ref())
        .flatten()
        .filter(|(name, _)| name.eq_ignore_ascii_case("boundary"))
        .any(|(_, boundary)| text.contains(boundary.as_ref()))
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

    let body_html =
        html_source(&message).and_then(|html| sanitize_html(&inline_cid_images(&html, &message)));
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
/// le contenu de `style` et de `script` est ignoré, puis le texte est débarrassé
/// de ses caractères invisibles et de ses espaces.
fn html_to_text(html: &str) -> Option<String> {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    let mut skipped: Option<String> = None;
    for character in html.chars() {
        match character {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let closing = tag.starts_with('/');
                let name = tag
                    .trim_start_matches('/')
                    .split([' ', '\t', '\n', '\r', '/'])
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let ends = matches!(&skipped, Some(open) if closing && name == *open);
                if skipped.is_some() {
                    if ends {
                        skipped = None;
                    }
                    continue;
                }
                if !closing && matches!(name.as_str(), "style" | "script") {
                    skipped = Some(name);
                    continue;
                }
                if matches!(
                    name.as_str(),
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
                } else if matches!(name.as_str(), "td" | "th") {
                    text.push(' ');
                }
            }
            _ if in_tag => tag.push(character),
            _ if skipped.is_none() => text.push(character),
            _ => {}
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

/// Tags kept by `sanitize_html`: structure and inline emphasis only, plus the
/// presentational helpers a mail still relies on (`center`, `font`, `caption`).
const HTML_TAGS: [&str; 31] = [
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
    "center",
    "font",
    "caption",
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
    Ok(html_source(&source)
        .and_then(|html| sanitize_html_with_images(&inline_cid_images(&html, &source))))
}

/// Remplace les `src="cid:…"` d'un corps HTML par l'image de la part qui porte
/// ce `Content-ID`, en `data:` URL : l'image collée par l'expéditeur s'affiche
/// sans clic et sans requête. Un `cid:` sans part, un type hors
/// `INLINE_IMAGE_TYPES` ou une image au-delà de `MAX_INLINE_IMAGE_BYTES` laisse
/// la balise telle quelle, et le sanitizer la retire alors entièrement.
fn inline_cid_images(html: &str, message: &mail_parser::Message<'_>) -> String {
    let mut images: HashMap<&str, String> = HashMap::new();
    for part in &message.parts {
        let Some(content_id) = part.content_id() else {
            continue;
        };
        let mime = mime_of(part);
        let data = part.contents();
        if !INLINE_IMAGE_TYPES.contains(&mime.as_str())
            || data.is_empty()
            || data.len() > MAX_INLINE_IMAGE_BYTES
        {
            continue;
        }
        images.insert(
            content_id.trim_matches(|c| c == '<' || c == '>'),
            format!("data:{mime};base64,{}", STANDARD.encode(data)),
        );
    }
    if images.is_empty() {
        return html.to_string();
    }
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    for image in image_tags(html) {
        let Some(span) = image.src else {
            continue;
        };
        let src = html[span.clone()].trim();
        let Some(scheme) = src.get(..4) else {
            continue;
        };
        if !scheme.eq_ignore_ascii_case("cid:") {
            continue;
        }
        let Some(data) = images.get(src[4..].trim()) else {
            continue;
        };
        out.push_str(&html[cursor..span.start]);
        out.push_str(data);
        cursor = span.end;
    }
    out.push_str(&html[cursor..]);
    out
}

/// Strips everything a mail can use to break out of the message view and keeps
/// what makes its design: only the tags of `HTML_TAGS` survive, with `href`
/// (http/https/mailto only), `title`, `class`, `id` (a `<style>` block selects
/// on it), the table geometry attributes (`width`, `height`, `align`, `valign`,
/// `bgcolor`, `cellpadding`, `cellspacing`, `border`) and a `style` attribute /
/// `<style>` blocks filtered by `sanitize_declarations`.
/// `script`/`iframe`/`form`/`on*`/`srcset` and unknown tags lose their tag but
/// keep their text, remote images (tracking pixels) are dropped, the `data:`
/// images of `INLINE_IMAGE_TYPES` are kept (the content the sender pasted, not
/// a pixel that calls home), links get `rel="noopener noreferrer"` and
/// `target="_blank"`. Returns `None` when no visible text is left.
pub fn sanitize_html(html: &str) -> Option<String> {
    sanitize(html, false)
}

/// Same allow-list as `sanitize_html`, plus `img` with an absolute http(s)
/// `src`: the reader opted in for this message, showing its remote images is
/// what they asked for. `script`, `on*`, `srcset`, `javascript:`/`mailto:`
/// sources, `data:` links and every `url()` in a CSS value are still dropped,
/// and the markup is sanitized here, on the server, never on the client.
pub fn sanitize_html_with_images(html: &str) -> Option<String> {
    sanitize(html, true)
}

fn sanitize(html: &str, images: bool) -> Option<String> {
    let html = unwrap_autolinks(html);
    let (markup, styles) = extract_style_blocks(&html);
    let cleaned = html_sanitizer(images)
        .clean(&drop_refused_images(&markup, images))
        .to_string();
    if visible_text(&cleaned).is_empty() && !cleaned.contains("<img") {
        return None;
    }
    Some(with_style_blocks(&styles, open_in_new_tab(cleaned)))
}

/// One `<img>` of a body: the tag span and the span of its quoted `src`.
pub(crate) struct ImageTag {
    pub tag: std::ops::Range<usize>,
    pub src: Option<std::ops::Range<usize>>,
}

/// The `<img>` tags of a body, in document order.
pub(crate) fn image_tags(html: &str) -> Vec<ImageTag> {
    let lower = html.to_ascii_lowercase();
    let mut tags = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("<img") {
        let start = cursor + offset;
        let Some(close) = lower[start..].find('>') else {
            break;
        };
        let end = start + close + 1;
        cursor = end;
        tags.push(ImageTag {
            tag: start..end,
            src: attribute_span(&lower, start, end, "src"),
        });
    }
    tags
}

/// The value span of one quoted attribute of the tag `from..to`.
pub(crate) fn attribute_span(
    lower: &str,
    from: usize,
    to: usize,
    name: &str,
) -> Option<std::ops::Range<usize>> {
    let needle = format!("{name}=");
    let mut cursor = from;
    while cursor < to {
        let offset = lower[cursor..to].find(&needle)?;
        let at = cursor + offset;
        cursor = at + needle.len();
        if !lower[from..at].ends_with(char::is_whitespace) {
            continue;
        }
        let quote = lower[cursor..to].chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let value = cursor + 1;
        let close = lower[value..to].find(quote)?;
        return Some(value..value + close);
    }
    None
}

/// Splits a `data:` image URL into its MIME type and its base64 payload. Only
/// the types of `INLINE_IMAGE_TYPES` and a payload that cannot leave the
/// attribute are accepted.
pub(crate) fn data_url_parts(src: &str) -> Option<(String, &str)> {
    let (meta, payload) = src.strip_prefix(DATA_PREFIX)?.split_once(',')?;
    let mut fields = meta.split(';');
    let mime = format!("image/{}", fields.next()?.trim().to_ascii_lowercase());
    if !INLINE_IMAGE_TYPES.contains(&mime.as_str()) {
        return None;
    }
    if !fields.any(|field| field.trim().eq_ignore_ascii_case("base64")) {
        return None;
    }
    let plain = payload.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=') || c.is_ascii_whitespace()
    });
    plain.then_some((mime, payload))
}

/// `<img>` whose source will be rendered: a `data:` image of
/// `INLINE_IMAGE_TYPES`, plus the http(s) URLs once the reader asked for the
/// remote images of this message.
fn is_image_source(value: &str, images: bool) -> bool {
    data_url_parts(value.trim()).is_some() || (images && is_remote_url(value))
}

/// Drops the `<img>` the render would refuse anyway: a tracking pixel
/// (http/https) while the reader has not asked for images, a source that is not
/// a known `data:` image, a tag without `src`.
fn drop_refused_images(html: &str, images: bool) -> String {
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    for image in image_tags(html) {
        let kept = image
            .src
            .is_some_and(|src| is_image_source(&html[src], images));
        if kept {
            continue;
        }
        out.push_str(&html[cursor..image.tag.start]);
        cursor = image.tag.end;
    }
    out.push_str(&html[cursor..]);
    out
}

/// `<https://example.com/x>` n'est pas une balise mais une URL entre chevrons :
/// le lecteur HTML la prendrait pour une balise inconnue et la supprimerait avec
/// son texte, le corps garde donc l'URL nue. Les entités `&lt;` ne sont pas
/// touchées.
fn unwrap_autolinks(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        let Some(end) = rest[start..].find('>').map(|offset| start + offset) else {
            break;
        };
        let inner = &rest[start + 1..end];
        let link = !inner.is_empty()
            && !inner.contains(char::is_whitespace)
            && ["https:", "http:", "mailto:", "ftp:"]
                .iter()
                .any(|scheme| inner.starts_with(scheme));
        out.push_str(&rest[..start]);
        if link {
            out.push_str(inner);
        } else {
            out.push_str(&rest[start..=end]);
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Links leave the message view: they open in a new tab, never in the app's.
fn open_in_new_tab(cleaned: String) -> String {
    cleaned.replace("<a ", "<a target=\"_blank\" ")
}

/// `img` is always in the allow-list: its `src` decides, and
/// `drop_refused_images` has already removed the tags the filter would refuse.
/// `images` only opens the http(s) sources, for the reader who asked for them.
fn html_sanitizer(images: bool) -> ammonia::Builder<'static> {
    let mut tags: HashSet<&str> = HTML_TAGS.into_iter().collect();
    tags.insert("img");
    let attributes = HashMap::from([
        ("a", HashSet::from(["href"])),
        (
            "td",
            HashSet::from([
                "colspan", "rowspan", "width", "height", "align", "valign", "bgcolor",
            ]),
        ),
        (
            "th",
            HashSet::from([
                "colspan", "rowspan", "width", "height", "align", "valign", "bgcolor",
            ]),
        ),
        (
            "tr",
            HashSet::from(["height", "align", "valign", "bgcolor"]),
        ),
        (
            "table",
            HashSet::from([
                "width",
                "height",
                "align",
                "bgcolor",
                "cellpadding",
                "cellspacing",
                "border",
            ]),
        ),
        ("font", HashSet::from(["color", "face", "size"])),
        ("img", HashSet::from(["src", "alt", "width", "height"])),
    ]);

    let mut builder = ammonia::Builder::default();
    builder
        .tags(tags)
        .tag_attributes(attributes)
        .generic_attributes(HashSet::from(["title", "style", "class", "id"]))
        .url_schemes(HashSet::from(["http", "https", "mailto", "data"]))
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(move |element, attribute, value| {
            filter_attribute(element, attribute, value, images)
        });
    builder
}

/// Second line of defence, element by element: an image `src` is a `data:`
/// image of `INLINE_IMAGE_TYPES` or, for a reader who asked for them, an
/// absolute http(s) URL; a link never carries a `data:` URL; a `style`
/// attribute is filtered down to `sanitize_declarations`; the geometry
/// attributes are checked against their own grammar (a length, an enumeration,
/// a colour) and everything else passes untouched.
fn filter_attribute<'a>(
    element: &str,
    attribute: &str,
    value: &'a str,
    images: bool,
) -> Option<Cow<'a, str>> {
    match (element, attribute) {
        ("img", "src") => is_image_source(value, images).then(|| value.into()),
        ("a", "href") => (!is_data_url(value)).then(|| value.into()),
        (_, "style") => {
            let cleaned = sanitize_declarations(value);
            (!cleaned.is_empty()).then_some(Cow::Owned(cleaned))
        }
        (_, "width" | "height") if matches!(element, "table" | "tr" | "td" | "th" | "img") => {
            is_length(value).then(|| value.into())
        }
        (_, "cellpadding") | (_, "cellspacing") | (_, "border") if element == "table" => {
            is_length(value).then(|| value.into())
        }
        ("table", "align") => in_enumeration(value, &["left", "center", "right"]),
        ("td" | "th" | "tr", "align") => {
            in_enumeration(value, &["left", "center", "right", "justify"])
        }
        ("td" | "th" | "tr", "valign") => {
            in_enumeration(value, &["top", "middle", "bottom", "baseline"])
        }
        (_, "bgcolor") | ("font", "color") => is_html_color(value).then(|| value.into()),
        ("font", "face") => is_font_face(value).then(|| value.into()),
        ("font", "size") => is_font_size(value).then(|| value.into()),
        _ => Some(value.into()),
    }
}

fn in_enumeration<'a>(value: &'a str, allowed: &[&str]) -> Option<Cow<'a, str>> {
    allowed
        .iter()
        .any(|one| one.eq_ignore_ascii_case(value.trim()))
        .then(|| value.into())
}

/// A `data:` URL: the scheme is open for the images of a body, never for a
/// link.
fn is_data_url(value: &str) -> bool {
    value.trim_start().to_ascii_lowercase().starts_with("data:")
}

/// `src` of a remote image: an absolute http(s) URL, nothing else. Ammonia
/// already refuses unknown schemes, but `mailto:` is allowed for `href` and
/// must not reach an image.
fn is_remote_url(value: &str) -> bool {
    let head = value.trim_start().to_ascii_lowercase();
    head.starts_with("http://") || head.starts_with("https://")
}

/// A width, a height or a cell padding: digits, or digits and a `%`.
fn is_length(value: &str) -> bool {
    let value = value.trim();
    let digits = value.strip_suffix('%').unwrap_or(value);
    !digits.is_empty() && digits.len() <= 4 && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// `bgcolor` and `font color`: `#rgb`, `#rrggbb`, `rgb()`/`rgba()` or a CSS
/// colour name.
fn is_html_color(value: &str) -> bool {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 6) && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    let lower = value.to_ascii_lowercase();
    is_rgb_color(&lower) || CSS_COLORS.iter().any(|name| *name == lower)
}

fn is_rgb_color(lower: &str) -> bool {
    let inner = match lower.strip_prefix("rgb(") {
        Some(inner) => inner,
        None => match lower.strip_prefix("rgba(") {
            Some(inner) => inner,
            None => return false,
        },
    };
    let Some(inner) = inner.strip_suffix(')') else {
        return false;
    };
    let parts: Vec<&str> = inner.split(',').collect();
    matches!(parts.len(), 3 | 4)
        && parts.iter().all(|part| {
            let part = part.trim();
            let digits = part.strip_suffix('%').unwrap_or(part);
            !digits.is_empty()
                && digits
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
        })
}

/// `font face`: a font name, so letters, digits, spaces, quotes and commas.
fn is_font_face(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b' ' | b',' | b'-' | b'\'' | b'"' | b'.' | b'_')
        })
}

/// `font size`: the legacy 1-7 scale, optionally relative.
fn is_font_size(value: &str) -> bool {
    let value = value.trim();
    let digits = value.trim_start_matches(['+', '-']);
    digits.len() == 1 && matches!(digits.as_bytes()[0], b'1'..=b'7')
}

/// Properties a mail keeps: the presentation of its own design, nothing that
/// can redraw the message view (`position`, `z-index`, `overflow`,
/// `-moz-binding`, `behavior`) or load a resource (every `url()` is refused).
const STYLE_PROPERTIES: &[&str] = &[
    "background",
    "background-color",
    "border",
    "border-collapse",
    "border-spacing",
    "box-shadow",
    "clear",
    "color",
    "direction",
    "display",
    "float",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "height",
    "letter-spacing",
    "line-height",
    "list-style",
    "margin",
    "max-height",
    "max-width",
    "min-height",
    "min-width",
    "opacity",
    "overflow-wrap",
    "padding",
    "table-layout",
    "text-align",
    "text-decoration",
    "text-indent",
    "text-transform",
    "vertical-align",
    "white-space",
    "width",
    "word-break",
    "word-spacing",
];

/// Longhands of the shorthands above: `padding-top`, `margin-left`,
/// `border-bottom-left-radius`, `background-image:linear-gradient(…)`,
/// `list-style-type`… `background-` never reintroduces a resource: every
/// `url()` is refused by `write_token` whatever the property.
const STYLE_PREFIXES: &[&str] = &[
    "background-",
    "border-",
    "list-style-",
    "margin-",
    "padding-",
];

/// Words that never belong in a value: they either run code (`expression()`,
/// `javascript:`), bind a behaviour to the element (`behavior`,
/// `-moz-binding`) or fetch something.
const DENIED_VALUE_WORDS: &[&str] = &[
    "-moz-binding",
    "behavior",
    "expression",
    "javascript",
    "url",
    "vbscript",
];

const DISPLAY_VALUES: &[&str] = &[
    "block",
    "flex",
    "inline",
    "inline-block",
    "list-item",
    "none",
    "table",
    "table-cell",
    "table-row",
];

/// CSS colour names a mail may put in a `bgcolor` or a `font color`. Named
/// colours are the only values left once hex and `rgb()` are handled, so the
/// list is closed rather than guessed from the shape of the token.
const CSS_COLORS: &[&str] = &[
    "aliceblue",
    "antiquewhite",
    "aqua",
    "aquamarine",
    "azure",
    "beige",
    "bisque",
    "black",
    "blanchedalmond",
    "blue",
    "blueviolet",
    "brown",
    "burlywood",
    "cadetblue",
    "chartreuse",
    "chocolate",
    "coral",
    "cornflowerblue",
    "cornsilk",
    "crimson",
    "cyan",
    "darkblue",
    "darkcyan",
    "darkgoldenrod",
    "darkgray",
    "darkgreen",
    "darkgrey",
    "darkkhaki",
    "darkmagenta",
    "darkolivegreen",
    "darkorange",
    "darkorchid",
    "darkred",
    "darksalmon",
    "darkseagreen",
    "darkslateblue",
    "darkslategray",
    "darkslategrey",
    "darkturquoise",
    "darkviolet",
    "deeppink",
    "deepskyblue",
    "dimgray",
    "dimgrey",
    "dodgerblue",
    "firebrick",
    "floralwhite",
    "forestgreen",
    "fuchsia",
    "gainsboro",
    "ghostwhite",
    "gold",
    "goldenrod",
    "gray",
    "green",
    "greenyellow",
    "grey",
    "honeydew",
    "hotpink",
    "indianred",
    "indigo",
    "ivory",
    "khaki",
    "lavender",
    "lavenderblush",
    "lawngreen",
    "lemonchiffon",
    "lightblue",
    "lightcoral",
    "lightcyan",
    "lightgoldenrodyellow",
    "lightgray",
    "lightgreen",
    "lightgrey",
    "lightpink",
    "lightsalmon",
    "lightseagreen",
    "lightskyblue",
    "lightslategray",
    "lightslategrey",
    "lightsteelblue",
    "lightyellow",
    "lime",
    "limegreen",
    "linen",
    "magenta",
    "maroon",
    "mediumaquamarine",
    "mediumblue",
    "mediumorchid",
    "mediumpurple",
    "mediumseagreen",
    "mediumslateblue",
    "mediumspringgreen",
    "mediumturquoise",
    "mediumvioletred",
    "midnightblue",
    "mintcream",
    "mistyrose",
    "moccasin",
    "navajowhite",
    "navy",
    "oldlace",
    "olive",
    "olivedrab",
    "orange",
    "orangered",
    "orchid",
    "palegoldenrod",
    "palegreen",
    "paleturquoise",
    "palevioletred",
    "papayawhip",
    "peachpuff",
    "peru",
    "pink",
    "plum",
    "powderblue",
    "purple",
    "rebeccapurple",
    "red",
    "rosybrown",
    "royalblue",
    "saddlebrown",
    "salmon",
    "sandybrown",
    "seagreen",
    "seashell",
    "sienna",
    "silver",
    "skyblue",
    "slateblue",
    "slategray",
    "slategrey",
    "snow",
    "springgreen",
    "steelblue",
    "tan",
    "teal",
    "thistle",
    "tomato",
    "transparent",
    "turquoise",
    "violet",
    "wheat",
    "white",
    "whitesmoke",
    "yellow",
    "yellowgreen",
];

/// Deeper ``@media`` nesting is not a mail design, it is a way to grow the
/// parser: three levels cover the responsive templates.
const MAX_STYLE_DEPTH: usize = 3;

/// One CSS declaration list, filtered: a property of the allow-list, a value
/// without a forbidden word, function or token.
struct Declarations;

impl<'i> DeclarationParser<'i> for Declarations {
    type Declaration = String;
    type Error = ();

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _start: &ParserState,
    ) -> Result<Self::Declaration, ParseError<()>> {
        if !style_property_allowed(&name) {
            return Err(ParseError::unexpected_token());
        }
        let mut value = String::new();
        let mut important = false;
        loop {
            if input.try_parse(parse_important).is_ok() {
                important = true;
                break;
            }
            let token = match input.next() {
                Ok(token) => token.clone(),
                Err(error) if error.kind == BasicParseErrorKind::EndOfInput => break,
                Err(error) => return Err(error.into()),
            };
            write_token(&token, input, &mut value)?;
        }
        let value = value.trim();
        if value.is_empty() || !style_value_allowed(&name, value) {
            return Err(ParseError::unexpected_token());
        }
        let mut declaration = format!("{}:{}", name.to_ascii_lowercase(), value);
        if important {
            declaration.push_str(" !important");
        }
        Ok(declaration)
    }
}

impl<'i> AtRuleParser<'i> for Declarations {
    type Prelude = ();
    type AtRule = String;
    type Error = ();
}

impl<'i> QualifiedRuleParser<'i> for Declarations {
    type Prelude = ();
    type QualifiedRule = String;
    type Error = ();
}

impl<'i> RuleBodyItemParser<'i, String, ()> for Declarations {
    fn parse_declarations(&self) -> bool {
        true
    }

    fn parse_qualified(&self) -> bool {
        false
    }
}

/// Keeps the declarations of `css` that survive the allow-list, re-serialized
/// from their tokens: a `style` attribute and a rule of a `<style>` block go
/// through the same filter.
fn sanitize_declarations(css: &str) -> String {
    let css = strip_comments(css);
    let mut parser = Parser::new(&css);
    declarations_of(&mut parser)
}

fn declarations_of(input: &mut Parser) -> String {
    let mut declarations = Declarations;
    RuleBodyParser::new(input, &mut declarations)
        .filter_map(|item| item.ok())
        .collect::<Vec<_>>()
        .join(";")
}

fn style_property_allowed(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    STYLE_PROPERTIES.contains(&name.as_str())
        || STYLE_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn style_value_allowed(property: &str, value: &str) -> bool {
    if property.eq_ignore_ascii_case("display") {
        return DISPLAY_VALUES
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(value));
    }
    // A background has no use for a string, but `image-set("https://…" 1x)`
    // is a quoted resource the WebView still fetches: `url()` is not the only
    // way to name one.
    if property.to_ascii_lowercase().starts_with("background") {
        return !value.contains(['"', '\'']);
    }
    true
}

fn is_denied_value_word(word: &str) -> bool {
    DENIED_VALUE_WORDS
        .iter()
        .any(|denied| word.eq_ignore_ascii_case(denied))
}

/// Re-serializes one token of a declaration value, refusing anything that
/// executes, binds or fetches. Blocks are walked recursively, so a `url(`
/// hidden in `image-set()` is refused too.
fn write_token<'i>(
    token: &Token<'i>,
    input: &mut Parser<'i>,
    value: &mut String,
) -> Result<(), ParseError<()>> {
    match token {
        Token::UnquotedUrl(_)
        | Token::BadUrl(_)
        | Token::BadString(_)
        | Token::AtKeyword(_)
        | Token::Semicolon
        | Token::CurlyBracketBlock
        | Token::CloseParenthesis
        | Token::CloseSquareBracket
        | Token::CloseCurlyBracket => Err(ParseError::unexpected_token()),
        Token::Delim('<' | '>' | '\\' | '@' | '{' | '}') => Err(ParseError::unexpected_token()),
        Token::Ident(word) if is_denied_value_word(word) => Err(ParseError::unexpected_token()),
        Token::Function(name) => {
            if is_denied_value_word(name) {
                return Err(ParseError::unexpected_token());
            }
            separate(value);
            value.push_str(name);
            value.push('(');
            input.parse_nested_block(|nested| write_tokens(nested, value))?;
            value.push(')');
            Ok(())
        }
        Token::ParenthesisBlock => {
            separate(value);
            value.push('(');
            input.parse_nested_block(|nested| write_tokens(nested, value))?;
            value.push(')');
            Ok(())
        }
        Token::SquareBracketBlock => {
            separate(value);
            value.push('[');
            input.parse_nested_block(|nested| write_tokens(nested, value))?;
            value.push(']');
            Ok(())
        }
        _ => {
            if !matches!(token, Token::Comma) {
                separate(value);
            }
            token
                .to_css(value)
                .map_err(|_| ParseError::unexpected_token())
        }
    }
}

fn write_tokens(input: &mut Parser, value: &mut String) -> Result<(), ParseError<()>> {
    loop {
        let token = match input.next() {
            Ok(token) => token.clone(),
            Err(error) if error.kind == BasicParseErrorKind::EndOfInput => break Ok(()),
            Err(error) => return Err(error.into()),
        };
        write_token(&token, input, value)?;
    }
}

fn separate(value: &mut String) {
    if !value.is_empty() && !value.ends_with([' ', '(', '[']) {
        value.push(' ');
    }
}

/// CSS comments hidden between two tokens (`co/**/lor`, `url/**/(`) never reach
/// the parser: they are removed first, inside strings excluded.
fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(character) = chars.next() {
        if let Some(opened) = quote {
            out.push(character);
            match character {
                '\\' => out.extend(chars.next()),
                _ if character == opened => quote = None,
                _ => {}
            }
            continue;
        }
        match character {
            '"' | '\'' => {
                quote = Some(character);
                out.push(character);
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut closed = false;
                while let Some(next) = chars.next() {
                    if next == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        closed = true;
                        break;
                    }
                }
                if !closed {
                    return out;
                }
                out.push(' ');
            }
            _ => out.push(character),
        }
    }
    out
}

/// A style rule list: qualified rules keep their selector and their filtered
/// declarations, `@media` keeps its nested rules, every other at-rule
/// (`@import`, `@font-face`, `@charset`, `@supports`…) is dropped whole.
enum StyleRule {
    Block {
        prelude: String,
        declarations: String,
    },
    Media {
        condition: String,
        rules: Vec<StyleRule>,
    },
}

struct Sheet {
    depth: usize,
}

impl<'i> QualifiedRuleParser<'i> for Sheet {
    type Prelude = String;
    type QualifiedRule = StyleRule;
    type Error = ();

    fn parse_prelude(&mut self, input: &mut Parser<'i>) -> Result<Self::Prelude, ParseError<()>> {
        let start = input.position();
        scan_selector(input)?;
        let prelude = input.slice(start..input.position()).trim();
        if prelude.is_empty() {
            return Err(ParseError::unexpected_token());
        }
        Ok(prelude.to_string())
    }

    fn parse_block(
        &mut self,
        prelude: String,
        _start: &ParserState,
        input: &mut Parser<'i>,
    ) -> Result<Self::QualifiedRule, ParseError<()>> {
        Ok(StyleRule::Block {
            prelude,
            declarations: declarations_of(input),
        })
    }
}

impl<'i> AtRuleParser<'i> for Sheet {
    type Prelude = String;
    type AtRule = StyleRule;
    type Error = ();

    fn parse_prelude(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
    ) -> Result<Self::Prelude, ParseError<()>> {
        if self.depth >= MAX_STYLE_DEPTH || !name.eq_ignore_ascii_case("media") {
            return Err(ParseError::from_basic_kind(
                BasicParseErrorKind::AtRuleInvalid,
            ));
        }
        let start = input.position();
        scan_media(input)?;
        Ok(input.slice(start..input.position()).trim().to_string())
    }

    fn parse_block(
        &mut self,
        condition: String,
        _start: &ParserState,
        input: &mut Parser<'i>,
    ) -> Result<Self::AtRule, ParseError<()>> {
        Ok(StyleRule::Media {
            condition,
            rules: style_rules(input, self.depth + 1),
        })
    }
}

/// A selector: tokens are walked through every nested block so a `url(` or a
/// stray `<` cannot hide in a pseudo-class argument.
fn scan_selector(input: &mut Parser) -> Result<(), ParseError<()>> {
    loop {
        let token = match input.next() {
            Ok(token) => token,
            Err(error) if error.kind == BasicParseErrorKind::EndOfInput => break Ok(()),
            Err(error) => return Err(error.into()),
        };
        match token {
            Token::Ident(word) if is_denied_value_word(word) => {
                return Err(ParseError::unexpected_token())
            }
            Token::Ident(_)
            | Token::Hash(_)
            | Token::IDHash(_)
            | Token::QuotedString(_)
            | Token::Number { .. }
            | Token::Dimension { .. }
            | Token::Percentage { .. }
            | Token::Comma
            | Token::Colon
            | Token::IncludeMatch
            | Token::DashMatch
            | Token::PrefixMatch
            | Token::SuffixMatch
            | Token::SubstringMatch
            | Token::Delim('.' | '>' | '~' | '+' | '*' | '|' | '=' | '^' | '$' | '-') => {}
            Token::Function(name) => {
                if is_denied_value_word(name) {
                    return Err(ParseError::unexpected_token());
                }
                input.parse_nested_block(scan_selector)?;
            }
            Token::ParenthesisBlock | Token::SquareBracketBlock => {
                input.parse_nested_block(scan_selector)?;
            }
            _ => return Err(ParseError::unexpected_token()),
        }
    }
}

/// A media query: the shape of `screen and (max-width:600px)`, nothing else.
fn scan_media(input: &mut Parser) -> Result<(), ParseError<()>> {
    loop {
        let token = match input.next() {
            Ok(token) => token,
            Err(error) if error.kind == BasicParseErrorKind::EndOfInput => break Ok(()),
            Err(error) => return Err(error.into()),
        };
        match token {
            Token::Ident(word) if is_denied_value_word(word) => {
                return Err(ParseError::unexpected_token())
            }
            Token::Ident(_)
            | Token::Number { .. }
            | Token::Percentage { .. }
            | Token::Dimension { .. }
            | Token::Colon
            | Token::Comma
            | Token::Delim('/' | '.' | '+' | '-') => {}
            Token::ParenthesisBlock => input.parse_nested_block(scan_media)?,
            _ => return Err(ParseError::unexpected_token()),
        }
    }
}

fn style_rules(input: &mut Parser, depth: usize) -> Vec<StyleRule> {
    let mut sheet = Sheet { depth };
    StyleSheetParser::new(input, &mut sheet)
        .filter_map(|item| item.ok())
        .collect()
}

/// A `<style>` block, filtered rule by rule. The result is prepended to the
/// cleaned body, so it lands after the client sheet of the document and wins
/// at equal specificity. Nothing that could close the element survives.
fn sanitize_style_block(css: &str) -> String {
    let css = strip_comments(css);
    let mut parser = Parser::new(&css);
    let mut out = String::new();
    write_style_rules(&style_rules(&mut parser, 0), &mut out);
    out.replace("</", "<\\/")
}

fn write_style_rules(rules: &[StyleRule], out: &mut String) {
    for rule in rules {
        match rule {
            StyleRule::Block {
                prelude,
                declarations,
            } => {
                if declarations.is_empty() {
                    continue;
                }
                out.push_str(prelude);
                out.push('{');
                out.push_str(declarations);
                out.push('}');
            }
            StyleRule::Media { condition, rules } => {
                out.push_str("@media ");
                out.push_str(condition);
                out.push('{');
                write_style_rules(rules, out);
                out.push('}');
            }
        }
    }
}

/// Removes every `<style>` element from the raw markup and returns the
/// sanitized CSS of each, in document order: ammonia never sees them, and they
/// are put back at the top of the cleaned body. An unclosed block runs to the end
/// of the message, exactly as a browser reads it.
fn extract_style_blocks(html: &str) -> (String, Vec<String>) {
    let lowered = html.to_ascii_lowercase();
    let mut markup = String::with_capacity(html.len());
    let mut styles = Vec::new();
    let mut cursor = 0;
    while let Some(found) = lowered[cursor..].find("<style") {
        let opening = cursor + found;
        let after_name = opening + "<style".len();
        let boundary = lowered[after_name..].chars().next();
        if !matches!(boundary, Some('>' | ' ' | '\t' | '\n' | '\r' | '/')) {
            markup.push_str(&html[cursor..after_name]);
            cursor = after_name;
            continue;
        }
        let Some(content_start) = lowered[after_name..]
            .find('>')
            .map(|offset| after_name + offset + 1)
        else {
            break;
        };
        markup.push_str(&html[cursor..opening]);
        let (content_end, next) = match lowered[content_start..].find("</style") {
            Some(offset) => {
                let closing = content_start + offset;
                let next = lowered[closing..]
                    .find('>')
                    .map_or(lowered.len(), |end| closing + end + 1);
                (closing, next)
            }
            None => (lowered.len(), lowered.len()),
        };
        let css = sanitize_style_block(&html[content_start..content_end]);
        if !css.is_empty() {
            styles.push(css);
        }
        cursor = next;
    }
    markup.push_str(&html[cursor..]);
    (markup, styles)
}

fn with_style_blocks(styles: &[String], body: String) -> String {
    if styles.is_empty() {
        return body;
    }
    let mut out = String::new();
    for css in styles {
        out.push_str("<style>");
        out.push_str(css);
        out.push_str("</style>");
    }
    out.push_str(&body);
    out
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

    #[test]
    fn the_headers_alone_carry_the_envelope_and_no_body() {
        let headers = RAW.split_once("\r\n\r\n").expect("en-têtes").0;
        let parsed = parse_headers(headers.as_bytes()).expect("en-tetes");
        assert_eq!(parsed.subject, "Factures");
        assert_eq!(parsed.from.email, "camille@studio-lilas.fr");
        assert_eq!(parsed.body_text, None);
        assert_eq!(parsed.body_html, None);
        assert_eq!(parsed.preview, "");
        assert_eq!(parsed.attachments, Vec::new());
        assert_eq!(parsed.pgp, PgpState::None);
        assert_eq!(parsed.pgp_detail, None);
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
    fn an_image_source_is_a_data_image_or_an_http_url() {
        let html = sanitize_html_with_images(
            "<p>Bonjour</p>\
             <img src=\"javascript:alert(1)\">\
             <img src=\"data:image/gif;base64,AAAA\">\
             <img src=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">\
             <img src=\"data:image/png,notbase64\">\
             <img src=\"mailto:pix@example.org\">\
             <img src=\"/relative/pixel.gif\">",
        )
        .expect("corps");
        assert!(
            html.contains(r#"<img src="data:image/gif;base64,AAAA">"#),
            "{html}"
        );
        assert_eq!(html.matches("<img").count(), 1, "{html}");
        assert!(!html.contains("javascript"), "{html}");
        assert!(!html.contains("data:text/html"), "{html}");
        assert!(!html.contains("notbase64"), "{html}");
        assert!(!html.contains("mailto:"), "{html}");
        assert!(!html.contains("relative"), "{html}");
    }

    #[test]
    fn a_data_image_survives_the_default_body_and_an_http_one_does_not() {
        let html = sanitize_html(
            "<p>Capture</p><img src=\"data:image/png;base64,iVBORw==\" alt=\"capture\">\
             <img src=\"https://track.test/p.gif\" width=\"1\" height=\"1\">",
        )
        .expect("corps");
        assert!(
            html.contains(r#"<img src="data:image/png;base64,iVBORw==" alt="capture">"#),
            "{html}"
        );
        assert_eq!(html.matches("<img").count(), 1, "{html}");
        assert!(!html.contains("track.test"), "{html}");
    }

    #[test]
    fn a_link_never_carries_a_data_url() {
        let html = sanitize_html_with_images(
            r#"<p><a href="data:text/html;base64,PHNjcmlwdD4=">lien</a></p>"#,
        )
        .expect("corps");
        assert!(!html.contains("data:"), "{html}");
        assert!(html.contains(">lien</a>"), "{html}");
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
