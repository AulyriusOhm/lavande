//! Offline PGP tests: key generation, import/export, PGP/MIME sealing and
//! opening. No network.

use lavande_mail::model::{Address, PgpState};
use lavande_mail::pgp::{self, mime, PgpKey, PgpKeyring};
use lavande_mail::smtp::OutgoingMessage;
use lavande_mail::{parse_message, parse_message_with_keys};

fn date(iso: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .expect("date ISO8601")
        .with_timezone(&chrono::Utc)
}

fn outgoing(html: Option<&str>) -> OutgoingMessage {
    OutgoingMessage {
        from: Address {
            name: Some("Roman".to_string()),
            email: "roman@lavande.mail".to_string(),
        },
        to: vec![Address {
            name: None,
            email: "camille@studio-lilas.fr".to_string(),
        }],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: "Planning".to_string(),
        text: "Bonjour Camille".to_string(),
        html: html.map(str::to_string),
        in_reply_to: None,
        references: Vec::new(),
        attachments: Vec::new(),
        pgp_sign: true,
        pgp_encrypt: true,
    }
}

fn keyring_of(armored: &str) -> PgpKeyring {
    let mut keyring = PgpKeyring::new();
    keyring.insert_armored(armored).expect("clé");
    keyring
}

#[test]
fn a_generated_key_looks_like_a_key() {
    let key = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let info = key.info();
    assert_eq!(info.fingerprint.len(), 40, "empreinte v4");
    assert_eq!(info.fingerprint.to_uppercase(), info.fingerprint);
    assert_eq!(info.user_id, "Roman <roman@lavande.mail>");
    assert_eq!(info.name.as_deref(), Some("Roman"));
    assert_eq!(info.email.as_deref(), Some("roman@lavande.mail"));
    assert!(info.has_secret);
    assert!(!info.revoked);
    assert!(!info.expired);
    assert!(info.expires_at.is_some(), "expiration annoncée");
    assert_eq!(info.algorithm, "Ed25519");
    assert_eq!(info.key_id.len(), 16);

    let public = PgpKey::parse(&key.public_armored().expect("export")).expect("relecture");
    assert!(!public.has_secret());
    assert_eq!(public.fingerprint(), info.fingerprint);

    let secret = PgpKey::parse(
        &key.secret()
            .expect("clé secrète")
            .to_armored_string(Default::default())
            .expect("export"),
    )
    .expect("relecture");
    assert!(secret.has_secret());
    assert_eq!(secret.fingerprint(), info.fingerprint);
}

#[test]
fn a_generated_key_expires() {
    let key = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    key.public().verify_bindings().expect("auto-signatures");

    let info = key.info();
    assert!(!info.expired);
    let created_at = date(&info.created_at);
    let expires_at = date(info.expires_at.as_deref().expect("expiration"));
    assert!(expires_at > chrono::Utc::now(), "{expires_at}");
    assert_eq!(
        expires_at - created_at,
        chrono::Duration::from_std(pgp::KEY_LIFETIME).expect("durée")
    );

    let signature = &key.public().details.users[0].signatures[0];
    let lifetime: std::time::Duration = signature
        .key_expiration_time()
        .expect("sous-paquet KeyExpirationTime")
        .into();
    assert_eq!(lifetime, pgp::KEY_LIFETIME);

    let reread = PgpKey::parse(&key.public_armored().expect("export")).expect("relecture");
    reread.public().verify_bindings().expect("auto-signatures");
    assert_eq!(reread.info().expires_at, info.expires_at);
}

#[test]
fn a_generated_key_expires_after_the_requested_lifetime() {
    let lifetime = std::time::Duration::from_secs(30 * 24 * 60 * 60);
    let key = pgp::generate_key_with_lifetime("Roman", "roman@lavande.mail", lifetime)
        .expect("génération");
    let info = PgpKey::parse(&key.public_armored().expect("export"))
        .expect("relecture")
        .info();
    assert!(!info.expired);
    let created_at = date(&info.created_at);
    let expires_at = date(info.expires_at.as_deref().expect("expiration"));
    assert_eq!(expires_at - created_at, chrono::Duration::days(30));
}

