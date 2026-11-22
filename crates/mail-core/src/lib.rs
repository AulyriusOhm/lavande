//! Mail core for Lavande: data model, MIME parsing, calendar import (iCalendar
//! and CalDAV), threading, local store and the IMAP/SMTP transport layer.

pub mod caldav;
pub mod carddav;
pub mod config;
pub mod error;
pub mod gcal;
pub mod ics;
pub mod imap;
pub mod itip;

pub mod mime;
pub mod model;
pub mod oauth;
pub mod pgp;
pub mod smtp;
pub mod soap;
pub mod store;
pub mod sync;
pub mod threading;
pub mod tls;
pub mod totp;
pub mod utf7;

pub use caldav::{CaldavClient, CalendarCollection};
pub use carddav::{CarddavClient, Contact as DirectoryContact};
pub use config::{AccountConfig, AuthConfig, Encryption, Endpoint, FolderMapping};
pub use error::MailError;
pub use gcal::{GcalClient, GoogleCalendar};
pub use ics::{parse_events, ExternalEvent};
pub use imap::SyncReport;
pub use itip::{Guest, Invitation, Party};
pub use mime::{
    parse_message, parse_message_with_keys, sanitize_html, sanitize_html_with_images,
    ParsedMessage, HTML_POLICY_MARKER,
};
pub use model::{
    thread_key, Address, AttachmentMeta, Flags, Folder, FolderRole, Message, PgpState, Thread,
};
pub use oauth::{xoauth2_payload, OAuth2Provider, XOAuth2Authenticator};
pub use pgp::{PgpDetail, PgpKey, PgpKeyInfo, PgpKeyring};
pub use smtp::{OutgoingAttachment, OutgoingMessage};
pub use soap::{AccountInfo, AuthToken, SoapClient};
pub use store::{MailDecision, Store};
pub use threading::thread_id;
pub use tls::TlsOptions;
pub use totp::{extract_totp, TotpMatch};
