//! `/api/accounts/{id}/search`: local full-text-ish search across every folder.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use lavande_mail::model::Message;
use serde::Deserialize;

use crate::error::ApiError;
use crate::state::AppState;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

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
    let messages = state.store().search_messages(&id, trimmed, limit as i64)?;
    Ok(Json(messages))
}
