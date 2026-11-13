//! Error envelope of the API: `{ "error": "…", "kind": "…" }`, with the status
//! the front expects for each `MailError` variant.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use lavande_mail::error::MailError;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    kind: &'static str,
    message: String,
    transient: bool,
}

impl ApiError {
    pub fn new(status: StatusCode, kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            kind,
            message: message.into(),
            transient: false,
        }
    }

    pub fn bad_request(kind: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, kind, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "store", message)
    }

    pub fn conflict(kind: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, kind, message)
    }

    pub fn gateway(kind: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, kind, message)
    }

    /// Panne réseau côté transport : rien ne dit que la demande est refusée,
    /// elle peut réussir si on la rejoue.
    pub fn transport(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            kind,
            message: message.into(),
            transient: true,
        }
    }

    pub fn internal(kind: &'static str, message: impl Into<String>) -> Self {
        let error = Self::new(StatusCode::INTERNAL_SERVER_ERROR, kind, message);
        tracing::error!(kind = error.kind, message = %error.message, "erreur interne");
        error
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn kind(&self) -> &'static str {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn is_transient(&self) -> bool {
        self.transient
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::internal("store", format!("accès disque : {error}"))
    }
}

impl From<MailError> for ApiError {
    fn from(error: MailError) -> Self {
        let (status, kind) = match &error {
            MailError::Config(_) => (StatusCode::BAD_REQUEST, "config"),
            MailError::Calendar(_) => (StatusCode::BAD_REQUEST, "calendar"),
            MailError::Caldav(_) => (StatusCode::BAD_GATEWAY, "caldav"),
            MailError::Conflict(_) => (StatusCode::CONFLICT, "caldav"),
            MailError::Gcal(_) => (StatusCode::BAD_GATEWAY, "gcal"),
            MailError::Auth(_) => (StatusCode::UNAUTHORIZED, "auth"),
            MailError::InvalidData(_) => (StatusCode::NOT_FOUND, "store"),
            MailError::Imap(_) => (StatusCode::BAD_GATEWAY, "imap"),
            MailError::Smtp(_) => (StatusCode::BAD_GATEWAY, "smtp"),
            MailError::Tls(_) => (StatusCode::BAD_GATEWAY, "tls"),
            MailError::OAuth(_) => (StatusCode::BAD_GATEWAY, "oauth"),
            MailError::Mime(_) => (StatusCode::INTERNAL_SERVER_ERROR, "mime"),
            MailError::Store(_) | MailError::Lock(_) | MailError::Io(_) | MailError::Json(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "store")
            }
        };
        if status.is_server_error() {
            tracing::error!(error = %error, kind, "requête refusée");
        } else {
            tracing::debug!(error = %error, kind, "requête refusée");
        }
        Self {
            status,
            kind,
            message: label(&error),
            transient: false,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "error": self.message, "kind": self.kind }));
        (self.status, body).into_response()
    }
}

fn label(error: &MailError) -> String {
    match error {
        MailError::Config(message) => format!("configuration invalide : {message}"),
        MailError::Calendar(message) => format!("calendrier illisible : {message}"),
        MailError::Caldav(message) => format!("serveur de calendriers : {message}"),
        MailError::Conflict(message) => format!("conflit : {message}"),
        MailError::Gcal(message) => format!("Google Calendar : {message}"),
        MailError::Auth(message) => format!("authentification refusée : {message}"),
        MailError::InvalidData(message) => format!("donnée introuvable : {message}"),
        MailError::Imap(message) => format!("serveur IMAP : {message}"),
        MailError::Smtp(message) => format!("serveur SMTP : {message}"),
        MailError::Tls(message) => format!("connexion chiffrée : {message}"),
        MailError::OAuth(message) => format!("autorisation OAuth : {message}"),
        MailError::Mime(message) => format!("message illisible : {message}"),
        MailError::Store(message) => format!("base locale : {message}"),
        MailError::Lock(message) => format!("base locale : {message}"),
        MailError::Io(message) => format!("accès disque : {message}"),
        MailError::Json(message) => format!("JSON : {message}"),
    }
}
