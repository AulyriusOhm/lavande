//! Mail core for Lavande: data model, MIME parsing, calendar import (iCalendar
//! and CalDAV), threading, local store and the IMAP/SMTP transport layer.

pub mod caldav;
pub mod config;
pub mod error;
pub mod gcal;
pub mod ics;
pub mod imap;

pub mod mime;
pub mod model;
pub mod oauth;
pub mod pgp;
pub mod smtp;
pub mod store;
pub mod sync;
pub mod threading;
pub mod tls;

pub use caldav::{CaldavClient, CalendarCollection};
pub use config::{AccountConfig, AuthConfig, Encryption, Endpoint, FolderMapping};
pub use error::MailError;
pub use gcal::{GcalClient, GoogleCalendar};
pub use ics::{parse_events, ExternalEvent};
pub use imap::SyncReport;
pub use mime::{
    parse_message, parse_message_with_keys, sanitize_html, sanitize_html_with_images, ParsedMessage,
};
pub use model::{
    thread_key, Address, AttachmentMeta, Flags, Folder, FolderRole, Message, PgpState, Thread,
};
pub use oauth::{xoauth2_payload, OAuth2Provider, XOAuth2Authenticator};
pub use pgp::{PgpDetail, PgpKey, PgpKeyInfo, PgpKeyring};
pub use smtp::{OutgoingAttachment, OutgoingMessage};
pub use store::Store;
pub use threading::thread_id;
pub use tls::TlsOptions;
