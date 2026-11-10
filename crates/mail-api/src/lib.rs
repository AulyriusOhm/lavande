//! HTTP API of the Lavande mail daemon: the router lives here so the tests can
//! drive it without a socket.

#![forbid(unsafe_code)]

pub mod config_file;
pub mod discovery;
pub mod dto;
pub mod error;
pub mod routes;
pub mod state;

use std::path::PathBuf;
use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use tower_http::cors::{Any, CorsLayer};

use crate::dto::Health;
use crate::state::AppState;

use lavande_mail::tls::TlsOptions;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: VERSION,
    })
}

/// The webview of the desktop/mobile shell runs on another origin, so the
/// routeur accepts it explicitly; the daemon only ever listens on loopback.
fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .merge(routes::accounts::router())
        .merge(routes::discover::router())
        .merge(routes::mail::router())
        .layer(cors())
        .with_state(state)
}

/// Binds `bind` and serves the API until the process ends. Used by the daemon
/// and by the Tauri shell, which embeds the router in the app itself.
pub async fn serve(bind: &str, data_dir: PathBuf, tls: TlsOptions) -> Result<(), String> {
    let state = Arc::new(
        AppState::open(&data_dir, tls)
            .map_err(|error| format!("ouverture de {} : {error}", data_dir.display()))?,
    );
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|error| format!("impossible d'écouter sur {bind} : {error}"))?;
    tracing::info!(address = bind, data = %data_dir.display(), "API mail à l'écoute");
    axum::serve(listener, app(state))
        .await
        .map_err(|error| format!("serveur arrêté : {error}"))
}
