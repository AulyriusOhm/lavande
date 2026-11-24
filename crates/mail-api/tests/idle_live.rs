//! IDLE réel : un message déposé sur le serveur déclenche une synchro et un
//! événement SSE, sans que personne n'ait cliqué sur « Synchroniser ».

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use lavande_mail::config::{AccountConfig, AuthConfig, Encryption, Endpoint, FolderMapping};
use lavande_mail::model::Address;
use lavande_mail::smtp::{self, OutgoingMessage};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::events;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use tempfile::TempDir;

fn tls() -> TlsOptions {
    let path = std::env::var("MAIL_TEST_TLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").expect("HOME")).join(".cache/lavande/mail-test")
        });
    TlsOptions {
        extra_roots_pem: vec![fs::read(path.join("cert.pem")).expect("certificat de test")],
    }
}

fn account() -> AccountConfig {
    AccountConfig {
        id: "idle".to_string(),
        label: "GreenMail".to_string(),
        email: "roman@lavande.test".to_string(),
        username: "roman@lavande.test".to_string(),
        imap: Endpoint {
            host: "localhost".to_string(),
            port: 3993,
            encryption: Encryption::Tls,
        },
        smtp: Endpoint {
            host: "localhost".to_string(),
            port: 3465,
            encryption: Encryption::Tls,
        },
        synced_folders: None,
        ai_folders: None,
        auth: AuthConfig::Password {
            password: "secret".to_string(),
        },
    }
}

#[tokio::test]
#[ignore = "requires scripts/mail-test-server.sh start"]
async fn idle_pushes_new_mail_without_a_manual_sync() {
    let directory = tempfile::tempdir().expect("répertoire temporaire");
    let state = Arc::new(
        AppState::open_with(
            directory.path(),
            tls(),
            Default::default(),
            SecretBackend::File,
        )
        .await
        .expect("état"),
    );
    let config = account();
    let _: TempDir = directory;

    let folders = {
        let mut session = lavande_mail::imap::connect_with(&config, &tls())
            .await
            .expect("connexion");
        lavande_mail::imap::list_folders(&mut session, &config.id)
            .await
            .expect("dossiers")
    };
    state.add_account(&config, &folders).await.expect("compte");
    let mut receiver = state.events().subscribe();
    events::watch_account(&state, config.clone());

    tokio::time::sleep(Duration::from_secs(2)).await;
    let message = OutgoingMessage {
        from: Address {
            name: Some("Idle".to_string()),
            email: config.email.clone(),
        },
        to: vec![Address {
            name: None,
            email: config.email.clone(),
        }],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: format!(
            "idle {}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("horloge")
                .as_millis()
        ),
        text: "message poussé par IDLE".to_string(),
        html: None,
        in_reply_to: None,
        references: Vec::new(),
        attachments: Vec::new(),
        pgp_sign: false,
        pgp_encrypt: false,
    };
    smtp::send_with(&config, &message, &tls())
        .await
        .expect("envoi smtp");

    let event = tokio::time::timeout(Duration::from_secs(60), receiver.recv())
        .await
        .expect("événement IDLE attendu dans la minute")
        .expect("canal ouvert");
    assert_eq!(event.kind, "folder-updated");
    assert_eq!(event.folder_path, "INBOX");
    assert!(
        event
            .report
            .as_ref()
            .is_some_and(|report| report.inserted >= 1),
        "{:?}",
        event.report
    );

    let mapping = FolderMapping::default();
    let threads = state
        .store()
        .threads_in_folder(&config.id, "INBOX", -1, 0)
        .expect("fils");
    assert!(!threads.is_empty(), "{mapping:?}");
}
