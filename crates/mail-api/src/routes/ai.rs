//! `/api/ai`: agent IA branché sur GitHub Copilot. Les jetons restent dans le
//! démon ; le front ne voit que l'état de la connexion.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

use crate::copilot::{
    self, ChatRequest, ConnectionResponse, LogoutResponse, StartRequest, StartResponse,
    StatusQuery, StatusResponse,
};
use crate::dto::ApiJson;
use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/ai/copilot/start", post(start))
        .route("/api/ai/copilot/status", get(status))
        .route("/api/ai/copilot/session", get(session))
        .route("/api/ai/copilot/logout", post(logout))
        .route("/api/ai/chat", post(chat))
}

async fn start(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<StartRequest>,
) -> Result<(StatusCode, Json<StartResponse>), ApiError> {
    let response = copilot::start(&state, request).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<StatusResponse>, ApiError> {
    copilot::status(&state, &query.session).await.map(Json)
}

async fn session(State(state): State<Arc<AppState>>) -> Result<Json<ConnectionResponse>, ApiError> {
    copilot::connection(&state).await.map(Json)
}

async fn logout(State(state): State<Arc<AppState>>) -> Result<Json<LogoutResponse>, ApiError> {
    copilot::logout(&state).await.map(Json)
}

async fn chat(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<ChatRequest>,
) -> Result<Json<Value>, ApiError> {
    copilot::chat(&state, request).await.map(Json)
}
