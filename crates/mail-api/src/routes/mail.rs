//! `/api/accounts/{id}/…`: sync, threads, messages, flags, move, send.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use lavande_mail::config::FolderMapping;
use lavande_mail::imap::{self, ImapSession};
use lavande_mail::model::{Address, Flags, Message, Thread};
use lavande_mail::smtp;
use lavande_mail::sync as mail_sync;
use serde::Deserialize;

use crate::dto::{
    ApiJson, FlagsRequest, FolderReport, MoveRequest, SendRequest, SyncRequest, SyncResponse,
};
use crate::error::ApiError;
use crate::state::AppState;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/accounts/{id}/sync", post(sync))
        .route("/api/accounts/{id}/folders/{path}/threads", get(threads))
        .route(
            "/api/accounts/{id}/folders/{path}/messages/{uid}",
            get(message),
        )
        .route("/api/accounts/{id}/flags", post(set_flags))
        .route("/api/accounts/{id}/move", post(move_message))
        .route("/api/accounts/{id}/send", post(send))
}

#[derive(Deserialize)]
struct Paging {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
struct MessageQuery {
    #[serde(default)]
    fetch_body: bool,
}

async fn sync(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<SyncResponse>, ApiError> {
    let request: SyncRequest = if body.is_empty() {
        SyncRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|error| {
            ApiError::bad_request("config", format!("corps de la requête refusé : {error}"))
        })?
    };
    let config = state.account(&id)?;
    let mapping = FolderMapping::default();
    let reports: Vec<FolderReport> = match request.folder_path {
        Some(folder_path) => {
            let mut session = imap::connect_with(&config, state.tls()).await?;
            let report = imap::sync_folder(
                &mut session,
                state.store(),
                &config.id,
                &folder_path,
                &mapping,
            )
            .await?;
            logout(session).await;
            vec![FolderReport::new(folder_path, report)]
        }
        None => mail_sync::sync_account_with(state.store(), &config, &mapping, state.tls())
            .await?
            .into_iter()
            .map(|(folder_path, report)| FolderReport::new(folder_path, report))
            .collect(),
    };
    tracing::info!(account = %id, folders = reports.len(), "synchro terminée");
    Ok(Json(SyncResponse { reports }))
}

async fn threads(
    Path((id, folder_path)): Path<(String, String)>,
    Query(paging): Query<Paging>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Thread>>, ApiError> {
    state.account(&id)?;
    let limit = paging.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = paging.offset.unwrap_or(0);
    let threads = state.store().threads_in_folder(&id, &folder_path)?;
    Ok(Json(threads.into_iter().skip(offset).take(limit).collect()))
}

async fn message(
    Path((id, folder_path, uid)): Path<(String, String, u32)>,
    Query(query): Query<MessageQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Message>, ApiError> {
    let config = state.account(&id)?;
    let stored = state
        .store()
        .get_message(&id, &folder_path, uid)?
        .ok_or_else(|| unknown(&id, &folder_path, uid))?;
    let body_missing = stored.body_text.is_none() && stored.body_html.is_none();
    if !query.fetch_body || !body_missing {
        return Ok(Json(stored));
    }

    let mut session = imap::connect_with(&config, state.tls()).await?;
    imap::fetch_body(&mut session, state.store(), &id, &folder_path, uid).await?;
    logout(session).await;
    let message = state
        .store()
        .get_message(&id, &folder_path, uid)?
        .ok_or_else(|| unknown(&id, &folder_path, uid))?;
    Ok(Json(message))
}

/// The server is written first: a refused `UID STORE` leaves the store alone.
async fn set_flags(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<FlagsRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id)?;
    let stored = state
        .store()
        .get_message(&id, &request.folder_path, request.uid)?
        .ok_or_else(|| unknown(&id, &request.folder_path, request.uid))?;
    let flags = Flags {
        unread: request.unread,
        starred: request.starred,
        answered: stored.flags.answered,
    };

    let mut session = imap::connect_with(&config, state.tls()).await?;
    imap::set_flags(&mut session, &request.folder_path, request.uid, &flags).await?;
    logout(session).await;
    state
        .store()
        .set_flags(&id, &request.folder_path, request.uid, &flags)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn move_message(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<MoveRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id)?;
    let mut session = imap::connect_with(&config, state.tls()).await?;
    imap::move_message(
        &mut session,
        state.store(),
        &id,
        &request.from_path,
        request.uid,
        &request.to_path,
    )
    .await?;
    logout(session).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn send(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<SendRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id)?;
    let outgoing = request.into_outgoing(Address {
        name: None,
        email: config.email.clone(),
    })?;
    smtp::send_with(&config, &outgoing, state.tls()).await?;
    tracing::info!(account = %id, "message envoyé");
    Ok(StatusCode::NO_CONTENT)
}

async fn logout(mut session: ImapSession) {
    if let Err(error) = session.logout().await {
        tracing::debug!(error = %error, "fermeture de la session imap");
    }
}

fn unknown(account_id: &str, folder_path: &str, uid: u32) -> ApiError {
    ApiError::not_found(format!(
        "message {uid} introuvable dans « {folder_path} » du compte « {account_id} »"
    ))
}
