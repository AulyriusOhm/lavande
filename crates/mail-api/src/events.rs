//! Veille IDLE et diffusion des changements au front (SSE).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use lavande_mail::config::{AccountConfig, FolderMapping};
use lavande_mail::imap::{self, ImapSession};
use lavande_mail::model::FolderRole;
use lavande_mail::store::Store;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::dto::FolderReport;
use crate::state::AppState;
use crate::widget::WidgetMail;

const IDLE_WAIT: Duration = Duration::from_secs(540);
const RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// Combien de mails un événement porte au plus : le front en fait une
/// notification chacun, au-delà d'une poignée de mails c'est du bruit.
const NOTICE_CAP: usize = 5;

#[derive(Clone, Debug, Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub account_id: String,
    pub folder_path: String,
    pub report: Option<FolderReport>,
    pub new_mails: Vec<WidgetMail>,
}

/// Les mails à notifier parmi les uid qui viennent d'arriver, du plus récent au
/// plus ancien. Un uid absent de la base est ignoré : l'aperçu d'un message
/// peut échouer sans que la synchro échoue.
pub fn new_mail_notices(
    store: &Store,
    account: &str,
    label: &str,
    folder: &str,
    uids: &[u32],
    cap: usize,
) -> Vec<WidgetMail> {
    let mut notices: Vec<WidgetMail> = uids
        .iter()
        .filter_map(|uid| store.get_message(account, folder, *uid).ok().flatten())
        .map(|message| WidgetMail {
            id: format!("{account}:{folder}:{}", message.uid),
            account: account.to_string(),
            label: label.to_string(),
            subject: message.subject.clone(),
            from: match message.from.name.as_deref().map(str::trim) {
                Some(name) if !name.is_empty() => name.to_string(),
                _ => message.from.email.clone(),
            },
            date: message.date.map(|date| date.timestamp()),
            unread: message.flags.unread,
            message_id: message.message_id.clone(),
        })
        .collect();
    notices.sort_by_key(|mail| std::cmp::Reverse(mail.date));
    notices.truncate(cap);
    notices
}

pub struct Events {
    sender: broadcast::Sender<Event>,
    watched: Mutex<HashSet<String>>,
}

impl Default for Events {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(64);
        Self {
            sender,
            watched: Mutex::new(HashSet::new()),
        }
    }
}

impl Events {
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.sender.subscribe()
    }

    pub fn publish(&self, event: Event) {
        let _ = self.sender.send(event);
    }

    fn claim(&self, account_id: &str) -> bool {
        let mut watched = self
            .watched
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        watched.insert(account_id.to_string())
    }
}

/// Démarre une veille par compte (une seule par compte) : IDLE sur INBOX, puis
/// synchro du dossier dès que le serveur signale du nouveau.
pub async fn watch_all(state: &Arc<AppState>) {
    let Ok(accounts) = state.accounts().await else {
        return;
    };
    for config in accounts {
        watch_account(state, config);
    }
}

pub fn watch_account(state: &Arc<AppState>, config: AccountConfig) {
    if !state.events().claim(&config.id) {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        tracing::info!(account = %config.id, "veille IDLE démarrée");
        loop {
            if let Err(error) = watch_once(&state, &config).await {
                tracing::debug!(account = %config.id, error = %error, "veille interrompue");
                tokio::time::sleep(RECONNECT_DELAY).await;
            }
        }
    });
}

async fn watch_once(state: &Arc<AppState>, config: &AccountConfig) -> Result<(), String> {
    let mut session = imap::connect_with(config, state.tls())
        .await
        .map_err(|error| error.to_string())?;
    session
        .select("INBOX")
        .await
        .map_err(|error| error.to_string())?;

    loop {
        let mut handle = session.idle();
        handle.init().await.map_err(|error| error.to_string())?;
        let outcome = {
            let (waiting, _stop) = handle.wait_with_timeout(IDLE_WAIT);
            waiting.await
        };
        let response = outcome.map_err(|error| error.to_string())?;
        let session_back = handle.done().await.map_err(|error| error.to_string())?;
        session = session_back;

        match response {
            IdleResponse::NewData(_) => {
                sync_and_publish(state, config, &mut session, "INBOX").await;
            }
            IdleResponse::Timeout => continue,
            IdleResponse::ManualInterrupt => return Ok(()),
        }
    }
}

