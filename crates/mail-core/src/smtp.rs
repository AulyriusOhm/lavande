//! SMTP submission through `lettre`, with the same TLS roots as IMAP.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use lettre::address::Envelope;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{Certificate, CertificateStore, Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::{AccountConfig, AuthConfig, Encryption, Endpoint};
use crate::error::MailError;
use crate::mime::{attribute_span, data_url_parts, image_tags, MAX_INLINE_IMAGE_BYTES};
use crate::model::Address;
use crate::oauth::OAuth2Provider;
use crate::tls::TlsOptions;

pub struct OutgoingAttachment {
    pub filename: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// One `data:` image of the body, lifted into a MIME part of its own.
struct InlineImage {
    content_id: String,
    mime: String,
    data: Vec<u8>,
}

/// One `<img src="data:…">` of the body: the tag to drop or keep, the value to
/// rewrite, and the `alt` to carry over.
struct BodyImage {
    tag: std::ops::Range<usize>,
    src: std::ops::Range<usize>,
    alt: Option<String>,
}

pub struct OutgoingMessage {
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub text: String,
    pub html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
    /// Sign with the secret key matching the sender's address.
    pub pgp_sign: bool,
    /// Encrypt with the public keys of every recipient.
    pub pgp_encrypt: bool,
}

/// Sends one message against the webpki roots. `Message-ID` is left to lettre.
pub async fn send(cfg: &AccountConfig, message: &OutgoingMessage) -> Result<(), MailError> {
    send_with(cfg, message, &TlsOptions::default()).await
}

/// Sends one message. `Message-ID` is left to lettre.
pub async fn send_with(
    cfg: &AccountConfig,
    message: &OutgoingMessage,
    tls_options: &TlsOptions,
) -> Result<(), MailError> {
    let email = build_message(message)?;
    send_built_with(cfg, email, tls_options).await
}

/// Sends an already-built message so the caller can keep the exact bytes (and
/// the `Message-ID`) for the Sent-folder copy.
pub async fn send_built_with(
    cfg: &AccountConfig,
    email: Message,
    tls_options: &TlsOptions,
) -> Result<(), MailError> {
    transport(cfg, tls_options)
        .await?
        .send(email)
        .await
        .map_err(|error| MailError::Smtp(error.to_string()))?;
    Ok(())
}

/// Sends RFC 5322 bytes built elsewhere (PGP/MIME): the envelope carries the
/// recipients, the payload travels verbatim.
pub async fn send_raw_with(
    cfg: &AccountConfig,
    raw: &[u8],
    envelope: &Envelope,
    tls_options: &TlsOptions,
) -> Result<(), MailError> {
    transport(cfg, tls_options)
        .await?
        .send_raw(envelope, raw)
        .await
        .map_err(|error| MailError::Smtp(error.to_string()))?;
    Ok(())
}

async fn transport(
    cfg: &AccountConfig,
    tls_options: &TlsOptions,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, MailError> {
    let builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(cfg.smtp.host.clone())
        .port(cfg.smtp.port)
        .tls(tls(&cfg.smtp, tls_options)?);

    let builder = match &cfg.auth {
        AuthConfig::Password { password } => builder
            .credentials(Credentials::new(cfg.username.clone(), password.clone()))
            .authentication(vec![Mechanism::Plain, Mechanism::Login]),
        AuthConfig::OAuth2 {
            client_id,
            client_secret,
            refresh_token,
            token_endpoint,
        } => {
            let mut provider = OAuth2Provider::new(
                client_id.clone(),
                client_secret.clone(),
                refresh_token.clone(),
                token_endpoint.clone(),
            );
            let access_token = provider.access_token().await?;
            builder
                .credentials(Credentials::new(cfg.username.clone(), access_token))
                .authentication(vec![Mechanism::Xoauth2])
        }
    };

    Ok(builder.build())
}

fn tls(endpoint: &Endpoint, options: &TlsOptions) -> Result<Tls, MailError> {
    let mut builder = TlsParameters::builder(endpoint.host.clone())
        .certificate_store(CertificateStore::WebpkiRoots);
    for root in options.extra_roots_der()? {
        let certificate =
            Certificate::from_der(root).map_err(|error| MailError::Tls(error.to_string()))?;
        builder = builder.add_root_certificate(certificate);
    }
    let parameters = builder
        .build()
        .map_err(|error| MailError::Tls(error.to_string()))?;
    match endpoint.encryption {
        Encryption::Tls => Ok(Tls::Wrapper(parameters)),
        Encryption::StartTls => Ok(Tls::Required(parameters)),
        Encryption::Plain => Err(MailError::Config(
            "plaintext smtp connection is forbidden with stored credentials".to_string(),
        )),
    }
}

/// Builds the outgoing message without sending it.
pub fn build_message(message: &OutgoingMessage) -> Result<Message, MailError> {
    if message.to.is_empty() && message.cc.is_empty() && message.bcc.is_empty() {
        return Err(MailError::Smtp("no recipient".to_string()));
    }
    let mut builder = Message::builder()
        .from(mailbox(&message.from)?)
        .subject(message.subject.clone())
        .date_now()
        .message_id(None);
    for to in &message.to {
        builder = builder.to(mailbox(to)?);
    }
    for cc in &message.cc {
        builder = builder.cc(mailbox(cc)?);
    }
    for bcc in &message.bcc {
        builder = builder.bcc(mailbox(bcc)?);
    }
    if let Some(in_reply_to) = &message.in_reply_to {
        builder = builder.in_reply_to(format!("<{in_reply_to}>"));
    }
    for reference in &message.references {
        builder = builder.references(format!("<{reference}>"));
    }

    let email = match body_of(message)? {
        Body::Plain(part) => builder.singlepart(part),
        Body::Multi(part) => builder.multipart(part),
    };
    email.map_err(|error| MailError::Smtp(error.to_string()))
}

/// The MIME entity of the body (its `Content-Type` header and its content):
/// what PGP/MIME signs and encrypts.
pub fn body_entity(message: &OutgoingMessage) -> Result<Vec<u8>, MailError> {
    Ok(match body_of(message)? {
        Body::Plain(part) => part.formatted(),
        Body::Multi(part) => part.formatted(),
    })
}

enum Body {
    Plain(SinglePart),
    Multi(MultiPart),
}

fn body_of(message: &OutgoingMessage) -> Result<Body, MailError> {
    let (markup, images) = match message.html.as_deref() {
        Some(html) => lift_inline_images(html),
        None => (String::new(), Vec::new()),
    };
    let html = message
        .html
        .as_ref()
        .map(|_| alternative(&message.text, &markup, &images))
        .transpose()?;
    Ok(match (html, message.attachments.is_empty()) {
        (Some(html), true) => Body::Multi(html),
        (None, true) => Body::Plain(SinglePart::plain(message.text.clone())),
        (html, false) => {
            let body = html.unwrap_or_else(|| {
                MultiPart::mixed().singlepart(SinglePart::plain(message.text.clone()))
            });
            let mut parts = MultiPart::mixed().multipart(body);
            for attachment in &message.attachments {
                parts = parts.singlepart(attachment_part(attachment)?);
            }
            Body::Multi(parts)
        }
    })
}

/// `text/plain` and the HTML body. Inline images make the HTML branch a
/// `multipart/related`: the markup is the root part, each image a `cid:` part
/// the reader renders in place.
fn alternative(text: &str, html: &str, images: &[InlineImage]) -> Result<MultiPart, MailError> {
    let plain = SinglePart::plain(text.to_string());
    if images.is_empty() {
        return Ok(MultiPart::alternative()
            .singlepart(plain)
            .singlepart(SinglePart::html(html.to_string())));
    }
    let mut related = MultiPart::related().singlepart(SinglePart::html(html.to_string()));
    for image in images {
        related = related.singlepart(inline_part(image)?);
    }
    Ok(MultiPart::alternative()
        .singlepart(plain)
        .multipart(related))
}

fn inline_part(image: &InlineImage) -> Result<SinglePart, MailError> {
    let content_type = ContentType::parse(&image.mime)
        .map_err(|error| MailError::Smtp(format!("invalid inline image content type: {error}")))?;
    Ok(Attachment::new_inline(image.content_id.clone()).body(image.data.clone(), content_type))
}

/// Sanitizes the outgoing body with the reception allow-list, keeping the
/// `data:` images the composer pasted: that allow-list drops every `img`, so
/// each inline image is set aside behind a text placeholder, then restored as
/// canonical markup once the rest is clean. `None` when nothing readable is
/// left.
pub fn sanitize_outgoing_html(html: &str) -> Option<String> {
    let mut markup = String::with_capacity(html.len());
    let mut images: Vec<String> = Vec::new();
    let mut cursor = 0;
    for image in body_images(html) {
        markup.push_str(&html[cursor..image.tag.start]);
        markup.push_str(&image_placeholder(images.len()));
        images.push(format!(
            "<img src=\"{}\"{}>",
            &html[image.src.clone()],
            image
                .alt
                .map(|alt| format!(" alt=\"{}\"", escape_attribute(&alt)))
                .unwrap_or_default()
        ));
        cursor = image.tag.end;
    }
    markup.push_str(&html[cursor..]);
    let cleaned = crate::mime::sanitize_html(&markup)?;
    Some(
        images
            .iter()
            .enumerate()
            .fold(cleaned, |html, (index, markup)| {
                html.replace(&image_placeholder(index), markup)
            }),
    )
}

/// Turns the `data:` images of the body into MIME parts: every `src` becomes
/// `cid:<Content-ID>`. A type outside `INLINE_IMAGE_TYPES` or an undecodable
/// payload stays as it is; an image over `MAX_INLINE_IMAGE_BYTES` is dropped
/// from the body, tag and all.
fn lift_inline_images(html: &str) -> (String, Vec<InlineImage>) {
    let mut out = String::with_capacity(html.len());
    let mut images = Vec::new();
    let mut cursor = 0;
    for image in body_images(html) {
        match decode_data_url(&html[image.src.clone()]) {
            Decoded::Image(mime, data) => {
                let content_id = content_id();
                out.push_str(&html[cursor..image.src.start]);
                out.push_str(&format!("cid:{content_id}"));
                cursor = image.src.end;
                images.push(InlineImage {
                    content_id,
                    mime,
                    data,
                });
            }
            Decoded::TooLarge => {
                tracing::warn!(
                    limit = MAX_INLINE_IMAGE_BYTES,
                    "image en ligne retirée du corps : plafond dépassé"
                );
                out.push_str(&html[cursor..image.tag.start]);
                cursor = image.tag.end;
            }
            Decoded::Ignored => {}
        }
    }
    out.push_str(&html[cursor..]);
    (out, images)
}

fn attachment_part(attachment: &OutgoingAttachment) -> Result<SinglePart, MailError> {
    let content_type = ContentType::parse(&attachment.mime)
        .map_err(|error| MailError::Smtp(format!("invalid attachment content type: {error}")))?;
    Ok(Attachment::new(attachment.filename.clone()).body(attachment.data.clone(), content_type))
}

/// The `<img src="data:…">` tags of a body, in document order. Only the `src`
/// values `data_url_parts` accepts are returned: a remote image is not an
/// inline one and belongs to neither pass.
fn body_images(html: &str) -> Vec<BodyImage> {
    let lower = html.to_ascii_lowercase();
    image_tags(html)
        .into_iter()
        .filter_map(|image| {
            let src = image.src?;
            data_url_parts(&html[src.clone()])?;
            let alt = attribute_span(&lower, image.tag.start, image.tag.end, "alt")
                .map(|alt| html[alt].to_string());
            Some(BodyImage {
                tag: image.tag,
                src,
                alt,
            })
        })
        .collect()
}

enum Decoded {
    Image(String, Vec<u8>),
    TooLarge,
    Ignored,
}

fn decode_data_url(src: &str) -> Decoded {
    let Some((mime, payload)) = data_url_parts(src) else {
        return Decoded::Ignored;
    };
    let encoded: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if encoded.len() > (MAX_INLINE_IMAGE_BYTES * 4).div_ceil(3) {
        return Decoded::TooLarge;
    }
    let Ok(data) = STANDARD.decode(encoded) else {
        return Decoded::Ignored;
    };
    if data.len() > MAX_INLINE_IMAGE_BYTES {
        return Decoded::TooLarge;
    }
    Decoded::Image(mime, data)
}

/// A fresh `Content-ID` per inline image: unique across messages and across the
/// images of one message, so no reader can mix two of them up.
fn content_id() -> String {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{hex}@lavande")
}

fn image_placeholder(index: usize) -> String {
    format!("lavande-inline-image-{index}-lavande")
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn mailbox(address: &Address) -> Result<Mailbox, MailError> {
    let email = address
        .email
        .parse()
        .map_err(|error| MailError::Smtp(format!("invalid email address: {error}")))?;
    let name = address.name.clone().filter(|name| !name.is_empty());
    Ok(Mailbox::new(name, email))
}
