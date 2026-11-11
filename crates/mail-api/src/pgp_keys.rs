//! OpenPGP keyring of the daemon: the public keys live in `pgp-keys.json`
//! (`0600`, no secret material), the private keys in the secret store, one
//! entry per fingerprint (`pgp:<EMPREINTE>`).

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use lavande_mail::pgp::{self, PgpKey, PgpKeyInfo, PgpKeyring};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::private_file;
use crate::secrets::{AccountSecrets, Secrets};

pub const KEYRING_FILE: &str = "pgp-keys.json";
const SECRET_PREFIX: &str = "pgp:";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredKey {
    public: String,
    #[serde(default)]
    has_secret: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct KeyFile {
    #[serde(default)]
    keys: Vec<StoredKey>,
}

#[derive(Clone)]
pub struct PgpStore {
    path: PathBuf,
    secrets: Secrets,
}

impl PgpStore {
    pub fn open(data_dir: impl AsRef<Path>, secrets: Secrets) -> Self {
        Self {
            path: data_dir.as_ref().join(KEYRING_FILE),
            secrets,
        }
    }

    /// Public keys only: what listing and encryption need.
    pub fn public_keyring(&self) -> Result<PgpKeyring, ApiError> {
        let mut keyring = PgpKeyring::new();
        for key in self.load()?.keys {
            keyring.insert_armored(&key.public).map_err(key_error)?;
        }
        Ok(keyring)
    }

    /// Public and secret keys: signing, decryption and verification.
    pub async fn keyring(&self) -> Result<PgpKeyring, ApiError> {
        let mut keyring = PgpKeyring::new();
        for key in self.load()?.keys {
            if key.has_secret {
                if let Some(AccountSecrets::Pgp { secret_key }) = self
                    .secrets
                    .get(&secret_id(&fingerprint_of(&key.public)?))
                    .await?
                {
                    keyring.insert_armored(&secret_key).map_err(key_error)?;
                    continue;
                }
            }
            keyring.insert_armored(&key.public).map_err(key_error)?;
        }
        Ok(keyring)
    }

    /// Metadata of every key, with the secret flag as the keyring file stored
    /// it: the public key alone can never tell.
    pub fn keys(&self) -> Result<Vec<PgpKeyInfo>, ApiError> {
        let mut infos = Vec::new();
        for stored in self.load()?.keys {
            let mut info = PgpKey::parse(&stored.public).map_err(key_error)?.info();
            info.has_secret = stored.has_secret;
            infos.push(info);
        }
        infos.sort_by(|left, right| left.user_id.cmp(&right.user_id));
        Ok(infos)
    }

    /// Generates a key pair; the private half goes to the secret store and the
    /// public half to the keyring. Returns the metadata and the public key.
    pub async fn generate(
        &self,
        name: &str,
        email: &str,
    ) -> Result<(PgpKeyInfo, String), ApiError> {
        let email = email.trim();
        if !email.contains('@') || email.contains(char::is_whitespace) {
            return Err(ApiError::bad_request(
                "config",
                format!("adresse invalide : « {email} »"),
            ));
        }
        let key = pgp::generate_key(name, email).map_err(key_error)?;
        let public = key.public_armored().map_err(key_error)?;
        let secret = key
            .secret()
            .ok_or_else(|| ApiError::internal("config", "clé générée sans partie privée"))?
            .to_armored_string(Default::default())
            .map_err(armored_error)?;
        let info = self.store(&key, &public, &secret).await?;
        Ok((info, public))
    }

    pub async fn import(&self, armored: &str) -> Result<PgpKeyInfo, ApiError> {
        if armored.trim().is_empty() {
            return Err(ApiError::bad_request("config", "clé PGP vide"));
        }
        let key = PgpKey::parse(armored).map_err(key_error)?;
        let public = key.public_armored().map_err(key_error)?;
        let secret = key
            .secret()
            .map(|secret| {
                secret
                    .to_armored_string(Default::default())
                    .map_err(armored_error)
            })
            .transpose()?;
        self.store(&key, &public, secret.as_deref().unwrap_or_default())
            .await
    }

    /// The public half of one key, armored: never the private one.
    pub fn export(&self, fingerprint: &str) -> Result<String, ApiError> {
        self.public_keyring()?
            .find(fingerprint)
            .ok_or_else(|| unknown(fingerprint))?
            .public_armored()
            .map_err(key_error)
    }

    pub async fn delete(&self, fingerprint: &str) -> Result<(), ApiError> {
        let mut file = self.load()?;
        let index = file
            .keys
            .iter()
            .position(|key| {
                fingerprint_of(&key.public)
                    .is_ok_and(|known| known.eq_ignore_ascii_case(fingerprint))
            })
            .ok_or_else(|| unknown(fingerprint))?;
        let removed = file.keys.remove(index);
        self.save(&file)?;
        if removed.has_secret {
            self.secrets
                .delete(&secret_id(&fingerprint_of(&removed.public)?))
                .await?;
        }
        Ok(())
    }

    /// Writes the private half (when there is one) then the public entry.
    async fn store(
        &self,
        key: &PgpKey,
        public: &str,
        secret: &str,
    ) -> Result<PgpKeyInfo, ApiError> {
        let fingerprint = key.fingerprint();
        if !secret.is_empty() {
            self.secrets
                .put(
                    &secret_id(&fingerprint),
                    &AccountSecrets::Pgp {
                        secret_key: secret.to_string(),
                    },
                )
                .await?;
        }
        let mut file = self.load()?;
        let existing = file
            .keys
            .iter_mut()
            .find(|known| fingerprint_of(&known.public).is_ok_and(|known| known == fingerprint));
        // importing the public half of a key we already hold keeps the secret.
        let has_secret =
            !secret.is_empty() || existing.as_ref().is_some_and(|known| known.has_secret);
        let stored = StoredKey {
            public: public.to_string(),
            has_secret,
        };
        match existing {
            Some(known) => *known = stored,
            None => file.keys.push(stored),
        }
        self.save(&file)?;
        let mut info = key.info();
        info.has_secret = has_secret;
        Ok(info)
    }

    fn load(&self) -> Result<KeyFile, ApiError> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                ApiError::internal(
                    "config",
                    format!("{} est illisible : {error}", self.path.display()),
                )
            }),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(KeyFile::default()),
            Err(error) => Err(ApiError::internal(
                "config",
                format!("lecture de {} : {error}", self.path.display()),
            )),
        }
    }

    fn save(&self, file: &KeyFile) -> Result<(), ApiError> {
        let bytes = serde_json::to_vec_pretty(file).map_err(|error| {
            ApiError::internal(
                "config",
                format!("sérialisation du trousseau PGP : {error}"),
            )
        })?;
        private_file::write_private(&self.path, &bytes)
    }
}

fn fingerprint_of(public: &str) -> Result<String, ApiError> {
    PgpKey::parse(public)
        .map(|key| key.fingerprint())
        .map_err(key_error)
}

fn secret_id(fingerprint: &str) -> String {
    format!("{SECRET_PREFIX}{fingerprint}")
}

fn key_error(error: lavande_mail::MailError) -> ApiError {
    use lavande_mail::MailError;
    let message = match error {
        MailError::Mime(message) | MailError::Config(message) => message,
        other => other.to_string(),
    };
    ApiError::bad_request("config", message)
}

fn armored_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::bad_request("config", format!("clé PGP illisible : {error}"))
}

fn unknown(fingerprint: &str) -> ApiError {
    ApiError::not_found(format!("clé PGP « {fingerprint} » inconnue"))
}
