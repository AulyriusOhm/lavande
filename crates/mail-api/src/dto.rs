//! JSON payloads. No output type ever carries a secret.

use axum::extract::{FromRequest, Request};
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use lavande_mail::config::{AccountConfig, Encryption, Endpoint};
use lavande_mail::imap::SyncReport;
use lavande_mail::model::Address;
use lavande_mail::smtp::{OutgoingAttachment, OutgoingMessage};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::ApiError;

/// `Json` with the API error envelope and a 400 instead of axum's 415/422.
pub struct ApiJson<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::bad_request(
                "config",
                format!("corps de la requête refusé : {rejection}"),
            )),
        }
    }
}

#[derive(Serialize)]
pub struct Health {
    pub status: &'static str,
    pub version: &'static str,
    /// URL publique du service : c'est elle que les fournisseurs OAuth2 rappellent.
    pub public_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum AuthKind {
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "oauth2")]
    OAuth2,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Ispdb,
    Autoconfig,
    WellKnown,
    Guess,
}

#[derive(Serialize)]
pub struct SuggestedEndpoint {
    pub host: String,
    pub port: u16,
    pub encryption: Encryption,
    pub username: String,
}

/// `found: false` is a normal answer: no error envelope, just the reason.
#[derive(Serialize)]
pub struct DiscoverResponse {
    pub found: bool,
    pub source: Option<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incoming: Option<SuggestedEndpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outgoing: Option<SuggestedEndpoint>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub auth: Vec<AuthKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl DiscoverResponse {
    pub fn missing(reason: impl Into<String>) -> Self {
        Self {
            found: false,
            source: None,
            url: None,
            provider: None,
            display_name: None,
            incoming: None,
            outgoing: None,
            auth: Vec::new(),
            reason: Some(reason.into()),
        }
    }
}

#[derive(Serialize)]
pub struct EndpointSummary {
    pub host: String,
    pub port: u16,
    pub encryption: Encryption,
}

impl EndpointSummary {
    fn new(endpoint: &Endpoint) -> Self {
        Self {
            host: endpoint.host.clone(),
            port: endpoint.port,
            encryption: endpoint.encryption,
        }
    }
}

#[derive(Serialize)]
pub struct AccountSummary {
    pub id: String,
    pub label: String,
    pub email: String,
    pub username: String,
    pub imap: EndpointSummary,
    pub smtp: EndpointSummary,
    pub folders: usize,
}

impl AccountSummary {
    pub fn new(config: &AccountConfig, folders: usize) -> Self {
        Self {
            id: config.id.clone(),
            label: config.label.clone(),
            email: config.email.clone(),
            username: config.username.clone(),
            imap: EndpointSummary::new(&config.imap),
            smtp: EndpointSummary::new(&config.smtp),
            folders,
        }
    }
}

#[derive(Default, Deserialize)]
pub struct SyncRequest {
    #[serde(default)]
    pub folder_path: Option<String>,
}

#[derive(Serialize)]
pub struct SyncResponse {
    pub reports: Vec<FolderReport>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FolderReport {
    pub folder_path: String,
    pub inserted: usize,
    pub flags_updated: usize,
    pub removed: usize,
    pub uidvalidity_changed: bool,
    pub uidnext: u32,
}

impl FolderReport {
    pub fn new(folder_path: impl Into<String>, report: SyncReport) -> Self {
        Self {
            folder_path: folder_path.into(),
            inserted: report.inserted,
            flags_updated: report.flags_updated,
            removed: report.removed,
            uidvalidity_changed: report.uidvalidity_changed,
            uidnext: report.uidnext,
        }
    }
}

#[derive(Deserialize)]
pub struct FlagsRequest {
    pub folder_path: String,
    pub uid: u32,
    pub unread: bool,
    pub starred: bool,
}

#[derive(Deserialize)]
pub struct MoveRequest {
    pub from_path: String,
    pub uid: u32,
    pub to_path: String,
}

#[derive(Deserialize)]
pub struct DeleteRequest {
    pub folder_path: String,
    pub uid: u32,
}

#[derive(Deserialize)]
pub struct PurgeRequest {
    pub folder_path: String,
}

#[derive(Serialize)]
pub struct PurgeResponse {
    pub removed: usize,
}

#[derive(Deserialize)]
pub struct SendRequest {
    #[serde(default)]
    pub to: Vec<AddressDto>,
    #[serde(default)]
    pub cc: Vec<AddressDto>,
    #[serde(default)]
    pub bcc: Vec<AddressDto>,
    pub subject: String,
    pub text: String,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<AttachmentDto>,
}

#[derive(Deserialize)]
pub struct AddressDto {
    #[serde(default)]
    pub name: Option<String>,
    pub email: String,
}

impl AddressDto {
    fn into_address(self) -> Result<Address, ApiError> {
        let email = self.email.trim().to_string();
        if !email.contains('@') || email.contains(char::is_whitespace) {
            return Err(ApiError::bad_request(
                "config",
                format!("adresse invalide : « {} »", self.email),
            ));
        }
        Ok(Address {
            name: self.name,
            email,
        })
    }
}

#[derive(Deserialize)]
pub struct AttachmentDto {
    pub filename: String,
    pub mime: String,
    pub data_base64: String,
}

impl SendRequest {
    /// The sender is the account's own address; the crate stamps the
    /// `Message-ID`.
    pub fn into_outgoing(self, from: Address) -> Result<OutgoingMessage, ApiError> {
        if self.to.is_empty() && self.cc.is_empty() && self.bcc.is_empty() {
            return Err(ApiError::bad_request("config", "aucun destinataire"));
        }
        let mut attachments = Vec::with_capacity(self.attachments.len());
        for attachment in self.attachments {
            let data = STANDARD.decode(&attachment.data_base64).map_err(|error| {
                ApiError::bad_request(
                    "mime",
                    format!(
                        "pièce jointe « {} » illisible : {error}",
                        attachment.filename
                    ),
                )
            })?;
            attachments.push(OutgoingAttachment {
                filename: attachment.filename,
                mime: attachment.mime,
                data,
            });
        }
        Ok(OutgoingMessage {
            from,
            to: addresses(self.to)?,
            cc: addresses(self.cc)?,
            bcc: addresses(self.bcc)?,
            subject: self.subject,
            text: self.text,
            html: self.html,
            in_reply_to: self.in_reply_to,
            references: self.references,
            attachments,
        })
    }
}

fn addresses(dtos: Vec<AddressDto>) -> Result<Vec<Address>, ApiError> {
    dtos.into_iter()
        .map(AddressDto::into_address)
        .collect::<Result<Vec<_>, ApiError>>()
}
