//! PGP/MIME (RFC 3156): sealing outgoing messages and opening received ones.
//!
//! A signed message is `multipart/signed` whose first part is the MIME entity
//! of the body verbatim and whose second part carries the detached signature; an
//! encrypted message is `multipart/encrypted` whose second part is an armored
//! OpenPGP message holding that same entity, signed first when the sender asked
//! for both.

use lettre::address::{Address as EmailAddress, Envelope};
use lettre::message::header::{self, Headers};
use lettre::message::Mailbox;
use pgp::composed::{
    ArmorOptions, Deserializable, DetachedSignature, Message, MessageBuilder, SignedPublicKey,
    SignedSecretKey,
};
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::packet::{SecretKey, SecretSubkey};
use pgp::types::{KeyDetails, SigningKey};
use rand::thread_rng;

use super::{no_passphrase, PgpDetail, PgpKeyring};
use crate::error::MailError;
use crate::model::Address;
use crate::smtp::{self, OutgoingMessage};

const SIGNATURE_CONTENT_TYPE: &str = "application/pgp-signature";
const ENCRYPTED_CONTENT_TYPE: &str = "application/pgp-encrypted";

/// A message ready for the wire, with the envelope it must be submitted with.
pub struct Sealed {
    pub raw: Vec<u8>,
    pub envelope: Envelope,
    pub message_id: String,
}

/// What opening a received encrypted message gave.
pub struct Opened {
    /// The cleartext MIME entity, absent when nothing could be decrypted.
    pub entity: Option<Vec<u8>>,
    pub detail: PgpDetail,
}

/// Signs then encrypts the body of `outgoing` into a full RFC 5322 message.
pub fn seal(
    outgoing: &OutgoingMessage,
    signer: Option<&SignedSecretKey>,
    recipients: &[&SignedPublicKey],
) -> Result<Sealed, MailError> {
    let message_id = message_id(&outgoing.from.email)?;
    let mut entity = Entity::parse(&smtp::body_entity(outgoing)?)?;
    if let Some(signer) = signer {
        entity = sign(&entity, signer)?;
    }
    if !recipients.is_empty() {
        entity = encrypt(&entity, recipients)?;
    }
    let raw = assemble(&headers(outgoing, &message_id)?, &entity);
    Ok(Sealed {
        raw,
        envelope: envelope(outgoing)?,
        message_id,
    })
}

/// Verifies the PGP/MIME signature of a whole message.
pub fn verify(raw: &[u8], keyring: &PgpKeyring) -> PgpDetail {
    match verify_parts(raw, keyring) {
        Ok(detail) => detail,
        Err(error) => PgpDetail {
            verified: Some(false),
            signer: None,
            decrypted: false,
            error: Some(error.to_string()),
        },
    }
}

/// Decrypts the OpenPGP part of a whole `multipart/encrypted` message.
pub fn open(raw: &[u8], keyring: &PgpKeyring) -> Opened {
    let ciphertext = match ciphertext_of(raw) {
        Ok(ciphertext) => ciphertext,
        Err(error) => {
            return Opened {
                entity: None,
                detail: PgpDetail {
                    verified: None,
                    signer: None,
                    decrypted: false,
                    error: Some(error.to_string()),
                },
            }
        }
    };
    for secret in keyring.secrets() {
        match decrypt_with(&ciphertext, secret) {
            Ok((entity, mut detail)) => {
                detail.decrypted = true;
                if is_signed(&entity) {
                    let inner = verify(&entity, keyring);
                    detail.verified = inner.verified;
                    detail.signer = inner.signer;
                    detail.error = inner.error;
                }
                return Opened {
                    entity: Some(entity),
                    detail,
                };
            }
            Err(error) => tracing::debug!(%error, "déchiffrement PGP impossible"),
        }
    }
    Opened {
        entity: None,
        detail: PgpDetail {
            verified: None,
            signer: None,
            decrypted: false,
            error: Some("Clé secrète manquante".to_string()),
        },
    }
}

