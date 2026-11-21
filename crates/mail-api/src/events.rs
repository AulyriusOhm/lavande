//! Veille IDLE et diffusion des changements au front (SSE).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use futures::stream::{self, StreamExt};
use lavande_mail::config::{AccountConfig, FolderMapping};
use lavande_mail::imap::{self, ImapSession, SyncReport};
use lavande_mail::model::FolderRole;
use lavande_mail::store::Store;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::decision::{self, DecisionConfig};
use crate::dto::FolderReport;
use crate::state::AppState;
use crate::widget::WidgetMail;

const IDLE_WAIT: Duration = Duration::from_secs(540);
const RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// Combien de mails un événement porte au plus : le front en fait une
/// notification chacun, au-delà d'une poignée de mails c'est du bruit.
const NOTICE_CAP: usize = 5;

/// Plafond et bornes du triage automatique à l'arrivée IMAP IDLE.
const IDLE_TRIAGE_CAP: usize = 10;
const IDLE_TRIAGE_CONCURRENCY: usize = 3;
const IDLE_TRIAGE_TIMEOUT: Duration = Duration::from_secs(8);
const IDLE_TRIAGE_BATCH_TIMEOUT: Duration = Duration::from_secs(20);

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
    new_mail_notices_with_config(store, account, label, folder, uids, cap, None)
}

/// Variante enrichie avec la configuration du modèle de décision pour calculer
/// `should_notify` et embarquer catégorie, urgence et code TOTP dans le SSE.
pub fn new_mail_notices_with_config(
    store: &Store,
    account: &str,
    label: &str,
    folder: &str,
    uids: &[u32],
    cap: usize,
    decision_config: Option<&DecisionConfig>,
) -> Vec<WidgetMail> {
    let default_config = DecisionConfig::default();
    let cfg = decision_config.unwrap_or(&default_config);
    let mut notices: Vec<WidgetMail> = uids
        .iter()
        .filter_map(|uid| store.get_message(account, folder, *uid).ok().flatten())
        .map(|message| {
            let decision = store
                .get_decision(account, folder, message.uid)
                .ok()
                .flatten();
            WidgetMail {
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
                category: decision.as_ref().map(|d| d.category.clone()),
                urgency: decision.as_ref().map(|d| d.urgency),
                totp_code: decision.as_ref().and_then(|d| d.totp_code.clone()),
                totp_service: decision.as_ref().and_then(|d| d.totp_service.clone()),
                should_notify: decision.as_ref().map(|d| decision::should_notify(cfg, d)),
            }
        })
        .collect();
    notices.sort_by_key(|mail| std::cmp::Reverse(mail.date));
    notices.truncate(cap);
    notices
}

