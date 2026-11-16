//! `/api/accounts/{id}/search`: local full-text-ish search across every folder,
//! completed by a server-side `UID SEARCH TEXT` when the store falls short.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use lavande_mail::config::AccountConfig;
use lavande_mail::error::MailError;
use lavande_mail::imap;
use lavande_mail::model::{Folder, Message};
use lavande_mail::store::Store;
use lavande_mail::tls::TlsOptions;
use serde::Deserialize;

use crate::error::ApiError;
use crate::state::AppState;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

/// En dessous, le serveur n'est pas interrogé : un ou deux caractères
/// ramèneraient la moitié de la boîte.
const MIN_SERVER_QUERY: usize = 3;

/// Le repli serveur ne traite jamais plus de `SERVER_BUDGET × limit` UID.
const SERVER_BUDGET: usize = 2;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/accounts/{id}/search", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<usize>,
}

async fn search(
    Path(id): Path<String>,
    Query(query): Query<SearchQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Message>>, ApiError> {
    state.ensure_account(&id)?;
    let trimmed = query.q.trim();
    if trimmed.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut messages = state.store().search_messages(&id, trimmed, limit as i64)?;
    if messages.len() < limit && trimmed.chars().count() >= MIN_SERVER_QUERY {
        let found = server_search(&state, &id, trimmed, limit).await;
        messages = merge(messages, found, limit);
    }
    Ok(Json(messages))
}

/// Le repli serveur : `UID SEARCH TEXT` sur chaque dossier connu du compte,
/// import des en-têtes des UID que le store ignore, puis relecture locale. Tout
/// échec est best-effort — la recherche locale reste le contrat, le serveur
/// n'est qu'un enrichissement.
async fn server_search(
    state: &AppState,
    account_id: &str,
    query: &str,
    limit: usize,
) -> Vec<Message> {
    let store = state.store();
    let config = match state.account(account_id).await {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(account = account_id, %error, "recherche serveur : compte illisible");
            return Vec::new();
        }
    };
    let folders = match store.list_folders(account_id) {
        Ok(folders) => folders,
        Err(error) => {
            tracing::warn!(account = account_id, %error, "recherche serveur : dossiers illisibles");
            return Vec::new();
        }
    };
    if folders.is_empty() {
        return Vec::new();
    }
    let mut session = match imap::connect_with(&config, state.tls()).await {
        Ok(session) => session,
        Err(error) => {
            tracing::warn!(account = account_id, %error, "recherche serveur : connexion impossible");
            return Vec::new();
        }
    };
    let mut found = Vec::new();
    let mut budget = limit.saturating_mul(SERVER_BUDGET);
    for folder in &folders {
        if budget == 0 {
            break;
        }
        let searched = search_folder(
            &mut session,
            store,
            state.tls(),
            &config,
            folder,
            query,
            budget,
        )
        .await;
        match searched {
            Ok((messages, uids)) => {
                budget = budget.saturating_sub(uids);
                found.extend(messages);
            }
            Err(error) => {
                tracing::warn!(account = account_id, folder = %folder.path, %error, "dossier non cherché côté serveur");
                // Une réponse que le client n'a pas su lire laisse la session
                // désalignée : le dossier suivant repart d'une connexion neuve.
                session = match imap::connect_with(&config, state.tls()).await {
                    Ok(session) => session,
                    Err(error) => {
                        tracing::warn!(account = account_id, %error, "recherche serveur : reconnexion impossible");
                        return found;
                    }
                };
            }
        }
    }
    if let Err(error) = session.logout().await {
        tracing::warn!(%error, "fermeture de la session imap (recherche)");
    }
    found
}

/// Cherche `query` dans un dossier, importe les en-têtes des UID que le store ne
/// connaît pas encore, puis relit les lignes locales. Rend les messages trouvés
/// et le nombre d'UID serveur traités.
async fn search_folder(
    session: &mut imap::ImapSession,
    store: &Store,
    tls: &TlsOptions,
    config: &AccountConfig,
    folder: &Folder,
    query: &str,
    budget: usize,
) -> Result<(Vec<Message>, usize), MailError> {
    let uids: Vec<u32> = imap::select_and_search(session, &folder.path, query)
        .await?
        .into_iter()
        .take(budget)
        .collect();
    if uids.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let known = store.flags_in_folder(&config.id, &folder.path)?;
    let missing: Vec<u32> = uids
        .iter()
        .copied()
        .filter(|uid| !known.contains_key(uid))
        .collect();
    if !missing.is_empty() {
        imap::import_headers(
            session,
            store,
            &config.id,
            &folder.path,
            folder.uidvalidity,
            &missing,
        )
        .await?;
        imap::fetch_previews(config, tls, store, &config.id, &folder.path, &missing).await;
    }
    let mut messages = Vec::new();
    for uid in &uids {
        if let Some(message) = store.get_message(&config.id, &folder.path, *uid)? {
            messages.push(message);
        }
    }
    Ok((messages, uids.len()))
}

/// Fusionne les résultats serveur dans les résultats locaux : dédoublonne par
/// `(folder_path, uid)`, trie du plus récent au plus ancien comme le store, et
/// tronque à `limit`.
fn merge(local: Vec<Message>, found: Vec<Message>, limit: usize) -> Vec<Message> {
    let mut messages = local;
    let mut seen: HashSet<(String, u32)> = messages
        .iter()
        .map(|message| (message.folder_path.clone(), message.uid))
        .collect();
    for message in found {
        if seen.insert((message.folder_path.clone(), message.uid)) {
            messages.push(message);
        }
    }
    messages.sort_by(|left, right| right.date.cmp(&left.date).then(right.uid.cmp(&left.uid)));
    messages.truncate(limit);
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use lavande_mail::model::{Address, Flags, PgpState};

    fn message(folder_path: &str, uid: u32, day: u32) -> Message {
        Message {
            account_id: "perso".to_string(),
            folder_path: folder_path.to_string(),
            uid,
            uidvalidity: 1,
            thread_id: format!("t{uid}"),
            message_id: None,
            in_reply_to: None,
            references: Vec::new(),
            from: Address::default(),
            to: Vec::new(),
            cc: Vec::new(),
            subject: String::new(),
            date: Utc.with_ymd_and_hms(2026, 1, day, 12, 0, 0).single(),
            flags: Flags::default(),
            size: 0,
            pgp: PgpState::None,
            pgp_detail: None,
            preview: String::new(),
            body_text: None,
            body_html: None,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn server_hits_are_deduplicated_sorted_and_truncated() {
        let local = vec![message("INBOX", 5, 10)];
        let found = vec![
            message("INBOX", 5, 10),
            message("Sent", 2, 12),
            message("INBOX", 9, 11),
        ];
        let merged = merge(local, found, 2);
        let keys: Vec<(String, u32)> = merged
            .iter()
            .map(|message| (message.folder_path.clone(), message.uid))
            .collect();
        assert_eq!(keys, [("Sent".to_string(), 2), ("INBOX".to_string(), 9),]);
    }

    #[test]
    fn the_local_row_wins_over_the_server_one() {
        let mut local = message("INBOX", 5, 10);
        local.body_text = Some("corps local".to_string());
        let merged = merge(vec![local], vec![message("INBOX", 5, 10)], 10);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].body_text.as_deref(), Some("corps local"));
    }
}
