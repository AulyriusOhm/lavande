//! `/api/sync/secrets…`: la clé privée de l'appareil de synchronisation E2EE et
//! le jeton de session de chaque compte, déposés dans le coffre du démon
//! (trousseau système ou fichier chiffré) au lieu du `localStorage` du front.
//!
//! Le front ne garde chez lui que l'état déjà chiffré de bout en bout (docs,
//! refs, outbox, statut) et les métadonnées du compte. Les valeurs ci-dessous
//! ne sortent que par ces routes, derrière le jeton du démon, et ne sont
//! jamais journalisées.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::dto::ApiJson;
use crate::error::ApiError;
use crate::state::AppState;
use crate::sync_secrets;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/sync/secrets/device",
            get(device_key).put(set_device_key),
        )
        .route(
            "/api/sync/secrets/accounts/{id}",
            get(account_token)
                .put(set_account_token)
                .delete(remove_account_token),
        )
}

/// Une valeur présente seulement si le coffre la détient : un appareil neuf
/// n'est pas une erreur pour le front, qui génère alors sa propre paire.
#[derive(Serialize)]
pub struct DeviceKeyResponse {
    private_key: Option<String>,
}

#[derive(Deserialize)]
pub struct DeviceKeyRequest {
    private_key: String,
}

#[derive(Serialize)]
pub struct AccountTokenResponse {
    token: Option<String>,
}

#[derive(Deserialize)]
pub struct AccountTokenRequest {
    token: String,
}

async fn device_key(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DeviceKeyResponse>, ApiError> {
    Ok(Json(DeviceKeyResponse {
        private_key: state.sync_device_key().await?,
    }))
}

/// La clé privée déchiffre les documents existants : elle est écrite telle
/// quelle, jamais transformée, et remplacée à l'identique par le front.
async fn set_device_key(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<DeviceKeyRequest>,
) -> Result<StatusCode, ApiError> {
    sync_secrets::validate_secret(&request.private_key, "clé privée")?;
    state.set_sync_device_key(&request.private_key).await?;
    tracing::debug!("clé privée de synchronisation déposée dans le coffre");
    Ok(StatusCode::NO_CONTENT)
}

async fn account_token(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<AccountTokenResponse>, ApiError> {
    sync_secrets::validate_account_id(&id)?;
    Ok(Json(AccountTokenResponse {
        token: state.sync_account_token(&id).await?,
    }))
}

async fn set_account_token(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<AccountTokenRequest>,
) -> Result<StatusCode, ApiError> {
    sync_secrets::validate_account_id(&id)?;
    sync_secrets::validate_secret(&request.token, "jeton")?;
    state.set_sync_account_token(&id, &request.token).await?;
    tracing::debug!(account = %id, "jeton de synchronisation déposé dans le coffre");
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_account_token(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    sync_secrets::validate_account_id(&id)?;
    state.remove_sync_account_token(&id).await?;
    tracing::debug!(account = %id, "jeton de synchronisation retiré du coffre");
    Ok(StatusCode::NO_CONTENT)
}