/// Decrypts one OpenPGP message with one secret key, decompressing it when the
/// sender compressed it.
fn decrypt_with(
    ciphertext: &[u8],
    secret: &SignedSecretKey,
) -> Result<(Vec<u8>, PgpDetail), MailError> {
    let mut decrypted = parse_pgp_message(ciphertext)?
        .decrypt(&no_passphrase(), secret)
        .map_err(pgp_error)?;
    if decrypted.is_compressed() {
        decrypted = decrypted.decompress().map_err(pgp_error)?;
    }
    let entity = decrypted.as_data_vec().map_err(pgp_error)?;
    Ok((entity, PgpDetail::default()))
}

fn verify_parts(raw: &[u8], keyring: &PgpKeyring) -> Result<PgpDetail, MailError> {
    let (headers, body) = split_entity(raw)?;
    let boundary = boundary_of(&headers)?;
    let parts = split_parts(body, &boundary);
    if parts.len() < 2 {
        return Err(MailError::Mime(
            "message signé sans signature PGP".to_string(),
        ));
    }
    let (_, armored) = split_entity(parts[1])?;
    let signature = DetachedSignature::from_armor_single(std::io::Cursor::new(armored))
        .map(|(signature, _)| signature)
        .map_err(pgp_error)?;
    let (verified, signer) = verify_detached(&signature, parts[0], keyring);
    Ok(PgpDetail {
        verified: Some(verified),
        signer,
        decrypted: false,
        error: (!verified).then(|| "Signature PGP invalide".to_string()),
    })
}

/// Checks `signature` against the payload with every verifying key of the
/// keyring; returns whether it matched and the user ID of the signing key.
fn verify_detached(
    signature: &DetachedSignature,
    payload: &[u8],
    keyring: &PgpKeyring,
) -> (bool, Option<String>) {
    let mut owner = None;
    for key in keyring.keys() {
        let public = key.public();
        let matched = signature.verify(&public.primary_key, payload).is_ok()
            || public
                .public_subkeys
                .iter()
                .any(|subkey| signature.verify(subkey, payload).is_ok());
        if matched {
            return (true, Some(key.user_id()));
        }
        let issuer_is_known = signature.signature.issuer_key_id().iter().any(|issuer| {
            **issuer == public.primary_key.legacy_key_id()
                || public
                    .public_subkeys
                    .iter()
                    .any(|subkey| **issuer == subkey.legacy_key_id())
        });
        if owner.is_none() && issuer_is_known {
            owner = Some(key.user_id());
        }
    }
    (false, owner)
}

/// Whether the cleartext entity of a decrypted message is itself signed: it
/// then carries the `multipart/signed` of the sender.
fn is_signed(entity: &[u8]) -> bool {
    split_entity(entity)
        .map(|(headers, _)| {
            header(&headers, "content-type")
                .is_some_and(|content_type| content_type.starts_with("multipart/signed"))
        })
        .unwrap_or(false)
}

fn parse_pgp_message(ciphertext: &[u8]) -> Result<Message<'_>, MailError> {
    match std::str::from_utf8(ciphertext) {
        Ok(text) if text.contains("-----BEGIN PGP MESSAGE-----") => {
            Message::from_string(text).map(|(message, _)| message)
        }
        _ => Message::from_bytes(std::io::Cursor::new(ciphertext)),
    }
    .map_err(pgp_error)
}

/// A MIME entity: its `Content-Type` header and its content, which are the
/// MIME headers of the message themselves once assembled.
struct Entity {
    content_type: String,
    body: Vec<u8>,
}

impl Entity {
    /// Splits the entity `smtp` built into its `Content-Type` and its content.
    fn parse(entity: &[u8]) -> Result<Self, MailError> {
        let (headers, body) = split_entity(entity)?;
        let content_type = header(&headers, "content-type")
            .ok_or_else(|| MailError::Mime("corps sans Content-Type".to_string()))?;
        Ok(Self {
            content_type: content_type.to_string(),
            body: body.to_vec(),
        })
    }

