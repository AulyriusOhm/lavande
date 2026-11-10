//! SMTP submission through `lettre`, with the same TLS roots as IMAP.

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{Certificate, CertificateStore, Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::{AccountConfig, AuthConfig, Encryption, Endpoint};
use crate::error::MailError;
use crate::model::Address;
use crate::oauth::OAuth2Provider;
use crate::tls::TlsOptions;

pub struct OutgoingAttachment {
    pub filename: String,
    pub mime: String,
    pub data: Vec<u8>,
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
    if message.to.is_empty() && message.cc.is_empty() && message.bcc.is_empty() {
        return Err(MailError::Smtp("no recipient".to_string()));
    }

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

    let email = build(message)?;
    builder
        .build()
        .send(email)
        .await
        .map_err(|error| MailError::Smtp(error.to_string()))?;
    Ok(())
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

fn build(message: &OutgoingMessage) -> Result<Message, MailError> {
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

    let email = match (message.html.as_deref(), message.attachments.is_empty()) {
        (None, true) => builder.body(message.text.clone()),
        (Some(html), true) => builder.multipart(MultiPart::alternative_plain_html(
            message.text.clone(),
            html.to_string(),
        )),
        (html, false) => {
            let body = match html {
                Some(html) => {
                    MultiPart::alternative_plain_html(message.text.clone(), html.to_string())
                }
                None => MultiPart::mixed().singlepart(SinglePart::plain(message.text.clone())),
            };
            let mut parts = MultiPart::mixed().multipart(body);
            for attachment in &message.attachments {
                parts = parts.singlepart(attachment_part(attachment)?);
            }
            builder.multipart(parts)
        }
    };
    email.map_err(|error| MailError::Smtp(error.to_string()))
}

fn attachment_part(attachment: &OutgoingAttachment) -> Result<SinglePart, MailError> {
    let content_type = ContentType::parse(&attachment.mime)
        .map_err(|error| MailError::Smtp(format!("invalid attachment content type: {error}")))?;
    Ok(Attachment::new(attachment.filename.clone()).body(attachment.data.clone(), content_type))
}

fn mailbox(address: &Address) -> Result<Mailbox, MailError> {
    let email = address
        .email
        .parse()
        .map_err(|error| MailError::Smtp(format!("invalid email address: {error}")))?;
    let name = address.name.clone().filter(|name| !name.is_empty());
    Ok(Mailbox::new(name, email))
}
