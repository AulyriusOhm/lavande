//! `/api/accounts/{id}/search`: the local full-text index, narrowed by
//! structured filters and paged, completed by a server-side `UID SEARCH` when
//! the index falls short.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::NaiveDate;
use lavande_mail::config::AccountConfig;
use lavande_mail::error::MailError;
use lavande_mail::imap::{self, SearchCriteria};
use lavande_mail::model::{Folder, Message};
use lavande_mail::store::{SearchFilter, Store};
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

/// Un serveur lent ne retient pas la requête : passé ce délai, les résultats
/// locaux sont rendus tels quels.
const SERVER_TIMEOUT: Duration = Duration::from_secs(10);

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/accounts/{id}/search", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    folder: Option<String>,
    from: Option<String>,
    to: Option<String>,
    subject: Option<String>,
    unread: Option<String>,
    starred: Option<String>,
    has_attachment: Option<String>,
    before: Option<String>,
    after: Option<String>,
}

async fn search(
    Path(id): Path<String>,
    Query(params): Query<SearchQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Message>>, ApiError> {
    state.ensure_account(&id)?;
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = params.offset.unwrap_or(0);
    let unread = flag("unread", params.unread.as_deref())?;
    let starred = flag("starred", params.starred.as_deref())?;
    let has_attachment = flag("has_attachment", params.has_attachment.as_deref())?;
    let before = day("before", params.before.as_deref())?;
    let after = day("after", params.after.as_deref())?;
    let before_instant = start_of_day(before);
    let after_instant = start_of_day(after);
    let query = params.q.as_deref().unwrap_or("").trim();
    let filter = SearchFilter {
        q: query,
        folder: non_empty(params.folder.as_deref()),
        from: non_empty(params.from.as_deref()),
        to: non_empty(params.to.as_deref()),
        subject: non_empty(params.subject.as_deref()),
        unread,
        starred,
        has_attachment,
        before: before_instant.as_deref(),
        after: after_instant.as_deref(),
        limit: limit as i64,
        offset: offset as i64,
    };
    let mut messages = state.store().search(&id, &filter)?;
    let server_can_help = offset == 0
        && messages.len() < limit
        && has_attachment.is_none()
        && query.chars().count() >= MIN_SERVER_QUERY;
    if !server_can_help {
        return Ok(Json(messages));
    }
    let criteria = SearchCriteria {
        text: Some(query),
        subject: filter.subject,
        from: filter.from,
        to: filter.to,
        unread,
        starred,
        before,
        after,
    };
    match tokio::time::timeout(
        SERVER_TIMEOUT,
        server_search(&state, &id, &criteria, filter.folder, limit),
    )
    .await
    {
        Ok(found) => {
            messages = merge(messages, found, limit);
        }
        Err(_) => {
            tracing::warn!(account = %id, "recherche serveur : délai dépassé, résultats locaux seuls");
        }
    }
    Ok(Json(messages))
}

/// A boolean query parameter. Absent or empty is "no filter"; anything but
/// `true`/`false`/`1`/`0` is refused rather than silently ignored.
fn flag(name: &str, raw: Option<&str>) -> Result<Option<bool>, ApiError> {
    match raw {
        None | Some("") => Ok(None),
        Some("true") | Some("1") => Ok(Some(true)),
        Some("false") | Some("0") => Ok(Some(false)),
        Some(other) => Err(ApiError::bad_request(
            "search",
            format!("{name} : booléen attendu, reçu « {other} »"),
        )),
    }
}

/// A `YYYY-MM-DD` query parameter.
fn day(name: &str, raw: Option<&str>) -> Result<Option<NaiveDate>, ApiError> {
    match raw {
        None | Some("") => Ok(None),
        Some(raw) => NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map(Some)
            .map_err(|_| {
                ApiError::bad_request(
                    "search",
                    format!("{name} : date attendue au format AAAA-MM-JJ, reçu « {raw} »"),
                )
            }),
    }
}

/// The instant a `before`/`after` day starts at, in the RFC 3339 UTC shape the
/// store writes dates in.
fn start_of_day(day: Option<NaiveDate>) -> Option<String> {
    day.map(|day| format!("{}T00:00:00Z", day.format("%Y-%m-%d")))
}

fn non_empty(raw: Option<&str>) -> Option<&str> {
    raw.filter(|value| !value.is_empty())
}

/// The server-side fallback: `UID SEARCH` on the folders known to the store,
/// import of the headers of the UID it does not know, then a local re-read. Any
/// failure is best-effort — the local index stays the contract, the server is
/// only an enrichment.
async fn server_search(
    state: &AppState,
    account_id: &str,
    criteria: &SearchCriteria<'_>,
    folder: Option<&str>,
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
    let folders: Vec<Folder> = match folder {
        Some(path) => folders
            .into_iter()
            .filter(|known| known.path == path)
            .collect(),
        None => folders,
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
            criteria,
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

/// Searches one folder to the criteria, imports the headers of the UID the store
/// does not know yet, then re-reads the local rows. Returns the messages found
/// and how many server UID were handled.
async fn search_folder(
    session: &mut imap::ImapSession,
    store: &Store,
    tls: &TlsOptions,
    config: &AccountConfig,
    folder: &Folder,
    criteria: &SearchCriteria<'_>,
    budget: usize,
) -> Result<(Vec<Message>, usize), MailError> {
    let uids: Vec<u32> = imap::select_and_search(session, &folder.path, criteria)
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

/// Fuses the server hits into the local ones: one row per message (`message_id`
/// when it has one, `(folder_path, uid)` otherwise) and the local row wins, as
/// it carries the body and the attachments. Newest first, like the store, then
/// truncated to `limit`.
fn merge(local: Vec<Message>, found: Vec<Message>, limit: usize) -> Vec<Message> {
    let mut messages = local;
    let mut seen: HashSet<String> = messages.iter().map(dedup_key).collect();
    for message in found {
        if seen.insert(dedup_key(&message)) {
            messages.push(message);
        }
    }
    messages.sort_by(|left, right| right.date.cmp(&left.date).then(right.uid.cmp(&left.uid)));
    messages.truncate(limit);
    messages
}

fn dedup_key(message: &Message) -> String {
    match message.message_id.as_deref() {
        Some(message_id) if !message_id.is_empty() => message_id.to_string(),
        _ => format!("{}:{}", message.folder_path, message.uid),
    }
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

    /// The same message filed twice (INBOX and its archive) is one hit; the
    /// local copy is the one kept.
    #[test]
    fn a_known_message_id_is_deduplicated() {
        let mut archived = message("Archives", 7, 9);
        archived.message_id = Some("<m1@x>".to_string());
        let mut inbox = message("INBOX", 3, 10);
        inbox.message_id = Some("<m1@x>".to_string());
        let merged = merge(vec![inbox], vec![archived], 10);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].folder_path, "INBOX");
    }

    #[test]
    fn an_invalid_date_is_refused() {
        assert!(day("before", Some("2026-13-01")).is_err());
        assert!(day("after", Some("hier")).is_err());
        assert_eq!(
            day("after", Some("2026-03-04"))
                .expect("valide")
                .map(|day| { start_of_day(Some(day)).expect("instant") }),
            Some("2026-03-04T00:00:00Z".to_string())
        );
    }

    #[test]
    fn an_invalid_flag_is_refused() {
        assert!(flag("unread", Some("oui")).is_err());
        assert_eq!(flag("unread", Some("")).expect("vide"), None);
        assert_eq!(flag("starred", Some("false")).expect("faux"), Some(false));
    }
}