    /// The entity as it appears inside a multipart body, headers included.
    fn render(&self) -> Vec<u8> {
        let mut raw = format!("Content-Type: {}\r\n\r\n", self.content_type).into_bytes();
        raw.extend_from_slice(&self.body);
        raw
    }
}

fn sign(entity: &Entity, signer: &SignedSecretKey) -> Result<Entity, MailError> {
    let payload = entity.render();
    let armored = match signing_component(signer) {
        Some(Component::Primary(key)) => detached_signature(key, &payload)?,
        Some(Component::Subkey(key)) => detached_signature(key, &payload)?,
        None => {
            return Err(MailError::Config(
                "clé PGP sans clé de signature utilisable".to_string(),
            ))
        }
    };
    let boundary = boundary();
    let mut body = format!("--{boundary}\r\n").into_bytes();
    body.extend_from_slice(&payload);
    body.extend_from_slice(
        format!(
            "\r\n--{boundary}\r\nContent-Type: {SIGNATURE_CONTENT_TYPE}\r\n\r\n{}\r\n--{boundary}--\r\n",
            armored.trim_end()
        )
        .as_bytes(),
    );
    Ok(Entity {
        content_type: format!(
            "multipart/signed; micalg=\"pgp-sha256\"; protocol=\"{SIGNATURE_CONTENT_TYPE}\"; \
             boundary=\"{boundary}\""
        ),
        body,
    })
}

/// The part of a certificate that signs, pairing the secret material with the
/// signature algorithm the key allows.
enum Component<'a> {
    Primary(&'a SecretKey),
    Subkey(&'a SecretSubkey),
}

/// The signing component of `key`: the primary key when its self-signature
/// allows signing, else the first signing subkey (the layout GnuPG uses).
fn signing_component(key: &SignedSecretKey) -> Option<Component<'_>> {
    let primary_can_sign = key.primary_key.algorithm().can_sign();
    let flags_allow_it = key
        .details
        .users
        .iter()
        .flat_map(|user| user.signatures.iter())
        .chain(key.details.direct_signatures.iter())
        .any(|signature| signature.key_flags().sign());
    if primary_can_sign && flags_allow_it {
        return Some(Component::Primary(&key.primary_key));
    }
    let subkey = key.secret_subkeys.iter().find(|subkey| {
        subkey.algorithm().can_sign()
            && subkey
                .signatures
                .iter()
                .any(|signature| signature.key_flags().sign())
    });
    match subkey {
        Some(subkey) => Some(Component::Subkey(&subkey.key)),
        None => primary_can_sign.then_some(Component::Primary(&key.primary_key)),
    }
}

fn detached_signature<K: SigningKey>(key: &K, payload: &[u8]) -> Result<String, MailError> {
    DetachedSignature::sign_binary_data(
        thread_rng(),
        key,
        &no_passphrase(),
        HashAlgorithm::Sha256,
        payload,
    )
    .map_err(pgp_error)?
    .to_armored_string(ArmorOptions::default())
    .map_err(pgp_error)
}

fn encrypt(entity: &Entity, recipients: &[&SignedPublicKey]) -> Result<Entity, MailError> {
    let mut builder = MessageBuilder::from_bytes("", entity.render())
        .seipd_v1(thread_rng(), SymmetricKeyAlgorithm::AES256);
    for recipient in recipients {
        let Some(subkey) = recipient
            .public_subkeys
            .iter()
            .find(|subkey| subkey.algorithm().can_encrypt())
        else {
            return Err(MailError::Config(format!(
                "clé PGP {:X} sans sous-clé de chiffrement",
                recipient.fingerprint()
            )));
        };
        builder
            .encrypt_to_key(thread_rng(), subkey)
            .map_err(pgp_error)?;
    }
    let armored = builder
        .to_armored_string(thread_rng(), ArmorOptions::default())
        .map_err(pgp_error)?;
    let boundary = boundary();
    Ok(Entity {
        content_type: format!(
            "multipart/encrypted; protocol=\"{ENCRYPTED_CONTENT_TYPE}\"; boundary=\"{boundary}\""
        ),
        body: format!(
            "--{boundary}\r\nContent-Type: {ENCRYPTED_CONTENT_TYPE}\r\n\r\nVersion: 1\r\n\r\n\
             --{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n{}\r\n--{boundary}--\r\n",
            armored.trim_end()
        )
        .into_bytes(),
    })
}

