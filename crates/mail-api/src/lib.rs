//! HTTP API of the Lavande mail daemon: the router lives here so the tests can
//! drive it without a socket.

#![forbid(unsafe_code)]

pub mod config_file;
pub mod discovery;
pub mod dto;
pub mod error;
pub mod routes;
pub mod state;

use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};

use crate::dto::Health;
use crate::state::AppState;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: VERSION,
    })
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .merge(routes::accounts::router())
        .merge(routes::discover::router())
        .merge(routes::mail::router())
        .with_state(state)
}
