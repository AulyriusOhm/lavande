//! Résumé des boîtes pour le widget Android d'écran d'accueil et la synchro de
//! fond (WorkManager). Rien de natif ici : `summarize` ne lit que le store déjà
//! synchronisé, `sync_and_summarize` ajoute la passe IMAP. Le pont JNI
//! (`src-tauri/src/sync_bridge.rs`) ne fait que sérialiser le résultat.

use std::sync::Arc;

use chrono::Utc;
use lavande_mail::config::FolderMapping;
use lavande_mail::error::MailError;
use lavande_mail::model::FolderRole;
use lavande_mail::store::Store;
use lavande_mail::sync as mail_sync;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

/// Dossier retenu quand le serveur n'a annoncé aucun rôle `inbox`.
const DEFAULT_INBOX: &str = "INBOX";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetAccount {
    pub id: String,
    pub label: String,
    pub unread: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetMail {
    pub account: String,
    pub label: String,
    pub subject: String,
    pub from: String,
    pub date: Option<i64>,
    pub unread: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetSummary {
    pub accounts: Vec<WidgetAccount>,
    pub mails: Vec<WidgetMail>,
    pub unread: usize,
    pub updated_at: i64,
}

impl WidgetSummary {
    fn empty() -> Self {
        Self {
            accounts: Vec::new(),
            mails: Vec::new(),
            unread: 0,
            updated_at: Utc::now().timestamp(),
        }
    }
}

/// Lit le store déjà synchronisé : INBOX de chaque compte (id, label fournis par
/// l'appelant). Un compte dont une lecture échoue est signalé et sauté, mais les
/// autres restent dans le résumé : le widget affiche ce qu'il peut.
pub fn summarize(
    store: &Store,
    accounts: &[(String, String)],
    mail_limit: usize,
) -> Result<WidgetSummary, MailError> {
    let mut summary = WidgetSummary::empty();
    for (id, label) in accounts {
        let folders = match store.list_folders(id) {
            Ok(folders) => folders,
            Err(error) => {
                tracing::warn!(account = %id, %error, "dossiers illisibles pour le widget");
                continue;
            }
        };
        let inbox = folders
            .iter()
            .find(|folder| folder.role == FolderRole::Inbox)
            .map(|folder| folder.path.clone())
            .unwrap_or_else(|| DEFAULT_INBOX.to_string());
        let counts = match store.folder_counts(id) {
            Ok(counts) => counts,
            Err(error) => {
                tracing::warn!(account = %id, %error, "compteurs illisibles pour le widget");
                continue;
            }
        };
        let unread = counts
            .iter()
            .find(|count| count.path == inbox)
            .map(|count| count.unread)
            .unwrap_or(0);
        // `limit <= 0` rendrait tout le dossier : 0 mail demandé, 0 lu.
        let threads = if mail_limit == 0 {
            Vec::new()
        } else {
            match store.threads_in_folder(id, &inbox, mail_limit as i64, 0) {
                Ok(threads) => threads,
                Err(error) => {
                    tracing::warn!(account = %id, %error, "mails illisibles pour le widget");
                    continue;
                }
            }
        };
        for thread in threads {
            summary.mails.push(WidgetMail {
                account: id.clone(),
                label: label.clone(),
                subject: thread.subject.clone(),
                from: match thread.primary.from.name.as_deref().map(str::trim) {
                    Some(name) if !name.is_empty() => name.to_string(),
                    _ => thread.primary.from.email.clone(),
                },
                date: thread.primary.date.map(|date| date.timestamp()),
                unread: thread.unread > 0,
            });
        }
        summary.accounts.push(WidgetAccount {
            id: id.clone(),
            label: label.clone(),
            unread,
        });
        summary.unread += unread;
    }
    // Plusieurs comptes se mêlent : le widget affiche les `mail_limit` plus
    // récents, toutes boîtes confondues.
    summary.mails.sort_by(|left, right| right.date.cmp(&left.date));
    summary.mails.truncate(mail_limit);
    Ok(summary)
}

/// Synchronise l'INBOX de chaque compte (erreurs collectées, jamais fatales)
/// puis résume. Le résumé est rendu même quand tous les comptes échouent : le
/// widget garde les compteurs déjà stockés.
pub async fn sync_and_summarize(
    state: &Arc<AppState>,
    mail_limit: usize,
) -> (WidgetSummary, Vec<String>) {
    let mut errors = Vec::new();
    let configs = match state.accounts().await {
        Ok(configs) => configs,
        Err(error) => {
            tracing::warn!(%error, "comptes illisibles pour la synchro de fond");
            return (
                WidgetSummary::empty(),
                vec![format!("comptes illisibles : {}", error.message())],
            );
        }
    };
    let mapping = FolderMapping::default();
    for config in &configs {
        let selection = match state.sync_folders(&config.id) {
            Ok(selection) => selection,
            Err(error) => {
                tracing::warn!(account = %config.id, %error, "dossiers à synchroniser illisibles");
                errors.push(format!("{} : {}", config.label, error.message()));
                continue;
            }
        };
        if let Err(error) = mail_sync::sync_account_selected(
            state.store(),
            config,
            &mapping,
            state.tls(),
            selection.as_deref(),
        )
        .await
        {
            tracing::warn!(account = %config.id, %error, "synchro de fond incomplète");
            errors.push(format!("{} : {error}", config.label));
        }
    }
    let accounts: Vec<(String, String)> = configs
        .iter()
        .map(|config| (config.id.clone(), config.label.clone()))
        .collect();
    let summary = match summarize(state.store(), &accounts, mail_limit) {
        Ok(summary) => summary,
        Err(error) => {
            tracing::warn!(%error, "résumé du widget indisponible");
            errors.push(format!("résumé indisponible : {error}"));
            WidgetSummary::empty()
        }
    };
    (summary, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use lavande_mail::model::{Address, Flags, Folder, Message, PgpState};

    fn store() -> Store {
        let store = Store::open_in_memory().expect("ouverture");
        store.migrate().expect("migration");
        store
            .upsert_account("perso", "Perso", "roman@lavande.fr")
            .expect("compte");
        store
    }

    fn folder(account: &str, path: &str, role: FolderRole) -> Folder {
        Folder {
            account_id: account.to_string(),
            path: path.to_string(),
            name: path.to_string(),
            role,
            uidvalidity: 1,
            uidnext: 1,
            last_sync_at: None,
            modseq: None,
            delimiter: Some("/".to_string()),
        }
    }

    fn message(
        account: &str,
        folder: &str,
        uid: u32,
        subject: &str,
        name: Option<&str>,
        date: Option<i64>,
        unread: bool,
    ) -> Message {
        Message {
            account_id: account.to_string(),
            folder_path: folder.to_string(),
            uid,
            uidvalidity: 1,
            thread_id: format!("t{uid}"),
            message_id: Some(format!("<m{uid}@x>")),
            in_reply_to: None,
            references: Vec::new(),
            from: Address {
                name: name.map(str::to_string),
                email: "marc@mail.fr".to_string(),
            },
            to: Vec::new(),
            cc: Vec::new(),
            subject: subject.to_string(),
            date: date.map(|seconds| Utc.timestamp_opt(seconds, 0).unwrap()),
            flags: Flags {
                unread,
                starred: false,
                answered: false,
            },
            size: 10,
            pgp: PgpState::None,
            pgp_detail: None,
            preview: String::new(),
            body_text: None,
            body_html: None,
            attachments: Vec::new(),
        }
    }

    fn accounts() -> Vec<(String, String)> {
        vec![("perso".to_string(), "Perso".to_string())]
    }

    #[test]
    fn unread_is_counted_from_inbox_only() {
        let store = store();
        store
            .upsert_folder(&folder("perso", "INBOX", FolderRole::Inbox))
            .expect("boîte");
        store
            .upsert_folder(&folder("perso", "Sent", FolderRole::Sent))
            .expect("envoyés");
        for uid in 1..=3 {
            store
                .upsert_message(&message(
                    "perso",
                    "INBOX",
                    uid,
                    &format!("Sujet {uid}"),
                    Some("Marc"),
                    Some(1_731_000_000 + i64::from(uid)),
                    uid != 3,
                ))
                .expect("mail");
        }
        store
            .upsert_message(&message(
                "perso",
                "Sent",
                9,
                "Réponse",
                Some("Marc"),
                Some(1_731_000_100),
                true,
            ))
            .expect("envoyé");

        let summary = summarize(&store, &accounts(), 5).expect("résumé");
        assert_eq!(summary.accounts.len(), 1);
        assert_eq!(summary.accounts[0].id, "perso");
        assert_eq!(summary.accounts[0].label, "Perso");
        assert_eq!(summary.accounts[0].unread, 2);
        assert_eq!(summary.unread, 2);
        assert_eq!(summary.mails.len(), 3);
    }

    #[test]
    fn mails_are_newest_first_and_limited() {
        let store = store();
        store
            .upsert_folder(&folder("perso", "INBOX", FolderRole::Inbox))
            .expect("boîte");
        for (uid, subject) in [(1, "Vieux"), (2, "Milieu"), (3, "Récent")] {
            store
                .upsert_message(&message(
                    "perso",
                    "INBOX",
                    uid,
                    subject,
                    Some("Marc"),
                    Some(1_731_000_000 + i64::from(uid) * 60),
                    true,
                ))
                .expect("mail");
        }

        let summary = summarize(&store, &accounts(), 2).expect("résumé");
        let subjects: Vec<&str> = summary.mails.iter().map(|mail| mail.subject.as_str()).collect();
        assert_eq!(subjects, vec!["Récent", "Milieu"]);
        assert_eq!(summary.mails[0].date, Some(1_731_000_180));
        assert!(summary.mails[0].unread);
        assert_eq!(summary.unread, 3);
    }

    #[test]
    fn from_falls_back_to_email() {
        let store = store();
        store
            .upsert_folder(&folder("perso", "INBOX", FolderRole::Inbox))
            .expect("boîte");
        store
            .upsert_message(&message(
                "perso",
                "INBOX",
                1,
                "Sans nom",
                None,
                Some(1_731_000_000),
                false,
            ))
            .expect("mail");

        let summary = summarize(&store, &accounts(), 5).expect("résumé");
        assert_eq!(summary.mails[0].from, "marc@mail.fr");
        assert!(!summary.mails[0].unread);
        assert_eq!(summary.mails[0].account, "perso");
        assert_eq!(summary.mails[0].label, "Perso");
    }

    #[test]
    fn empty_store_still_lists_the_account() {
        let store = store();
        let summary = summarize(&store, &accounts(), 3).expect("résumé");
        assert_eq!(
            summary.accounts,
            vec![WidgetAccount {
                id: "perso".to_string(),
                label: "Perso".to_string(),
                unread: 0,
            }]
        );
        assert!(summary.mails.is_empty());
        assert_eq!(summary.unread, 0);
    }

    /// La forme sérialisée est le contrat du pont JNI (`sync_bridge.rs`) et de
    /// `LavandeSyncWorker.kt` : clés et types figés.
    #[test]
    fn json_shape_matches_the_jni_contract() {
        let store = store();
        store
            .upsert_folder(&folder("perso", "INBOX", FolderRole::Inbox))
            .expect("boîte");
        store
            .upsert_message(&message(
                "perso",
                "INBOX",
                1,
                "Planning",
                Some("Marc"),
                Some(1_731_000_000),
                true,
            ))
            .expect("mail");

        let summary = summarize(&store, &accounts(), 3).expect("résumé");
        let value = serde_json::to_value(&summary).expect("json");
        assert_eq!(
            value,
            serde_json::json!({
                "accounts": [{"id": "perso", "label": "Perso", "unread": 1}],
                "mails": [{
                    "account": "perso",
                    "label": "Perso",
                    "subject": "Planning",
                    "from": "Marc",
                    "date": 1_731_000_000i64,
                    "unread": true,
                }],
                "unread": 1,
                "updated_at": value["updated_at"],
            })
        );
        assert!(value["updated_at"].as_i64().expect("horodatage") > 0);
    }
}
