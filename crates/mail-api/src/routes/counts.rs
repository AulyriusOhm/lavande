//! `/api/accounts/{id}/folder-counts`: per-folder totals from the local store,
//! so the UI can badge every folder without loading their threads.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use lavande_mail::store::FolderCount;

use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/accounts/{id}/folder-counts", get(counts))
}

async fn counts(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<FolderCount>>, ApiError> {
    state.ensure_account(&id)?;
    Ok(Json(state.store().folder_counts(&id)?))
}
