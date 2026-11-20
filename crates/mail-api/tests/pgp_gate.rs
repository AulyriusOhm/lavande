//! Offline tests of the per-account PGP gate: the keyring the daemon decrypts
//! with is empty for an account whose switch is off, so encrypted bodies stay
//! closed. No network.

use std::sync::Arc;

use lavande_mail::mime;
use lavande_mail::model::{Address, PgpState};
use lavande_mail::pgp::mime::seal;
use lavande_mail::smtp::OutgoingMessage;
use lavande_mail::tls::TlsOptions;
use lavande_mail::HTML_POLICY_MARKER;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use tempfile::TempDir;

const ACCOUNT: &str = "perso";
const ADDRESS: &str = "roman@lavande.mail";

async fn state() -> (TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let state = AppState::open_with(
        directory.path(),
        TlsOptions::default(),
        Default::default(),
        SecretBackend::File,
    )
    .await
    .expect("état");
    (directory, Arc::new(state))
}

fn outgoing() -> OutgoingMessage {
    OutgoingMessage {
        from: Address {
            name: Some("Camille".to_string()),
            email: "camille@studio-lilas.fr".to_string(),
        },
        to: vec![Address {
            name: None,
            email: ADDRESS.to_string(),
        }],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: "Planning".to_string(),
        text: "Bonjour Camille".to_string(),
        html: Some("<p>Bonjour</p>".to_string()),
        in_reply_to: None,
        references: Vec::new(),
        attachments: Vec::new(),
        pgp_sign: false,
        pgp_encrypt: true,
    }
}

/// A message encrypted for the account's own key: exactly what the server hands
/// back for a PGP message the account holds.
async fn encrypted_for_the_account(state: &AppState) -> Vec<u8> {
    state
        .pgp()
        .generate("Roman", ADDRESS)
        .await
        .expect("clé générée");
    let keyring = state.pgp().public_keyring().expect("clés publiques");
    let public = keyring.public_for(ADDRESS).expect("clé publique");
    seal(&outgoing(), None, &[public]).expect("scellé").raw
}

#[tokio::test]
async fn an_enabled_account_decrypts_with_the_whole_keyring() {
    let (_directory, state) = state().await;
    let raw = encrypted_for_the_account(&state).await;

    let keys = state.keyring_for(ACCOUNT).await.expect("trousseau");
    assert!(!keys.is_empty(), "compte ouvert : trousseau complet");

    let parsed = mime::parse_message_with_keys(&raw, &keys).expect("lecture");
    assert_eq!(parsed.pgp, PgpState::Encrypted);
    assert_eq!(parsed.body_text.as_deref(), Some("Bonjour Camille"));
    assert_eq!(
        parsed.body_html.as_deref(),
        Some(format!("{HTML_POLICY_MARKER}<p>Bonjour</p>").as_str())
    );
    assert!(parsed.pgp_detail.expect("détail").decrypted);
    assert_eq!(
        mime::html_with_images(&raw, &keys)
            .expect("html")
            .as_deref(),
        Some("<p>Bonjour</p>")
    );
}

#[tokio::test]
async fn a_disabled_account_gets_an_empty_keyring_and_stays_closed() {
    let (_directory, state) = state().await;
    let raw = encrypted_for_the_account(&state).await;
    state
        .store()
        .upsert_account(ACCOUNT, "Perso", ADDRESS)
        .expect("compte");
    state
        .store()
        .set_pgp_enabled(ACCOUNT, false)
        .expect("interrupteur");

    let keys = state.keyring_for(ACCOUNT).await.expect("trousseau");
    assert!(keys.is_empty(), "compte fermé : trousseau vide");

    let parsed = mime::parse_message_with_keys(&raw, &keys).expect("lecture");
    assert_eq!(parsed.pgp, PgpState::Encrypted, "le message reste chiffré");
    assert!(parsed.body_text.is_none());
    assert!(parsed.body_html.is_none());
    assert!(parsed.preview.is_empty());
    assert!(parsed.attachments.is_empty());
    let detail = parsed.pgp_detail.expect("détail");
    assert!(!detail.decrypted);
    assert_eq!(detail.error.as_deref(), Some("Clé secrète manquante"));

    assert_eq!(
        mime::html_with_images(&raw, &keys).expect("html"),
        None,
        "aucun HTML rendu avec ses images"
    );
}

#[tokio::test]
async fn the_switch_is_read_per_account() {
    let (_directory, state) = state().await;
    encrypted_for_the_account(&state).await;
    state
        .store()
        .upsert_account(ACCOUNT, "Perso", ADDRESS)
        .expect("compte");
    state
        .store()
        .upsert_account("pro", "Pro", "roman@lavande.pro")
        .expect("compte");
    state
        .store()
        .set_pgp_enabled(ACCOUNT, false)
        .expect("interrupteur");

    assert!(state
        .keyring_for(ACCOUNT)
        .await
        .expect("trousseau")
        .is_empty());
    assert!(!state
        .keyring_for("pro")
        .await
        .expect("trousseau")
        .is_empty());
}
