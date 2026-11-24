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
    /// `None` keeps the default (every folder the server announced),
    /// `Some([])` syncs no folder automatically, `Some(paths)` only those
    /// folders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_folders: Option<Vec<String>>,
    /// Folders whose mail feeds the AI analysis: `None` keeps the default
    /// (reception: INBOX and personal folders), `Some([])` analyses none of
    /// them automatically, `Some(paths)` only those folders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_folders: Option<Vec<String>>,
    /// `true` when the provider revoked the authorization: the account keeps its
    /// history, but only a fresh consent makes it usable again. Defaulted so the
    /// files written before this flag existed still load.
    #[serde(default)]
    pub needs_reauth: bool,
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
            synced_folders: config.synced_folders.clone(),
            ai_folders: config.ai_folders.clone(),
            needs_reauth: false,
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
            synced_folders: self.synced_folders,
            ai_folders: self.ai_folders,
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

#[cfg(test)]
mod tests {
    use super::*;
    use lavande_mail::config::Encryption;

    fn config() -> AccountConfig {
        AccountConfig {
            id: "perso".to_string(),
            label: "Perso".to_string(),
            email: "roman@lavande.fr".to_string(),
            username: "roman@lavande.fr".to_string(),
            imap: Endpoint {
                host: "imap.lavande.fr".to_string(),
                port: 993,
                encryption: Encryption::Tls,
            },
            smtp: Endpoint {
                host: "smtp.lavande.fr".to_string(),
                port: 465,
                encryption: Encryption::Tls,
            },
            auth: AuthConfig::Password {
                password: "hunter2".to_string(),
            },
            synced_folders: None,
            ai_folders: None,
        }
    }

    /// Un `accounts.json` écrit avant le drapeau de reconnexion doit se relire
    /// tel quel : sinon chaque compte existant disparaîtrait à la mise à jour.
    #[test]
    fn an_account_file_without_the_flag_still_loads() {
        let legacy = serde_json::json!({
            "id": "perso",
            "label": "Perso",
            "email": "roman@lavande.fr",
            "username": "roman@lavande.fr",
            "imap": { "host": "imap.lavande.fr", "port": 993, "encryption": "tls" },
            "smtp": { "host": "smtp.lavande.fr", "port": 465, "encryption": "tls" },
            "auth": { "kind": "password" }
        });
        let stored: StoredAccount = serde_json::from_value(legacy).expect("compte");
        assert!(!stored.needs_reauth);
    }

    #[test]
    fn a_selection_asked_at_creation_is_stored_with_the_account() {
        let mut asked = config();
        asked.synced_folders = Some(vec!["Archive".to_string()]);
        let stored = StoredAccount::from_config(&asked);
        assert_eq!(stored.synced_folders, Some(vec!["Archive".to_string()]));
    }

    #[test]
    fn an_account_asking_for_no_selection_keeps_the_default() {
        let stored = StoredAccount::from_config(&config());
        assert_eq!(stored.synced_folders, None);
    }

    #[test]
    fn the_stored_selection_comes_back_with_the_config() {
        let mut stored = StoredAccount::from_config(&config());
        stored.synced_folders = Some(vec!["Archive".to_string()]);
        let secrets = stored.take_secrets();
        let config = stored.into_config(secrets).expect("config");
        assert_eq!(config.synced_folders, Some(vec!["Archive".to_string()]));
        assert_eq!(config.id, "perso");
    }

    #[test]
    fn the_ai_selection_is_stored_and_read_back_with_the_account() {
        let mut asked = config();
        asked.ai_folders = Some(vec!["INBOX".to_string(), "INBOX/Informatique".to_string()]);
        let mut stored = StoredAccount::from_config(&asked);
        assert_eq!(
            stored.ai_folders,
            Some(vec!["INBOX".to_string(), "INBOX/Informatique".to_string()])
        );
        assert_eq!(stored.synced_folders, None, "les deux choix sont distincts");

        let secrets = stored.take_secrets();
        let read_back = stored.into_config(secrets).expect("config");
        assert_eq!(read_back.ai_folders, asked.ai_folders);
    }

    #[test]
    fn an_account_without_an_ai_selection_reads_as_the_default() {
        let stored = StoredAccount::from_config(&config());
        assert_eq!(stored.ai_folders, None);
    }
}