/// Envelope headers of the message, without `Content-Type`: the entity carries
/// its own MIME headers.
fn headers(outgoing: &OutgoingMessage, message_id: &str) -> Result<Headers, MailError> {
    let mut headers = Headers::new();
    headers.set(header::MIME_VERSION_1_0);
    headers.set(header::Date::now());
    headers.set(header::From::from(mailboxes(std::slice::from_ref(
        &outgoing.from,
    ))?));
    if !outgoing.to.is_empty() {
        headers.set(header::To::from(mailboxes(&outgoing.to)?));
    }
    if !outgoing.cc.is_empty() {
        headers.set(header::Cc::from(mailboxes(&outgoing.cc)?));
    }
    headers.set(header::Subject::from(outgoing.subject.clone()));
    headers.set(header::MessageId::from(message_id.to_string()));
    if let Some(in_reply_to) = &outgoing.in_reply_to {
        headers.set(header::InReplyTo::from(format!("<{in_reply_to}>")));
    }
    if !outgoing.references.is_empty() {
        let references = outgoing
            .references
            .iter()
            .map(|reference| format!("<{reference}>"))
            .collect::<Vec<_>>()
            .join(" ");
        headers.set(header::References::from(references));
    }
    Ok(headers)
}

fn envelope(outgoing: &OutgoingMessage) -> Result<Envelope, MailError> {
    let from = address(&outgoing.from)?;
    let mut to = Vec::new();
    for recipient in outgoing.to.iter().chain(&outgoing.cc).chain(&outgoing.bcc) {
        to.push(address(recipient)?);
    }
    Envelope::new(Some(from), to).map_err(|error| MailError::Smtp(error.to_string()))
}

fn address(address: &Address) -> Result<EmailAddress, MailError> {
    address
        .email
        .parse()
        .map_err(|error| MailError::Smtp(format!("invalid email address: {error}")))
}

fn mailboxes(addresses: &[Address]) -> Result<lettre::message::Mailboxes, MailError> {
    let mut mailboxes = Vec::with_capacity(addresses.len());
    for recipient in addresses {
        let email = address(recipient)?;
        let name = recipient.name.clone().filter(|name| !name.is_empty());
        mailboxes.push(Mailbox::new(name, email));
    }
    Ok(lettre::message::Mailboxes::from(mailboxes))
}

fn assemble(headers: &Headers, entity: &Entity) -> Vec<u8> {
    let mut all = headers.clone();
    all.set(
        header::ContentType::parse(&entity.content_type).expect("content type PGP/MIME valide"),
    );
    let mut raw = all.to_string().into_bytes();
    raw.extend_from_slice(b"\r\n");
    raw.extend_from_slice(&entity.body);
    raw
}

/// `Message-ID` of the sealed message, unique per call: the timestamp carries
/// the entropy and the local part stays readable.
fn message_id(from: &str) -> Result<String, MailError> {
    let domain = from
        .rsplit_once('@')
        .map(|(_, domain)| domain)
        .filter(|domain| !domain.is_empty())
        .unwrap_or("lavande.local");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| MailError::Smtp(format!("horloge système : {error}")))?
        .as_nanos();
    Ok(format!("<{nanos:x}.{}@{domain}>", rand::random::<u64>()))
}