#[test]
fn a_signed_message_verifies_with_the_senders_key() {
    let key = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let sealed = mime::seal(&outgoing(None), key.secret(), &[]).expect("scellé");
    let raw = String::from_utf8_lossy(&sealed.raw).to_string();
    assert!(raw.contains("multipart/signed"), "{raw}");
    assert!(raw.contains("protocol=\"application/pgp-signature\""));
    assert!(sealed.message_id.starts_with('<') && sealed.message_id.ends_with('>'));

    let keyring = keyring_of(&key.public_armored().expect("export"));
    let parsed = parse_message_with_keys(&sealed.raw, &keyring).expect("lecture");
    assert_eq!(parsed.pgp, PgpState::Signed);
    assert_eq!(parsed.subject, "Planning");
    assert_eq!(parsed.from.email, "roman@lavande.mail");
    assert_eq!(parsed.body_text.as_deref(), Some("Bonjour Camille"));
    let detail = parsed.pgp_detail.expect("détail");
    assert_eq!(detail.verified, Some(true));
    assert_eq!(detail.signer.as_deref(), Some("Roman <roman@lavande.mail>"));
    assert!(!detail.decrypted);
    assert!(detail.error.is_none());
}

#[test]
fn a_tampered_signed_message_does_not_verify() {
    let key = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let sealed = mime::seal(&outgoing(None), key.secret(), &[]).expect("scellé");
    let tampered = String::from_utf8_lossy(&sealed.raw)
        .replace("Bonjour Camille", "Bonjour CamilIe")
        .into_bytes();
    let keyring = keyring_of(&key.public_armored().expect("export"));
    let detail = parse_message_with_keys(&tampered, &keyring)
        .expect("lecture")
        .pgp_detail
        .expect("détail");
    assert_eq!(detail.verified, Some(false));
    assert!(detail.error.is_some());
}

#[test]
fn a_signed_message_from_an_unknown_key_is_not_verified() {
    let key = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let sealed = mime::seal(&outgoing(None), key.secret(), &[]).expect("scellé");
    let parsed = parse_message_with_keys(&sealed.raw, &PgpKeyring::new()).expect("lecture");
    let detail = parsed.pgp_detail.expect("détail");
    assert_eq!(parsed.pgp, PgpState::Signed);
    assert_eq!(detail.verified, Some(false));
    assert!(detail.signer.is_none());
}

#[test]
fn an_encrypted_message_decrypts_with_the_recipients_secret_key() {
    let sender = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let recipient = pgp::generate_key("Camille", "camille@studio-lilas.fr").expect("génération");
    let sealed = mime::seal(
        &outgoing(Some("<p>Bonjour</p>")),
        None,
        &[recipient.public()],
    )
    .expect("scellé");
    let raw = String::from_utf8_lossy(&sealed.raw).to_string();
    assert!(raw.contains("multipart/encrypted"), "{raw}");
    assert!(raw.contains("application/pgp-encrypted"));
    assert!(!raw.contains("Bonjour"), "le corps doit être chiffré");
    assert!(!raw.contains("-----BEGIN PGP PRIVATE KEY-----"));

    let keyring = keyring_of(&sender.public_armored().expect("export"));
    let missing = parse_message_with_keys(&sealed.raw, &keyring).expect("lecture");
    assert_eq!(missing.pgp, PgpState::Encrypted);
    let detail = missing.pgp_detail.expect("détail");
    assert!(!detail.decrypted);
    assert_eq!(detail.error.as_deref(), Some("Clé secrète manquante"));
    assert!(missing.body_text.is_none());
    assert!(missing.body_html.is_none());

    let keyring = keyring_of(
        &recipient
            .secret()
            .expect("clé secrète")
            .to_armored_string(Default::default())
            .expect("export"),
    );
    let parsed = parse_message_with_keys(&sealed.raw, &keyring).expect("lecture");
    assert_eq!(parsed.pgp, PgpState::Encrypted);
    assert_eq!(parsed.body_text.as_deref(), Some("Bonjour Camille"));
    assert_eq!(parsed.body_html.as_deref(), Some("<p>Bonjour</p>"));
    let detail = parsed.pgp_detail.expect("détail");
    assert!(detail.decrypted);
    assert_eq!(detail.verified, None);
    assert!(detail.error.is_none());
}

