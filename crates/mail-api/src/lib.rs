//! HTTP API of the Lavande mail daemon: the router lives here so the tests can
//! drive it without a socket.

#![forbid(unsafe_code)]

pub mod auth;
pub mod calendar_sources;
pub mod config_file;
pub mod copilot;
pub mod discovery;
pub mod dto;
pub mod error;
pub mod events;
pub mod oauth_flow;
pub mod pgp_keys;
pub mod private_file;
pub mod routes;
pub mod secrets;
pub mod state;
pub mod sync_secrets;
pub mod token;
pub mod widget;
pub mod widget_agenda;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderValue, Method};
use axum::routing::get;
use axum::{Json, Router};
use tower_http::cors::CorsLayer;

use crate::dto::Health;
use crate::state::AppState;

use lavande_mail::tls::TlsOptions;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        status: "ok",
        version: VERSION,
        public_url: state.public_url().to_string(),
    })
}

/// Origines qui parlent réellement au démon : la coquille Tauri (Linux et macOS
/// en `tauri://localhost`, Windows en `tauri.localhost` https par défaut ou http
/// si le schéma est forcé, Android avec les deux) et le dev server Vite
/// (`strictPort`, donc toujours 1420). L'app servie par le portail nginx n'est
/// pas concernée : elle joint `/lavande/api/` en même origine.
const ALLOWED_ORIGINS: [&str; 5] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

/// The webview of the desktop/mobile shell runs on another origin, so the
/// routeur accepts it explicitly; the daemon only ever listens on loopback.
/// Une origine absente de la liste ne reçoit aucun en-tête CORS : le navigateur
/// refuse de lire la réponse, la requête elle-même n'est pas coupée.
fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(ALLOWED_ORIGINS.map(HeaderValue::from_static))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .merge(routes::accounts::router())
        .merge(routes::ai::router())
        .merge(routes::calendars::router())
        .merge(routes::contacts::router())
        .merge(routes::counts::router())
        .merge(routes::discover::router())
        .merge(routes::mail::router())
        .merge(routes::oauth::router())
        .merge(routes::pgp::router())
        .merge(routes::search::router())
        .merge(routes::sync::router())
        .merge(routes::events::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ))
        .layer(cors())
        .with_state(state)
}

/// Binds `bind` and serves the API until the process ends. Used by the daemon
/// and by the Tauri shell, which embeds the router in the app itself.
pub async fn serve(bind: &str, data_dir: PathBuf, tls: TlsOptions) -> Result<(), String> {
    let state = Arc::new(
        AppState::open(&data_dir, tls)
            .await
            .map_err(|error| format!("ouverture de {} : {error}", data_dir.display()))?,
    );
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|error| format!("impossible d'écouter sur {bind} : {error}"))?;
    tracing::info!(
        address = bind,
        data = %data_dir.display(),
        token_file = %data_dir.join(token::TOKEN_FILE).display(),
        "API mail à l'écoute"
    );
    events::watch_all(&state).await;
    axum::serve(listener, app(state))
        .await
        .map_err(|error| format!("serveur arrêté : {error}"))
}
