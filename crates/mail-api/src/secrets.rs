//! Secrets des comptes (mots de passe, jetons OAuth2) : jamais dans
//! `accounts.json`.
//!
//! - Desktop Linux : trousseau système (Secret Service via D-Bus), une entrée
//!   par compte.
//! - Repli (Android, headless, trousseau injoignable) : `secrets.enc`, chiffré
//!   XChaCha20-Poly1305 avec une clé aléatoire `secrets.key` (0600). Sur
//!   Android, l'ensemble reste dans le stockage privé de l'application.
//!
//! Le choix est journalisé au démarrage ; `LAVANDE_MAIL_SECRETS=keychain|file`
//! le force (`keychain` échoue si le trousseau est injoignable).

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::private_file;

pub const KEY_FILE: &str = "secrets.key";
pub const SECRETS_FILE: &str = "secrets.enc";

const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AccountSecrets {
    Password {
        password: String,
    },
    OAuth2 {
        client_secret: String,
        refresh_token: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretBackend {
    Auto,
    File,
    Keychain,
}

impl SecretBackend {
    pub fn from_env() -> Result<Self, ApiError> {
        match std::env::var("LAVANDE_MAIL_SECRETS") {
            Ok(value) if value == "file" => Ok(Self::File),
            Ok(value) if value == "keychain" => Ok(Self::Keychain),
            Ok(value) if value.trim().is_empty() => Ok(Self::Auto),
            Ok(value) => Err(ApiError::bad_request(
                "config",
                format!("LAVANDE_MAIL_SECRETS « {value} » inconnu (attendu : keychain ou file)"),
            )),
            Err(_) => Ok(Self::Auto),
        }
    }
}

#[derive(Clone)]
pub enum Secrets {
    File(FileSecrets),
    #[cfg(target_os = "linux")]
    Keychain,
}

impl Secrets {
    pub async fn open(backend: SecretBackend, data_dir: &Path) -> Result<Self, ApiError> {
        match backend {
            SecretBackend::File => Ok(Self::File(FileSecrets::open(data_dir)?)),
            SecretBackend::Keychain => {
                #[cfg(target_os = "linux")]
                {
                    keychain::probe().await?;
                    tracing::info!("secrets des comptes : trousseau système");
                    Ok(Self::Keychain)
                }
                #[cfg(not(target_os = "linux"))]
                Err(ApiError::internal(
                    "config",
                    "trousseau système indisponible sur cette plateforme",
                ))
            }
            SecretBackend::Auto => {
                #[cfg(target_os = "linux")]
                match keychain::probe().await {
                    Ok(()) => {
                        tracing::info!("secrets des comptes : trousseau système");
                        return Ok(Self::Keychain);
                    }
                    Err(error) => tracing::warn!(
                        error = %error,
                        "trousseau système injoignable, repli sur le fichier chiffré"
                    ),
                }
                tracing::info!(
                    file = %data_dir.join(SECRETS_FILE).display(),
                    "secrets des comptes : fichier chiffré"
                );
                Ok(Self::File(FileSecrets::open(data_dir)?))
            }
        }
    }

    pub async fn get(&self, account_id: &str) -> Result<Option<AccountSecrets>, ApiError> {
        match self {
            Self::File(file) => {
                let file = file.clone();
                let id = account_id.to_string();
                tokio::task::spawn_blocking(move || {
                    let mut secrets = file.load()?;
                    Ok(secrets.remove(&id))
                })
                .await
                .map_err(join_error)?
            }
            #[cfg(target_os = "linux")]
            Self::Keychain => keychain::get(account_id).await,
        }
    }

    pub async fn put(&self, account_id: &str, secrets: &AccountSecrets) -> Result<(), ApiError> {
        match self {
            Self::File(file) => {
                let file = file.clone();
                let id = account_id.to_string();
                let secrets = secrets.clone();
                tokio::task::spawn_blocking(move || {
                    let mut all = file.load()?;
                    all.insert(id, secrets);
                    file.store(&all)
                })
                .await
                .map_err(join_error)?
            }
            #[cfg(target_os = "linux")]
            Self::Keychain => keychain::put(account_id, secrets).await,
        }
    }

    pub async fn delete(&self, account_id: &str) -> Result<(), ApiError> {
        match self {
            Self::File(file) => {
                let file = file.clone();
                let id = account_id.to_string();
                tokio::task::spawn_blocking(move || {
                    let mut all = file.load()?;
                    if all.remove(&id).is_some() {
                        file.store(&all)?;
                    }
                    Ok(())
                })
                .await
                .map_err(join_error)?
            }
            #[cfg(target_os = "linux")]
            Self::Keychain => keychain::delete(account_id).await,
        }
    }
}

fn join_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::internal("config", format!("tâche de secrets interrompue : {error}"))
}

#[derive(Clone)]
pub struct FileSecrets {
    key_path: PathBuf,
    secrets_path: PathBuf,
}

impl FileSecrets {
    fn open(data_dir: &Path) -> Result<Self, ApiError> {
        let file = Self {
            key_path: data_dir.join(KEY_FILE),
            secrets_path: data_dir.join(SECRETS_FILE),
        };
        file.key()?;
        Ok(file)
    }

    fn key(&self) -> Result<[u8; KEY_LEN], ApiError> {
        match fs::read(&self.key_path) {
            Ok(bytes) if bytes.len() == KEY_LEN => {
                let mut key = [0u8; KEY_LEN];
                key.copy_from_slice(&bytes);
                Ok(key)
            }
            Ok(bytes) => Err(ApiError::internal(
                "config",
                format!(
                    "{} : longueur de clé invalide ({} octets, attendu {KEY_LEN})",
                    self.key_path.display(),
                    bytes.len()
                ),
            )),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let mut key = [0u8; KEY_LEN];
                rand::rngs::OsRng.fill_bytes(&mut key);
                private_file::write_private(&self.key_path, &key)?;
                Ok(key)
            }
            Err(error) => Err(ApiError::internal(
                "config",
                format!("lecture de {} : {error}", self.key_path.display()),
            )),
        }
    }

    fn load(&self) -> Result<BTreeMap<String, AccountSecrets>, ApiError> {
        let bytes = match fs::read(&self.secrets_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(error) => {
                return Err(ApiError::internal(
                    "config",
                    format!("lecture de {} : {error}", self.secrets_path.display()),
                ))
            }
        };
        if bytes.len() < NONCE_LEN {
            return Err(corrupt(&self.secrets_path));
        }
        let (nonce, ciphertext) = bytes.split_at(NONCE_LEN);
        let cipher = XChaCha20Poly1305::new((&self.key()?).into());
        let plaintext = cipher
            .decrypt(XNonce::from_slice(nonce), ciphertext)
            .map_err(|_| corrupt(&self.secrets_path))?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            ApiError::internal(
                "config",
                format!(
                    "{} : contenu illisible : {error}",
                    self.secrets_path.display()
                ),
            )
        })
    }

    fn store(&self, secrets: &BTreeMap<String, AccountSecrets>) -> Result<(), ApiError> {
        let plaintext = serde_json::to_vec(secrets).map_err(|error| {
            ApiError::internal("config", format!("sérialisation des secrets : {error}"))
        })?;
        let cipher = XChaCha20Poly1305::new((&self.key()?).into());
        let mut nonce = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(XNonce::from_slice(&nonce), plaintext.as_slice())
            .map_err(|error| {
                ApiError::internal("config", format!("chiffrement des secrets : {error}"))
            })?;
        let mut bytes = nonce.to_vec();
        bytes.extend(ciphertext);
        private_file::write_private(&self.secrets_path, &bytes)
    }
}

