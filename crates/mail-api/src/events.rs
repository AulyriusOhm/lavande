//! Veille IDLE et diffusion des changements au front (SSE).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use lavande_mail::config::{AccountConfig, FolderMapping};
use lavande_mail::imap::{self, ImapSession};
use lavande_mail::model::FolderRole;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::dto::FolderReport;
use crate::state::AppState;

const IDLE_WAIT: Duration = Duration::from_secs(540);
const RECONNECT_DELAY: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub account_id: String,
    pub folder_path: String,
    pub report: Option<FolderReport>,
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
pub fn watch_all(state: &Arc<AppState>) {
    let Ok(accounts) = state.accounts() else {
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
            tracing::info!(
                account = %config.id,
                inserted = report.inserted,
                removed = report.removed,
                "nouveau courrier détecté"
            );
            state.events().publish(Event {
                kind: "folder-updated",
                account_id: config.id.clone(),
                folder_path: folder_path.to_string(),
                report: Some(FolderReport::new(folder_path.to_string(), report)),
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
