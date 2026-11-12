use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MailError {
    #[error("store error: {0}")]
    Store(#[from] rusqlite::Error),
    #[error("store lock error: {0}")]
    Lock(String),
    #[error("mime error: {0}")]
    Mime(String),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid data: {0}")]
    InvalidData(String),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("config error: {0}")]
    Config(String),
    #[error("calendar error: {0}")]
    Calendar(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("imap error: {0}")]
    Imap(String),
    #[error("smtp error: {0}")]
    Smtp(String),
    #[error("oauth error: {0}")]
    OAuth(String),
    #[error("tls error: {0}")]
    Tls(String),
}