/// Trie en concurrence bornée (max 3 en parallèle, timeout strict) les derniers
/// messages reçus dans `INBOX` lorsque le modèle de décision est prêt. Une
/// erreur ou un timeout est silencieux : la synchro et le SSE ne bloquent jamais.
pub async fn triage_inbox_uids(
    state: &Arc<AppState>,
    account_id: &str,
    folder_path: &str,
    uids: &[u32],
) {
    if !folder_path.eq_ignore_ascii_case("INBOX") || uids.is_empty() {
        return;
    }
    let Ok(config) = state.decision_config() else {
        return;
    };
    let has_key = state.decision_api_key().await.ok().flatten().is_some();
    if !config.is_ready(has_key) {
        return;
    }

    let messages: Vec<_> = uids
        .iter()
        .rev()
        .take(IDLE_TRIAGE_CAP)
        .filter_map(|uid| {
            state
                .store()
                .get_message(account_id, folder_path, *uid)
                .ok()
                .flatten()
        })
        .collect();
    if messages.is_empty() {
        return;
    }

    let batch = stream::iter(messages).for_each_concurrent(IDLE_TRIAGE_CONCURRENCY, |msg| {
        let state = Arc::clone(state);
        async move {
            match tokio::time::timeout(
                IDLE_TRIAGE_TIMEOUT,
                decision::triage_message_with_timeout(
                    &state,
                    &msg,
                    &[],
                    false,
                    IDLE_TRIAGE_TIMEOUT,
                ),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    tracing::debug!(
                        account = %msg.account_id,
                        uid = msg.uid,
                        error = %error.message(),
                        "triage IDLE ignoré"
                    );
                }
                Err(_) => {
                    tracing::debug!(
                        account = %msg.account_id,
                        uid = msg.uid,
                        "triage IDLE expiré (timeout)"
                    );
                }
            }
        }
    });

    if tokio::time::timeout(IDLE_TRIAGE_BATCH_TIMEOUT, batch)
        .await
        .is_err()
    {
        tracing::debug!(account = %account_id, "lot de triage IDLE expiré");
    }
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
            if !report_changed(&report) {
                tracing::debug!(
                    account = %config.id,
                    folder = folder_path,
                    "veille réveillée sans changement"
                );
                return;
            }
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
            triage_inbox_uids(state, &config.id, folder_path, &report.preview_uids).await;
            let decision_config = state.decision_config().ok();
            let new_mails = new_mail_notices_with_config(
                state.store(),
                &config.id,
                &config.label,
                folder_path,
                &report.preview_uids,
                NOTICE_CAP,
                decision_config.as_ref(),
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

/// Whether the reconciliation moved anything. The watcher wakes on every
/// unsolicited response — including the `\Deleted` and `EXPUNGE` of a delete the
/// front is already showing optimistically — and an event published for a no-op
/// resync is a full list refetch that serves the row back before it is dropped.
fn report_changed(report: &SyncReport) -> bool {
    report.inserted > 0
        || report.removed > 0
        || report.flags_updated > 0
        || report.uidvalidity_changed
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
    fn a_resync_that_changed_nothing_publishes_nothing() {
        assert!(!report_changed(&SyncReport::default()));
        assert!(!report_changed(&SyncReport {
            uidnext: 1208,
            ..SyncReport::default()
        }));
    }

    #[test]
    fn a_resync_that_changed_anything_publishes() {
        let reports = [
            SyncReport {
                inserted: 1,
                ..SyncReport::default()
            },
            SyncReport {
                removed: 1,
                ..SyncReport::default()
            },
            SyncReport {
                flags_updated: 1,
                ..SyncReport::default()
            },
            SyncReport {
                uidvalidity_changed: true,
                ..SyncReport::default()
            },
        ];
        for report in reports {
            assert!(report_changed(&report), "{report:?}");
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

    #[test]
    fn notices_are_enriched_with_decisions_and_smart_should_notify() {
        use crate::decision::NotifFilterMode;
        use lavande_mail::store::MailDecision;
        use std::collections::HashMap;

        let store = store();
        store
            .upsert_message(&message(1, "Promo Flash", Some("Shop"), 1_731_000_060))
            .expect("promo");
        store
            .upsert_message(&message(2, "Code GitHub", Some("GitHub"), 1_731_000_120))
            .expect("totp");

        let promo_dec = MailDecision {
            account_id: "perso".into(),
            folder_path: "INBOX".into(),
            uid: 1,
            message_id: Some("<m1@x>".into()),
            content_hash: "h1".into(),
            schema_version: 1,
            model: "mammoth-1".into(),
            category: "promo".into(),
            category_conf: 0.96,
            category_probs: HashMap::new(),
            urgency: 0.2,
            needs_reply: 0.01,
            has_task: 0.0,
            has_event: 0.0,
            security: "safe".into(),
            security_conf: 0.99,
            cleanup_score: 0.95,
            assignee: None,
            assignee_conf: None,
            totp_code: None,
            totp_service: None,
            suggested_folder: None,
            suggested_folder_conf: None,
            decided_at: 1_731_000_065,
            source: "local".into(),
        };
        let mut totp_dec = promo_dec.clone();
        totp_dec.uid = 2;
        totp_dec.message_id = Some("<m2@x>".into());
        totp_dec.category = "auth_totp".into();
        totp_dec.urgency = 2.1;
        totp_dec.totp_code = Some("482917".into());
        totp_dec.totp_service = Some("GitHub".into());

        store.upsert_decision(&promo_dec).expect("upsert promo");
        store.upsert_decision(&totp_dec).expect("upsert totp");

        let cfg = DecisionConfig {
            notif_mode: NotifFilterMode::Smart,
            ..Default::default()
        };

        let notices =
            new_mail_notices_with_config(&store, "perso", "Perso", "INBOX", &[1, 2], 5, Some(&cfg));
        assert_eq!(notices.len(), 2);
        assert_eq!(notices[0].category.as_deref(), Some("auth_totp"));
        assert_eq!(notices[0].totp_code.as_deref(), Some("482917"));
        assert_eq!(notices[0].totp_service.as_deref(), Some("GitHub"));
        assert_eq!(notices[0].should_notify, Some(true));
        assert_eq!(notices[1].category.as_deref(), Some("promo"));
        assert_eq!(notices[1].should_notify, Some(false));
    }

    #[tokio::test]
    async fn triage_inbox_uids_silently_survives_unreachable_model() {
        use crate::discovery::DiscoveryEndpoints;
        use crate::secrets::SecretBackend;
        use lavande_mail::tls::TlsOptions;

        let dir = tempfile::tempdir().expect("tempdir");
        let state = Arc::new(
            AppState::open_with(
                dir.path(),
                TlsOptions::default(),
                DiscoveryEndpoints::default(),
                SecretBackend::File,
            )
            .await
            .expect("open"),
        );
        state
            .store()
            .upsert_account("perso", "Perso", "roman@lavande.fr")
            .expect("account");
        state
            .store()
            .upsert_folder(&Folder {
                account_id: "perso".into(),
                path: "INBOX".into(),
                name: "INBOX".into(),
                role: FolderRole::Inbox,
                uidvalidity: 1,
                uidnext: 2,
                last_sync_at: None,
                modseq: None,
                delimiter: Some("/".into()),
            })
            .expect("folder");
        state
            .store()
            .upsert_message(&message(1, "Test", Some("Marc"), 1_731_000_000))
            .expect("msg");
        state
            .save_decision_config(&DecisionConfig {
                enabled: true,
                endpoint: "http://127.0.0.1:9/v1/systemone".into(),
                model: "mammoth-1".into(),
                auth_header: crate::decision::DecisionAuthHeader::None,
                ..Default::default()
            })
            .expect("save cfg");

        triage_inbox_uids(&state, "perso", "INBOX", &[1]).await;
        assert!(state
            .store()
            .get_decision("perso", "INBOX", 1)
            .expect("query")
            .is_none());
    }
}
