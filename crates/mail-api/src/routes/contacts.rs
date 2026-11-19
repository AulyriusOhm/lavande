//! `/api/contacts`: the addresses the mailbox has traded mail with, every
//! account merged. The store collects them as it imports headers; this route
//! only reads them.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use lavande_mail::store::Contact;
use serde::Deserialize;

use crate::error::ApiError;
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/contacts", get(contacts))
}

#[derive(Deserialize)]
struct ContactsQuery {
    q: Option<String>,
    limit: Option<i64>,
}

async fn contacts(
    Query(params): Query<ContactsQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Contact>>, ApiError> {
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let query = params.q.as_deref().unwrap_or("");
    Ok(Json(state.store().contacts(query, limit)?))
}
