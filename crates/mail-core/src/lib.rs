//! Mail core for Lavande: data model, MIME parsing, threading, local store and
//! the IMAP/SMTP transport layer.

pub mod config;
pub mod error;
pub mod imap;
pub mod mime;
pub mod model;
pub mod oauth;
pub mod smtp;
pub mod store;
pub mod sync;
pub mod threading;
pub mod tls;

pub use config::{AccountConfig, AuthConfig, Encryption, Endpoint, FolderMapping};
pub use error::MailError;
pub use imap::SyncReport;
pub use mime::{parse_message, ParsedMessage};
pub use model::{
    thread_key, Address, AttachmentMeta, Flags, Folder, FolderRole, Message, PgpState, Thread,
};
pub use oauth::{xoauth2_payload, OAuth2Provider, XOAuth2Authenticator};
pub use smtp::{OutgoingAttachment, OutgoingMessage};
pub use store::Store;
pub use threading::thread_id;
pub use tls::TlsOptions;
