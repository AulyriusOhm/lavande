//! MIME parsing on top of `mail-parser`.

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use mail_parser::{Address as RawAddress, HeaderValue, MessageParser, MimeHeaders, PartType};

use crate::error::MailError;
use crate::model::{Address, AttachmentMeta, PgpState};

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
    pub preview: String,
}

/// Parses a raw RFC 5322 message. Decodes transfer encodings and RFC 2047
/// encoded words.
pub fn parse_message(raw: &[u8]) -> Result<ParsedMessage, MailError> {
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| MailError::Mime("could not parse message".to_string()))?;

    let html_index = html_body_of(&message);
    let body_html =
        html_index.and_then(|index| message.body_html(index).map(|html| html.into_owned()));
    let body_text = text_body_of(&message, html_index);
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
        preview,
    })
}

fn html_body_of(message: &mail_parser::Message<'_>) -> Option<usize> {
    (0..message.html_body_count()).find(|index| {
        matches!(
            message.html_part(*index).map(|part| &part.body),
            Some(PartType::Html(_))
        )
    })
}

fn text_body_of(message: &mail_parser::Message<'_>, html_index: Option<usize>) -> Option<String> {
    let index = (0..message.text_body_count())
        .find(|index| {
            matches!(
                message.text_part(*index).map(|part| &part.body),
                Some(PartType::Text(_))
            )
        })
        .or(html_index);
    index.and_then(|index| message.body_text(index).map(|text| text.into_owned()))
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

/// First `PREVIEW_LEN` characters of the text, whitespace collapsed.
fn preview_of(text: &str) -> String {
    compact(text).chars().take(PREVIEW_LEN).collect()
}

fn compact(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
