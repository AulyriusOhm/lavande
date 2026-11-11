//! `/api/pgp/keys…`: the OpenPGP keys of the daemon. Generating and importing
//! a secret key never returns its private half.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::dto::{
    ApiJson, PgpExportResponse, PgpGenerateRequest, PgpGeneratedResponse, PgpImportRequest,
    PgpImportedResponse, PgpKeysResponse,
};
use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/pgp/keys", get(keys))
        .route("/api/pgp/keys/generate", post(generate))
        .route("/api/pgp/keys/import", post(import))
        .route("/api/pgp/keys/{fingerprint}/export", get(export))
        .route("/api/pgp/keys/{fingerprint}", axum::routing::delete(delete))
}

async fn keys(State(state): State<Arc<AppState>>) -> Result<Json<PgpKeysResponse>, ApiError> {
    Ok(Json(PgpKeysResponse {
        keys: state.pgp().keys()?,
    }))
}

async fn generate(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<PgpGenerateRequest>,
) -> Result<Json<PgpGeneratedResponse>, ApiError> {
    let (key, public_key) = state.pgp().generate(&request.name, &request.email).await?;
    tracing::info!(fingerprint = %key.fingerprint, "clé PGP générée");
    Ok(Json(PgpGeneratedResponse { key, public_key }))
}

async fn import(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<PgpImportRequest>,
) -> Result<Json<PgpImportedResponse>, ApiError> {
    let key = state.pgp().import(&request.armored).await?;
    tracing::info!(fingerprint = %key.fingerprint, secret = key.has_secret, "clé PGP importée");
    Ok(Json(PgpImportedResponse { key }))
}

async fn export(
    Path(fingerprint): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PgpExportResponse>, ApiError> {
    Ok(Json(PgpExportResponse {
        public_key: state.pgp().export(&fingerprint)?,
    }))
}

async fn delete(
    Path(fingerprint): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    state.pgp().delete(&fingerprint).await?;
    tracing::info!(fingerprint = %fingerprint, "clé PGP supprimée");
    Ok(StatusCode::NO_CONTENT)
}
