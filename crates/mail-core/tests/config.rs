use lavande_mail::config::{
    folder_role, leaf_name, path_for, AccountConfig, AuthConfig, Encryption, Endpoint,
    FolderMapping,
};
use lavande_mail::model::FolderRole;

fn flags(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn endpoint(encryption: Encryption) -> Endpoint {
    Endpoint {
        host: "mail.lavande.fr".to_string(),
        port: 993,
        encryption,
    }
}

fn account(encryption: Encryption) -> AccountConfig {
    AccountConfig {
        id: "perso".to_string(),
        label: "Perso".to_string(),
        email: "roman@lavande.fr".to_string(),
        username: "roman@lavande.fr".to_string(),
        imap: endpoint(encryption),
        smtp: Endpoint {
            host: "mail.lavande.fr".to_string(),
            port: 465,
            encryption,
        },
        synced_folders: None,
        auth: AuthConfig::Password {
            password: "hunter2".to_string(),
        },
    }
}

#[test]
fn special_use_wins_over_the_name() {
    assert_eq!(
        folder_role("[Gmail]/Important", "Important", &flags(&["\\Sent"])),
        FolderRole::Sent
    );
    assert_eq!(
        folder_role("Divers", "Divers", &flags(&["Inbox"])),
        FolderRole::Inbox
    );
    assert_eq!(
        folder_role("Divers", "Divers", &flags(&["Junk"])),
        FolderRole::Spam
    );
    assert_eq!(
        folder_role("Divers", "Divers", &flags(&["Trash"])),
        FolderRole::Trash
    );
    assert_eq!(
        folder_role("Divers", "Divers", &flags(&["Archive"])),
        FolderRole::Archive
    );
    assert_eq!(
        folder_role("Divers", "Divers", &flags(&["Drafts"])),
        FolderRole::Drafts
    );
}

#[test]
fn english_names_are_recognized() {
    assert_eq!(folder_role("INBOX", "INBOX", &[]), FolderRole::Inbox);
    assert_eq!(
        folder_role("Sent Items", "Sent Items", &[]),
        FolderRole::Sent
    );
    assert_eq!(
        folder_role("Deleted Items", "Deleted Items", &[]),
        FolderRole::Trash
    );
    assert_eq!(folder_role("Junk E-mail", "Junk", &[]), FolderRole::Spam);
    assert_eq!(folder_role("Drafts", "Drafts", &[]), FolderRole::Drafts);
    assert_eq!(
        folder_role("[Gmail]/Sent Mail", "Sent Mail", &[]),
        FolderRole::Sent
    );
}

#[test]
fn french_names_are_recognized() {
    assert_eq!(
        folder_role("Boîte de réception", "Boîte de réception", &[]),
        FolderRole::Inbox
    );
    assert_eq!(folder_role("Envoyés", "Envoyés", &[]), FolderRole::Sent);
    assert_eq!(
        folder_role("Éléments envoyés", "Éléments envoyés", &[]),
        FolderRole::Sent
    );
    assert_eq!(
        folder_role("Brouillons", "Brouillons", &[]),
        FolderRole::Drafts
    );
    assert_eq!(
        folder_role("Archives", "Archives", &[]),
        FolderRole::Archive
    );
    assert_eq!(
        folder_role("Corbeille", "Corbeille", &[]),
        FolderRole::Trash
    );
    assert_eq!(
        folder_role("Indésirables", "Indésirables", &[]),
        FolderRole::Spam
    );
}

#[test]
fn unknown_folders_stay_other() {
    assert_eq!(
        folder_role("Projets/2026", "2026", &flags(&["\\NoSelect"])),
        FolderRole::Other
    );
    assert_eq!(leaf_name("[Gmail]/Sent Mail"), "Sent Mail");
    assert_eq!(leaf_name("INBOX"), "INBOX");
}

#[test]
fn path_for_reads_the_mapping() {
    let mapping = FolderMapping {
        inbox: Some("INBOX".to_string()),
        sent: Some("Envoyés".to_string()),
        drafts: None,
        archive: None,
        trash: Some("Corbeille".to_string()),
        spam: None,
    };
    assert_eq!(path_for(&mapping, FolderRole::Inbox), Some("INBOX"));
    assert_eq!(path_for(&mapping, FolderRole::Sent), Some("Envoyés"));
    assert_eq!(path_for(&mapping, FolderRole::Trash), Some("Corbeille"));
    assert_eq!(path_for(&mapping, FolderRole::Drafts), None);
    assert_eq!(path_for(&mapping, FolderRole::Other), None);
}

#[test]
fn validate_accepts_tls_and_starttls() {
    account(Encryption::Tls).validate().expect("tls");
    account(Encryption::StartTls).validate().expect("starttls");
}

#[test]
fn validate_rejects_plaintext() {
    let imap = account(Encryption::Plain);
    assert!(imap.validate().is_err());
    let mut smtp = account(Encryption::Tls);
    smtp.smtp.encryption = Encryption::Plain;
    assert!(smtp.validate().is_err());
}

#[test]
fn validate_rejects_empty_fields() {
    let mut no_email = account(Encryption::Tls);
    no_email.email.clear();
    assert!(no_email.validate().is_err());

    let mut no_host = account(Encryption::Tls);
    no_host.imap.host.clear();
    assert!(no_host.validate().is_err());

    let mut no_port = account(Encryption::Tls);
    no_port.smtp.port = 0;
    assert!(no_port.validate().is_err());

    let mut no_user = account(Encryption::Tls);
    no_user.username.clear();
    assert!(no_user.validate().is_err());

    let mut no_password = account(Encryption::Tls);
    no_password.auth = AuthConfig::Password {
        password: String::new(),
    };
    assert!(no_password.validate().is_err());
}

#[test]
fn debug_never_prints_secrets() {
    let password = AuthConfig::Password {
        password: "hunter2".to_string(),
    };
    assert!(!format!("{password:?}").contains("hunter2"));

    let oauth = AuthConfig::OAuth2 {
        client_id: "client-id".to_string(),
        client_secret: "client-secret-value".to_string(),
        refresh_token: "refresh-token-value".to_string(),
        token_endpoint: "https://oauth.example/token".to_string(),
    };
    let debug = format!("{oauth:?}");
    assert!(!debug.contains("client-secret-value"));
    assert!(!debug.contains("refresh-token-value"));
    assert!(debug.contains("client-id"));

    let mut account = account(Encryption::Tls);
    account.auth = oauth;
    assert!(!format!("{account:?}").contains("refresh-token-value"));
}
