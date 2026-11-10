//! Account endpoints, credentials and folder mapping.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::MailError;
use crate::model::FolderRole;
use crate::threading::fold_accents;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encryption {
    Tls,
    StartTls,
    Plain,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub encryption: Encryption,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthConfig {
    Password {
        password: String,
    },
    OAuth2 {
        client_id: String,
        client_secret: String,
        refresh_token: String,
        token_endpoint: String,
    },
}

impl fmt::Debug for AuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthConfig::Password { .. } => f.write_str("Password { password: \"<redacted>\" }"),
            AuthConfig::OAuth2 {
                client_id,
                token_endpoint,
                ..
            } => f
                .debug_struct("OAuth2")
                .field("client_id", client_id)
                .field("client_secret", &"<redacted>")
                .field("refresh_token", &"<redacted>")
                .field("token_endpoint", token_endpoint)
                .finish(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountConfig {
    pub id: String,
    pub label: String,
    pub email: String,
    pub username: String,
    pub imap: Endpoint,
    pub smtp: Endpoint,
    pub auth: AuthConfig,
}

impl AccountConfig {
    /// Rejects configurations that cannot work: empty fields and any plaintext
    /// endpoint, since every supported authentication carries a secret.
    pub fn validate(&self) -> Result<(), MailError> {
        for (field, value) in [
            ("id", &self.id),
            ("label", &self.label),
            ("email", &self.email),
            ("username", &self.username),
        ] {
            if value.trim().is_empty() {
                return Err(MailError::Config(format!("account {field} is empty")));
            }
        }
        validate_endpoint(&self.imap, "imap")?;
        validate_endpoint(&self.smtp, "smtp")?;
        validate_auth(&self.auth)
    }
}

fn validate_endpoint(endpoint: &Endpoint, kind: &str) -> Result<(), MailError> {
    if endpoint.host.trim().is_empty() {
        return Err(MailError::Config(format!("{kind} host is empty")));
    }
    if endpoint.port == 0 {
        return Err(MailError::Config(format!("{kind} port is empty")));
    }
    if endpoint.encryption == Encryption::Plain {
        return Err(MailError::Config(format!(
            "{kind} plaintext connection is forbidden with stored credentials"
        )));
    }
    Ok(())
}

fn validate_auth(auth: &AuthConfig) -> Result<(), MailError> {
    match auth {
        AuthConfig::Password { password } if password.is_empty() => {
            Err(MailError::Config("password is empty".to_string()))
        }
        AuthConfig::OAuth2 {
            client_id,
            refresh_token,
            ..
        } if client_id.is_empty() || refresh_token.is_empty() => Err(MailError::Config(
            "oauth2 client id and refresh token are required".to_string(),
        )),
        _ => Ok(()),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderMapping {
    pub inbox: Option<String>,
    pub sent: Option<String>,
    pub drafts: Option<String>,
    pub archive: Option<String>,
    pub trash: Option<String>,
    pub spam: Option<String>,
}

/// Role of a folder: SPECIAL-USE attributes first, then the folder name and
/// path in English or French.
pub fn folder_role(path: &str, name: &str, flags: &[String]) -> FolderRole {
    if let Some(role) = flags.iter().find_map(|flag| role_of_flag(flag)) {
        return role;
    }
    [name, path, leaf_name(path)]
        .into_iter()
        .find_map(role_of_label)
        .unwrap_or(FolderRole::Other)
}

/// Path mapped to a role, if the account configures one.
pub fn path_for(mapping: &FolderMapping, role: FolderRole) -> Option<&str> {
    let path = match role {
        FolderRole::Inbox => &mapping.inbox,
        FolderRole::Sent => &mapping.sent,
        FolderRole::Drafts => &mapping.drafts,
        FolderRole::Archive => &mapping.archive,
        FolderRole::Trash => &mapping.trash,
        FolderRole::Spam => &mapping.spam,
        FolderRole::Other => return None,
    };
    path.as_deref()
}

/// Last component of a hierarchy path, whatever the server delimiter.
pub fn leaf_name(path: &str) -> &str {
    path.rsplit(['/', '.']).next().unwrap_or(path)
}

fn role_of_flag(flag: &str) -> Option<FolderRole> {
    Some(
        match flag.trim().trim_start_matches('\\').to_lowercase().as_str() {
            "inbox" => FolderRole::Inbox,
            "sent" => FolderRole::Sent,
            "drafts" => FolderRole::Drafts,
            "archive" => FolderRole::Archive,
            "trash" => FolderRole::Trash,
            "junk" => FolderRole::Spam,
            _ => return None,
        },
    )
}

fn role_of_label(label: &str) -> Option<FolderRole> {
    let normalized = fold_accents(label.trim()).to_lowercase();
    Some(match normalized.trim() {
        "inbox" | "boite de reception" | "boite aux lettres" => FolderRole::Inbox,
        "sent" | "sent items" | "sent messages" | "sent mail" | "envoyes" | "elements envoyes" => {
            FolderRole::Sent
        }
        "drafts" | "brouillons" => FolderRole::Drafts,
        "archive" | "archives" => FolderRole::Archive,
        "trash" | "deleted" | "deleted items" | "deleted messages" | "corbeille" => {
            FolderRole::Trash
        }
        "spam" | "junk" | "junk e-mail" | "bulk mail" | "indesirables" | "courrier indesirable" => {
            FolderRole::Spam
        }
        _ => return None,
    })
}
