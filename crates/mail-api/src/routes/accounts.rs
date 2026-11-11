//! `/api/accounts`: listing, connection-tested creation, renaming, deletion,
//! folders, and the local purge of one folder.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use lavande_mail::config::AccountConfig;
use lavande_mail::imap;
use lavande_mail::model::Folder;

use crate::config_file::StoredAccount;
use crate::dto::{AccountSummary, ApiJson, RenameRequest};
use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/accounts", get(list).post(add))
        .route("/api/accounts/{id}", delete(remove).patch(rename))
        .route("/api/accounts/{id}/folders", get(folders))
        .route("/api/accounts/{id}/folders/{path}/local", delete(desync))
}

async fn list(State(state): State<Arc<AppState>>) -> Result<Json<Vec<AccountSummary>>, ApiError> {
    let accounts = state.stored_accounts()?;
    let mut summaries = Vec::with_capacity(accounts.len());
    for config in &accounts {
        let folders = state.store().list_folders(&config.id)?.len();
        summaries.push(AccountSummary::new(config, folders));
    }
    Ok(Json(summaries))
}

async fn add(
    State(state): State<Arc<AppState>>,
    ApiJson(config): ApiJson<AccountConfig>,
) -> Result<(StatusCode, Json<AccountSummary>), ApiError> {
    config.validate()?;
    if state
        .stored_accounts()?
        .iter()
        .any(|known| known.id == config.id)
    {
        return Err(ApiError::conflict(
            "config",
            format!("le compte « {} » existe déjà", config.id),
        ));
    }

    let folders = probe(&state, &config).await?;
    state.add_account(&config, &folders).await?;
    crate::events::watch_account(&state, config.clone());
    tracing::info!(account = %config.id, folders = folders.len(), "compte ajouté");
    Ok((
        StatusCode::CREATED,
        Json(AccountSummary::new(
            &StoredAccount::from_config(&config),
            folders.len(),
        )),
    ))
}

/// The connection test: nothing is stored unless the server answers.
async fn probe(state: &AppState, config: &AccountConfig) -> Result<Vec<Folder>, ApiError> {
    let mut session = imap::connect_with(config, state.tls()).await?;
    let folders = imap::list_folders(&mut session, &config.id).await?;
    if let Err(error) = session.logout().await {
        tracing::debug!(error = %error, "fermeture de la session imap");
    }
    Ok(folders)
}

async fn remove(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let known = state.remove_account(&id).await?;
    let deleted = state.store().delete_account(&id)?;
    if !known && deleted == 0 {
        return Err(ApiError::not_found(format!("compte « {id} » inconnu")));
    }
    tracing::info!(account = %id, rows = deleted, "compte supprimé");
    Ok(StatusCode::NO_CONTENT)
}

async fn folders(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Folder>>, ApiError> {
    state.ensure_account(&id)?;
    Ok(Json(state.store().list_folders(&id)?))
}

/// Changes the label of an account and nothing else.
async fn rename(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<RenameRequest>,
) -> Result<Json<AccountSummary>, ApiError> {
    let label = request.label.trim();
    if label.is_empty() {
        return Err(ApiError::bad_request(
            "config",
            "le libellé du compte ne peut pas être vide",
        ));
    }
    let renamed = state.rename_account(&id, label).await?;
    let folders = state.store().list_folders(&id)?.len();
    tracing::info!(account = %id, label, "compte renommé");
    Ok(Json(AccountSummary::new(&renamed, folders)))
}

/// Forgets what is stored locally for one folder; the server is left alone.
async fn desync(
    Path((id, path)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    state.ensure_account(&id)?;
    if state.store().get_folder(&id, &path)?.is_none() {
        return Err(ApiError::not_found(format!("dossier « {path} » inconnu")));
    }
    let dropped = state.store().reset_folder(&id, &path)?;
    tracing::info!(account = %id, folder = %path, messages = dropped, "dossier désynchronisé");
    Ok(StatusCode::NO_CONTENT)
}