#[test]
fn encrypted_and_signed_carries_both_states() {
    let sender = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let sealed = mime::seal(&outgoing(None), sender.secret(), &[sender.public()]).expect("scellé");
    let keyring = keyring_of(
        &sender
            .secret()
            .expect("clé secrète")
            .to_armored_string(Default::default())
            .expect("export"),
    );
    let parsed = parse_message_with_keys(&sealed.raw, &keyring).expect("lecture");
    assert_eq!(parsed.pgp, PgpState::Encrypted);
    assert_eq!(parsed.body_text.as_deref(), Some("Bonjour Camille"));
    let detail = parsed.pgp_detail.expect("détail");
    assert!(detail.decrypted);
    assert_eq!(detail.verified, Some(true));
    assert_eq!(detail.signer.as_deref(), Some("Roman <roman@lavande.mail>"));
}

#[test]
fn an_imported_key_is_exported_back_unchanged() {
    let generated = pgp::generate_key("Camille", "camille@studio-lilas.fr").expect("génération");
    let public = generated.public_armored().expect("export");
    let mut keyring = PgpKeyring::new();
    let info = keyring.insert_armored(&public).expect("import");
    assert!(!info.has_secret);
    assert_eq!(info.email.as_deref(), Some("camille@studio-lilas.fr"));
    assert!(keyring.find(&info.fingerprint).is_some());
    assert!(keyring.find(&info.fingerprint.to_lowercase()).is_some());
    assert!(keyring.secret_for("camille@studio-lilas.fr").is_none());
    assert!(keyring.secret_for("CAMILLE@studio-lilas.fr").is_none());
    assert_eq!(
        keyring
            .find(&info.fingerprint)
            .expect("clé")
            .public_armored()
            .expect("export"),
        public
    );
    assert!(PgpKey::parse("pas une clé").is_err());
}

#[test]
fn the_keyring_finds_keys_by_mailbox() {
    let roman = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let camille = pgp::generate_key("Camille", "camille@studio-lilas.fr").expect("génération");
    let mut keyring = PgpKeyring::new();
    keyring
        .insert_armored(&roman.public_armored().expect("export"))
        .expect("roman");
    keyring
        .insert_armored(&camille.public_armored().expect("export"))
        .expect("camille");
    assert_eq!(keyring.infos().len(), 2);
    assert!(keyring.public_for("Roman@Lavande.mail").is_some());
    assert!(keyring.public_for("marc@mail.fr").is_none());
    assert!(keyring.secret_for("roman@lavande.mail").is_none());
}

#[test]
fn a_plain_message_has_no_pgp_detail() {
    let raw = b"From: marc@mail.fr\r\nTo: roman@lavande.mail\r\nSubject: Salut\r\n\r\nCorps\r\n";
    let parsed = parse_message_with_keys(raw, &PgpKeyring::new()).expect("lecture");
    assert_eq!(parsed.pgp, PgpState::None);
    assert!(parsed.pgp_detail.is_none());
    assert_eq!(
        parse_message(raw).expect("lecture").body_text.as_deref(),
        Some("Corps")
    );
}

#[test]
fn clearing_a_key_from_the_keyring_forgets_it() {
    let key = pgp::generate_key("Roman", "roman@lavande.mail").expect("génération");
    let mut keyring = keyring_of(&key.public_armored().expect("export"));
    let fingerprint = keyring.infos()[0].fingerprint.clone();
    assert!(keyring.remove(&fingerprint).is_some());
    assert!(keyring.is_empty());
    assert!(keyring.remove(&fingerprint).is_none());
}