fn boundary() -> String {
    format!("lavande-{:016x}", rand::random::<u64>())
}

fn pgp_error(error: impl std::fmt::Display) -> MailError {
    MailError::Mime(format!("OpenPGP : {error}"))
}

/// Header names lowercased with their unfolded value.
type Fields = Vec<(String, String)>;

/// Headers of a message and its body, split on the first empty line.
fn split_entity(raw: &[u8]) -> Result<(Fields, &[u8]), MailError> {
    let end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| (position, position + 4))
        .or_else(|| {
            raw.windows(2)
                .position(|window| window == b"\n\n")
                .map(|position| (position, position + 2))
        })
        .ok_or_else(|| MailError::Mime("message sans en-têtes MIME".to_string()))?;
    let headers = parse_headers(&raw[..end.0])?;
    Ok((headers, &raw[end.1..]))
}

fn parse_headers(raw: &[u8]) -> Result<Fields, MailError> {
    let text = String::from_utf8_lossy(raw);
    let mut headers: Fields = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.starts_with([' ', '\t']) {
            if let Some(last) = headers.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    Ok(headers)
}

fn header<'a>(headers: &'a Fields, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header, _)| header == name)
        .map(|(_, value)| value.as_str())
}

fn boundary_of(headers: &Fields) -> Result<String, MailError> {
    let content_type = header(headers, "content-type")
        .ok_or_else(|| MailError::Mime("message sans Content-Type".to_string()))?;
    let boundary = content_type
        .split(';')
        .find_map(|parameter| {
            let (name, value) = parameter.trim().split_once('=')?;
            name.trim()
                .eq_ignore_ascii_case("boundary")
                .then(|| value.trim().trim_matches('"').to_string())
        })
        .ok_or_else(|| MailError::Mime("multipart sans boundary".to_string()))?;
    Ok(boundary)
}

/// Parts of a multipart body, exact bytes: the trailing CRLF belongs to the
/// delimiter, so it is not part of a part.
fn split_parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let delimiter = format!("--{boundary}");
    let delimiter = delimiter.as_bytes();
    let mut starts: Vec<usize> = Vec::new();
    let mut index = 0;
    while index + delimiter.len() <= body.len() {
        let at_line_start = index == 0 || body[index - 1] == b'\n';
        if at_line_start && &body[index..index + delimiter.len()] == delimiter {
            starts.push(index);
            index += delimiter.len();
        } else {
            index += 1;
        }
    }
    let mut parts = Vec::new();
    for (position, start) in starts.iter().enumerate() {
        let content_start = start + delimiter.len();
        // `--boundary--` closes the body.
        if body[content_start..].starts_with(b"--") {
            break;
        }
        let content_start = match body[content_start..].windows(2).position(|w| w == b"\r\n") {
            Some(offset) => content_start + offset + 2,
            None => continue,
        };
        let content_end = match starts.get(position + 1) {
            Some(next) => {
                let mut end = *next;
                if end >= content_start + 2 && &body[end - 2..end] == b"\r\n" {
                    end -= 2;
                } else if end > content_start && body[end - 1] == b'\n' {
                    end -= 1;
                }
                end
            }
            None => body.len(),
        };
        if content_end > content_start {
            parts.push(&body[content_start..content_end]);
        }
    }
    parts
}

/// Second part of a `multipart/encrypted` message: the OpenPGP ciphertext.
fn ciphertext_of(raw: &[u8]) -> Result<Vec<u8>, MailError> {
    let (headers, body) = split_entity(raw)?;
    let boundary = boundary_of(&headers)?;
    let parts = split_parts(body, &boundary);
    if parts.len() < 2 {
        return Err(MailError::Mime(
            "message chiffré sans charge PGP".to_string(),
        ));
    }
    let payload = parts[1];
    let (part_headers, part_body) = split_entity(payload)?;
    let _ = part_headers;
    Ok(part_body.to_vec())
}
