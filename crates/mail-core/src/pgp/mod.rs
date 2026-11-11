//! OpenPGP (RFC 9580) keys on top of the pure-Rust `pgp` crate: generation,
//! import/export of transferable keys, and the keyring the send and receive
//! paths look keys up in.

pub mod mime;

use chrono::{DateTime, SecondsFormat, Utc};
use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType, SecretKeyParamsBuilder, SignedPublicKey,
    SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::ecc_curve::ECCCurve;
use pgp::crypto::public_key::PublicKeyAlgorithm;
use pgp::types::{KeyDetails, Password};
use serde::{Deserialize, Serialize};

use crate::error::MailError;
use crate::model::Address;

/// What verification/decryption found out about a received message.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PgpDetail {
    /// `Some(true)` only when a signature was checked against a known key.
    pub verified: Option<bool>,
    /// User ID of the key that made the signature, when it is known.
    pub signer: Option<String>,
    pub decrypted: bool,
    pub error: Option<String>,
}

/// Metadata of one key of the keyring, as the API exposes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PgpKeyInfo {
    pub fingerprint: String,
    pub key_id: String,
    pub user_id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub algorithm: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub has_secret: bool,
    pub revoked: bool,
    pub expired: bool,
}

/// One transferable key: its certificate, and the secret key when we hold it.
pub struct PgpKey {
    public: SignedPublicKey,
    secret: Option<SignedSecretKey>,
}

impl PgpKey {
    /// Reads a public or a secret key, armored or binary.
    pub fn parse(armored: &str) -> Result<Self, MailError> {
        if let Ok((secret, _)) = SignedSecretKey::from_string(armored) {
            let public = secret.to_public_key();
            return Ok(Self {
                public,
                secret: Some(secret),
            });
        }
        let (public, _) = SignedPublicKey::from_string(armored)
            .map_err(|error| MailError::Mime(format!("clé PGP illisible : {error}")))?;
        Ok(Self {
            public,
            secret: None,
        })
    }

    pub fn fingerprint(&self) -> String {
        format!("{:X}", self.public.fingerprint())
    }

    pub fn public_armored(&self) -> Result<String, MailError> {
        self.public
            .to_armored_string(Default::default())
            .map_err(|error| MailError::Mime(format!("export de la clé PGP : {error}")))
    }

    pub fn has_secret(&self) -> bool {
        self.secret.is_some()
    }

    pub fn secret(&self) -> Option<&SignedSecretKey> {
        self.secret.as_ref()
    }

    pub fn public(&self) -> &SignedPublicKey {
        &self.public
    }

    /// The first user ID of the key, e.g. `Nom <mail@exemple.fr>`.
    pub fn user_id(&self) -> String {
        self.public
            .details
            .users
            .iter()
            .map(|user| String::from_utf8_lossy(user.id.id()).to_string())
            .find(|user_id| !user_id.is_empty())
            .unwrap_or_default()
    }

    /// The mailbox the key belongs to, read from its first user ID.
    pub fn address(&self) -> Address {
        let user_id = self.user_id();
        let (name, email) = split_user_id(&user_id);
        Address { name, email }
    }

    pub fn info(&self) -> PgpKeyInfo {
        let Address { name, email } = self.address();
        let created_at = system_time(self.public.primary_key.created_at());
        let expires_at = self.expires_at();
        PgpKeyInfo {
            fingerprint: self.fingerprint(),
            key_id: self
                .public
                .primary_key
                .legacy_key_id()
                .to_string()
                .to_uppercase(),
            user_id: self.user_id(),
            name,
            email: (!email.is_empty()).then_some(email),
            algorithm: algorithm_label(self.public.primary_key.algorithm()),
            created_at: iso(created_at),
            expires_at: expires_at.map(iso),
            has_secret: self.has_secret(),
            revoked: !self.public.details.revocation_signatures.is_empty(),
            expired: expires_at.is_some_and(|expires_at| expires_at < Utc::now()),
        }
    }

    /// Expiration announced by the latest self-signature of the user ID.
    fn expires_at(&self) -> Option<DateTime<Utc>> {
        let created_at = system_time(self.public.primary_key.created_at());
        let lifetime: std::time::Duration = self
            .public
            .details
            .users
            .iter()
            .flat_map(|user| user.signatures.iter())
            .filter_map(|signature| signature.key_expiration_time())
            .next()?
            .into();
        chrono::Duration::from_std(lifetime)
            .ok()
            .map(|lifetime| created_at + lifetime)
    }
}

