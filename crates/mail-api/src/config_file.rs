//! `accounts.json`: the source of truth for the accounts, **without secrets**.
//! Mode 0600, written atomically, never returned as is by the API.
//!
//! `StoredAuth` still accepts the legacy format (inline secrets) so existing
//! files can be migrated: `take_secrets` extracts them, and saving always
//! writes the stripped form.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use lavande_mail::config::{AccountConfig, AuthConfig, Endpoint};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::private_file;
use crate::secrets::AccountSecrets;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredAccount {
    pub id: String,
    pub label: String,
    pub email: String,
    pub username: String,
    pub imap: Endpoint,
    pub smtp: Endpoint,
    pub auth: StoredAuth,
    /// `None` keeps the default (every folder with a known role), `Some([])`
    /// syncs no folder automatically, `Some(paths)` only those folders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_folders: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoredAuth {
    Password {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        password: Option<String>,
    },
    OAuth2 {
        client_id: String,
        token_endpoint: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refresh_token: Option<String>,
    },
}

impl StoredAccount {
    pub fn from_config(config: &AccountConfig) -> Self {
        let auth = match &config.auth {
            AuthConfig::Password { password } => StoredAuth::Password {
                password: Some(password.clone()),
            },
            AuthConfig::OAuth2 {
                client_id,
                client_secret,
                refresh_token,
                token_endpoint,
            } => StoredAuth::OAuth2 {
                client_id: client_id.clone(),
                token_endpoint: token_endpoint.clone(),
                client_secret: Some(client_secret.clone()),
                refresh_token: Some(refresh_token.clone()),
            },
        };
        Self {
            id: config.id.clone(),
            label: config.label.clone(),
            email: config.email.clone(),
            username: config.username.clone(),
            imap: config.imap.clone(),
            smtp: config.smtp.clone(),
            auth,
            synced_folders: None,
        }
    }

    /// Extracts legacy inline secrets, leaving the account ready to save.
    pub fn take_secrets(&mut self) -> Option<AccountSecrets> {
        match &mut self.auth {
            StoredAuth::Password { password } => password
                .take()
                .map(|password| AccountSecrets::Password { password }),
            StoredAuth::OAuth2 {
                client_secret,
                refresh_token,
                ..
            } => refresh_token
                .take()
                .map(|refresh_token| AccountSecrets::OAuth2 {
                    client_secret: client_secret.take().unwrap_or_default(),
                    refresh_token,
                }),
        }
    }

    pub fn into_config(self, secrets: Option<AccountSecrets>) -> Result<AccountConfig, ApiError> {
        let missing = || {
            ApiError::internal(
                "config",
                format!(
                    "secret du compte « {} » absent du stockage : reconnectez le compte",
                    self.id
                ),
            )
        };
        let auth = match (self.auth, secrets) {
            (StoredAuth::Password { .. }, Some(AccountSecrets::Password { password })) => {
                AuthConfig::Password { password }
            }
            (
                StoredAuth::OAuth2 {
                    client_id,
                    token_endpoint,
                    ..
                },
                Some(AccountSecrets::OAuth2 {
                    client_secret,
                    refresh_token,
                }),
            ) => AuthConfig::OAuth2 {
                client_id,
                client_secret,
                refresh_token,
                token_endpoint,
            },
            (StoredAuth::Password { .. }, None) | (StoredAuth::OAuth2 { .. }, None) => {
                return Err(missing())
            }
            _ => {
                return Err(ApiError::internal(
                    "config",
                    format!(
                        "secret du compte « {} » incompatible avec son authentification",
                        self.id
                    ),
                ))
            }
        };
        Ok(AccountConfig {
            id: self.id,
            label: self.label,
            email: self.email,
            username: self.username,
            imap: self.imap,
            smtp: self.smtp,
            auth,
        })
    }
}

pub fn load(path: &Path) -> Result<Vec<StoredAccount>, ApiError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            ApiError::internal(
                "config",
                format!("{} est illisible : {error}", path.display()),
            )
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(ApiError::internal(
            "config",
            format!("lecture de {} : {error}", path.display()),
        )),
    }
}

pub fn save(path: &Path, accounts: &[StoredAccount]) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(accounts).map_err(|error| {
        ApiError::internal("config", format!("sérialisation des comptes : {error}"))
    })?;
    private_file::write_private(path, &bytes)
}