fn corrupt(path: &Path) -> ApiError {
    ApiError::internal(
        "config",
        format!(
            "{} est corrompu ou ne correspond pas à {} : restaurez une sauvegarde ou reconnectez les comptes",
            path.display(),
            KEY_FILE
        ),
    )
}

/// Trousseau système : une entrée `lavande-mail` par compte, contenu JSON.
/// L'API keyring est synchrone et bloque : toujours via `spawn_blocking`.
#[cfg(target_os = "linux")]
mod keychain {
    use super::*;

    const SERVICE: &str = "lavande-mail";

    /// Lecture non destructive d'une entrée inexistante : `NoEntry` prouve que
    /// le service répond ; toute autre erreur signifie trousseau injoignable.
    pub async fn probe() -> Result<(), ApiError> {
        get("__lavande_probe__").await.map(|_| ())
    }

    pub async fn get(account_id: &str) -> Result<Option<AccountSecrets>, ApiError> {
        let id = account_id.to_string();
        let raw = tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &id)?;
            match entry.get_password() {
                Ok(password) => Ok(Some(password)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(join_error)?
        .map_err(platform_error)?;
        match raw {
            None => Ok(None),
            Some(json) => serde_json::from_str(&json).map(Some).map_err(|error| {
                ApiError::internal(
                    "config",
                    format!(
                        "secret du compte « {account_id} » illisible dans le trousseau : {error}"
                    ),
                )
            }),
        }
    }

    pub async fn put(account_id: &str, secrets: &AccountSecrets) -> Result<(), ApiError> {
        let id = account_id.to_string();
        let json = serde_json::to_string(secrets).map_err(|error| {
            ApiError::internal("config", format!("sérialisation des secrets : {error}"))
        })?;
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &id)?;
            entry.set_password(&json)
        })
        .await
        .map_err(join_error)?
        .map_err(platform_error)
    }

    pub async fn delete(account_id: &str) -> Result<(), ApiError> {
        let id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &id)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(join_error)?
        .map_err(platform_error)
    }

    fn platform_error(error: keyring::Error) -> ApiError {
        ApiError::internal("config", format!("trousseau système : {error}"))
    }
}
