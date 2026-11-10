//! `/api/discover`: the `clientConfig v1.1` chain, so the front never asks the
//! user what the provider already publishes.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::dto::DiscoverResponse;
use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/discover", get(discover))
}

#[derive(Deserialize)]
struct DiscoverQuery {
    email: Option<String>,
}

async fn discover(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DiscoverQuery>,
) -> Result<Json<DiscoverResponse>, ApiError> {
    let email = query.email.unwrap_or_default();
    let email = email.trim();
    let domain = domain(email)?;
    Ok(Json(state.discovery().discover(email, &domain).await))
}

/// The domain alone decides where the chain looks, so it is checked here.
fn domain(email: &str) -> Result<String, ApiError> {
    match email.rsplit_once('@') {
        Some((local, domain))
            if !local.is_empty() && !domain.is_empty() && !email.contains(char::is_whitespace) =>
        {
            Ok(domain.trim_end_matches('.').to_ascii_lowercase())
        }
        _ => Err(ApiError::bad_request(
            "config",
            format!("adresse invalide : « {email} »"),
        )),
    }
}
