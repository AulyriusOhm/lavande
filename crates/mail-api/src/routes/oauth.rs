//! `/api/oauth`: consentement dans le navigateur, retour loopback, état de la
//! session. Aucun jeton ne sort du service.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::dto::ApiJson;
use crate::error::ApiError;
use crate::oauth_flow::{
    self, CallbackQuery, StartRequest, StartResponse, StatusQuery, StatusResponse,
};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CompleteRequest {
    pub session: String,
}

#[derive(Deserialize)]
pub struct ReconnectRequest {
    pub account_id: String,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/oauth/start", post(start))
        .route("/api/oauth/reconnect", post(reconnect))
        .route("/api/oauth/callback", get(callback))
        .route("/api/oauth/complete", post(complete))
        .route("/api/oauth/status", get(status))
}

async fn start(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<StartRequest>,
) -> Result<(axum::http::StatusCode, Json<StartResponse>), ApiError> {
    let response = oauth_flow::start(&state, request).await?;
    Ok((axum::http::StatusCode::CREATED, Json(response)))
}

/// Réautorisation d'un compte existant : la session rendue se termine par les
/// routes `complete`/`status` habituelles.
async fn reconnect(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<ReconnectRequest>,
) -> Result<(axum::http::StatusCode, Json<StartResponse>), ApiError> {
    let response = oauth_flow::start_reconnect(&state, &request.account_id).await?;
    Ok((axum::http::StatusCode::CREATED, Json(response)))
}

async fn callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CallbackQuery>,
) -> (axum::http::StatusCode, axum::response::Html<String>) {
    let (status, body) = oauth_flow::callback(&state, query).await;
    (status, axum::response::Html(body))
}

async fn status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<StatusResponse>, ApiError> {
    oauth_flow::status(&state, &query.session).map(Json)
}

async fn complete(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<CompleteRequest>,
) -> Result<Json<StatusResponse>, ApiError> {
    oauth_flow::complete(&state, &request.session)
        .await
        .map(Json)
}