/// Generates an Ed25519 key (certification and signature) with a Curve25519
/// encryption subkey. No passphrase: the private half is protected by the secret
/// store.
pub fn generate_key(name: &str, email: &str) -> Result<PgpKey, MailError> {
    let user_id = match name.trim() {
        "" => email.trim().to_string(),
        name => format!("{} <{}>", name.trim(), email.trim()),
    };

    let mut encryption = SubkeyParamsBuilder::default();
    encryption
        .key_type(KeyType::ECDH(ECCCurve::Curve25519Legacy))
        .can_sign(false)
        .can_encrypt(EncryptionCaps::All)
        .can_authenticate(false);

    let mut params = SecretKeyParamsBuilder::default();
    params
        .key_type(KeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(true)
        .can_encrypt(EncryptionCaps::None)
        .primary_user_id(user_id)
        .passphrase(None)
        .subkeys(vec![encryption.build().map_err(keygen_error)?]);
    let secret = params
        .build()
        .map_err(keygen_error)?
        .generate(rand::thread_rng())
        .map_err(keygen_error)?;
    let public = secret.to_public_key();
    Ok(PgpKey {
        public,
        secret: Some(secret),
    })
}

fn keygen_error(error: impl std::fmt::Display) -> MailError {
    MailError::Mime(format!("génération de la clé PGP : {error}"))
}

/// The keys the daemon knows about: public keys for encryption and
/// verification, secret keys for signing and decryption.
#[derive(Default)]
pub struct PgpKeyring {
    keys: Vec<PgpKey>,
}

impl PgpKeyring {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a key; a key already known (same fingerprint) is replaced, which is
    /// how a secret key replaces its own public stub.
    pub fn insert(&mut self, key: PgpKey) -> PgpKeyInfo {
        let fingerprint = key.fingerprint();
        let info = key.info();
        match self
            .keys
            .iter_mut()
            .find(|known| known.fingerprint() == fingerprint)
        {
            Some(known) if key.has_secret() || !known.has_secret() => *known = key,
            Some(_) => {}
            None => self.keys.push(key),
        }
        info
    }

    pub fn insert_armored(&mut self, armored: &str) -> Result<PgpKeyInfo, MailError> {
        Ok(self.insert(PgpKey::parse(armored)?))
    }

    pub fn keys(&self) -> &[PgpKey] {
        &self.keys
    }

    pub fn infos(&self) -> Vec<PgpKeyInfo> {
        let mut infos: Vec<PgpKeyInfo> = self.keys.iter().map(PgpKey::info).collect();
        infos.sort_by(|left, right| left.user_id.cmp(&right.user_id));
        infos
    }

    pub fn find(&self, fingerprint: &str) -> Option<&PgpKey> {
        self.keys
            .iter()
            .find(|key| key.fingerprint().eq_ignore_ascii_case(fingerprint))
    }

    pub fn remove(&mut self, fingerprint: &str) -> Option<PgpKey> {
        let index = self
            .keys
            .iter()
            .position(|key| key.fingerprint().eq_ignore_ascii_case(fingerprint))?;
        Some(self.keys.remove(index))
    }

    /// Public key of a mailbox, for encryption.
    pub fn public_for(&self, email: &str) -> Option<&SignedPublicKey> {
        self.keys
            .iter()
            .find(|key| key.address().email.eq_ignore_ascii_case(email))
            .map(PgpKey::public)
    }

    /// Secret key of a mailbox, for signing and decryption.
    pub fn secret_for(&self, email: &str) -> Option<&SignedSecretKey> {
        self.keys
            .iter()
            .filter(|key| key.address().email.eq_ignore_ascii_case(email))
            .find_map(PgpKey::secret)
    }

    /// Secret keys whose user ID matches `email`, for decryption.
    pub fn secrets(&self) -> Vec<&SignedSecretKey> {
        self.keys.iter().filter_map(PgpKey::secret).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// Splits `Nom <mail@exemple.fr>`; a bare address gives `(None, address)`.
pub fn split_user_id(user_id: &str) -> (Option<String>, String) {
    let user_id = user_id.trim();
    match user_id.rsplit_once('<') {
        Some((name, email)) => {
            let name = name.trim().trim_matches('"').trim();
            (
                (!name.is_empty()).then(|| name.to_string()),
                email.trim_end_matches('>').trim().to_string(),
            )
        }
        None => (None, user_id.to_string()),
    }
}

/// Empty passphrase: private keys are protected by the secret store, not by a
/// passphrase of their own.
pub fn no_passphrase() -> Password {
    Password::empty()
}

fn algorithm_label(algorithm: PublicKeyAlgorithm) -> String {
    match algorithm {
        PublicKeyAlgorithm::RSA | PublicKeyAlgorithm::RSAEncrypt | PublicKeyAlgorithm::RSASign => {
            "RSA".to_string()
        }
        PublicKeyAlgorithm::EdDSALegacy | PublicKeyAlgorithm::Ed25519 => "Ed25519".to_string(),
        PublicKeyAlgorithm::ECDH => "Curve25519".to_string(),
        PublicKeyAlgorithm::ECDSA => "ECDSA".to_string(),
        PublicKeyAlgorithm::X25519 => "X25519".to_string(),
        PublicKeyAlgorithm::Ed448 => "Ed448".to_string(),
        PublicKeyAlgorithm::X448 => "X448".to_string(),
        PublicKeyAlgorithm::ElgamalEncrypt
        | PublicKeyAlgorithm::Elgamal
        | PublicKeyAlgorithm::DiffieHellman => "Elgamal".to_string(),
        PublicKeyAlgorithm::DSA => "DSA".to_string(),
        other => format!("{other:?}"),
    }
}

fn system_time(at: pgp::types::Timestamp) -> DateTime<Utc> {
    DateTime::<Utc>::from(std::time::SystemTime::from(at))
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}
