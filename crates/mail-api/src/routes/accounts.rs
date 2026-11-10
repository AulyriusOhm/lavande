//! `/api/accounts`: listing, connection-tested creation, deletion, folders.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use lavande_mail::config::AccountConfig;
use lavande_mail::imap;
use lavande_mail::model::Folder;

use crate::dto::{AccountSummary, ApiJson};
use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/accounts", get(list).post(add))
        .route("/api/accounts/{id}", delete(remove))
        .route("/api/accounts/{id}/folders", get(folders))
}

async fn list(State(state): State<Arc<AppState>>) -> Result<Json<Vec<AccountSummary>>, ApiError> {
    let accounts = state.accounts()?;
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
    if state.accounts()?.iter().any(|known| known.id == config.id) {
        return Err(ApiError::conflict(
            "config",
            format!("le compte « {} » existe déjà", config.id),
        ));
    }

    let folders = probe(&state, &config).await?;
    state.add_account(&config, &folders)?;
    tracing::info!(account = %config.id, folders = folders.len(), "compte ajouté");
    Ok((
        StatusCode::CREATED,
        Json(AccountSummary::new(&config, folders.len())),
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
    let known = state.remove_account(&id)?;
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
    state.account(&id)?;
    Ok(Json(state.store().list_folders(&id)?))
}