async fn sync_and_publish(
    state: &Arc<AppState>,
    config: &AccountConfig,
    session: &mut ImapSession,
    folder_path: &str,
) {
    let mapping = FolderMapping::default();
    match imap::sync_folder(session, state.store(), &config.id, folder_path, &mapping).await {
        Ok(report) => {
            imap::fetch_previews(
                config,
                state.tls(),
                state.store(),
                &config.id,
                folder_path,
                &report.preview_uids,
            )
            .await;
            tracing::info!(
                account = %config.id,
                inserted = report.inserted,
                removed = report.removed,
                "nouveau courrier détecté"
            );
            let new_mails = new_mail_notices(
                state.store(),
                &config.id,
                &config.label,
                folder_path,
                &report.preview_uids,
                NOTICE_CAP,
            );
            state.events().publish(Event {
                kind: "folder-updated",
                account_id: config.id.clone(),
                folder_path: folder_path.to_string(),
                report: Some(FolderReport::new(folder_path.to_string(), report)),
                new_mails,
            });
        }
        Err(error) => {
            tracing::warn!(account = %config.id, error = %error, "synchro IDLE impossible")
        }
    }
}

/// Rôles à surveiller quand un compte arrive : l'INBOX d'abord, c'est ce que
/// l'UI affiche au démarrage.
pub fn watched_role() -> FolderRole {
    FolderRole::Inbox
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use lavande_mail::model::{Address, Flags, Folder, FolderRole, Message, PgpState};

    fn store() -> Store {
        let store = Store::open_in_memory().expect("ouverture");
        store.migrate().expect("migration");
        store
            .upsert_account("perso", "Perso", "roman@lavande.fr")
            .expect("compte");
        store
            .upsert_folder(&Folder {
                account_id: "perso".to_string(),
                path: "INBOX".to_string(),
                name: "INBOX".to_string(),
                role: FolderRole::Inbox,
                uidvalidity: 1,
                uidnext: 1,
                last_sync_at: None,
                modseq: None,
                delimiter: Some("/".to_string()),
            })
            .expect("boîte");
        store
    }

    fn message(uid: u32, subject: &str, name: Option<&str>, date: i64) -> Message {
        Message {
            account_id: "perso".to_string(),
            folder_path: "INBOX".to_string(),
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
            date: Some(Utc.timestamp_opt(date, 0).unwrap()),
            flags: Flags {
                unread: true,
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

    #[test]
    fn notices_carry_the_fields_the_front_notifies() {
        let store = store();
        store
            .upsert_message(&message(7, "Planning", Some("Marc"), 1_731_000_000))
            .expect("mail");

        let notices = new_mail_notices(&store, "perso", "Perso", "INBOX", &[7], 5);

        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].id, "perso:INBOX:7");
        assert_eq!(notices[0].account, "perso");
        assert_eq!(notices[0].label, "Perso");
        assert_eq!(notices[0].from, "Marc");
        assert_eq!(notices[0].subject, "Planning");
        assert_eq!(notices[0].date, Some(1_731_000_000));
        assert!(notices[0].unread);
        assert_eq!(notices[0].message_id.as_deref(), Some("<m7@x>"));
    }

    #[test]
    fn from_falls_back_to_the_email() {
        let store = store();
        store
            .upsert_message(&message(7, "Sans nom", None, 1_731_000_000))
            .expect("mail");

        let notices = new_mail_notices(&store, "perso", "Perso", "INBOX", &[7], 5);

        assert_eq!(notices[0].from, "marc@mail.fr");
    }

    #[test]
    fn notices_are_newest_first_and_capped() {
        let store = store();
        for uid in 1..=4 {
            store
                .upsert_message(&message(
                    uid,
                    &format!("Sujet {uid}"),
                    Some("Marc"),
                    1_731_000_000 + i64::from(uid) * 60,
                ))
                .expect("mail");
        }

        let notices = new_mail_notices(&store, "perso", "Perso", "INBOX", &[1, 2, 3, 4], 2);

        let subjects: Vec<&str> = notices.iter().map(|mail| mail.subject.as_str()).collect();
        assert_eq!(subjects, vec!["Sujet 4", "Sujet 3"]);
    }

    #[test]
    fn unknown_uids_are_skipped() {
        let store = store();
        store
            .upsert_message(&message(7, "Connu", Some("Marc"), 1_731_000_000))
            .expect("mail");

        let notices = new_mail_notices(&store, "perso", "Perso", "INBOX", &[7, 8], 5);

        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].subject, "Connu");
    }

    #[test]
    fn empty_uids_give_no_notice() {
        let store = store();
        assert!(new_mail_notices(&store, "perso", "Perso", "INBOX", &[], 5).is_empty());
    }
}
