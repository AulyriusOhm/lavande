use crate::state::AppState;
use axum::{
    extract::State,
    http::{header::AUTHORIZATION, header::CONTENT_TYPE, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde_json::json;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};

mod auth;
mod devices;
mod ops;
mod pairing;

pub fn router(state: AppState) -> Router {
    let api: Router<AppState> = Router::new()
        .route("/auth/salt", get(auth::salt))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/envelope", post(auth::set_envelope))
        .route("/me", get(auth::me))
        .route("/devices", get(devices::list).post(devices::create))
        .route("/devices/{id}", delete(devices::revoke))
        .route("/pairing/start", post(pairing::start))
        .route("/pairing/claim", post(pairing::claim))
        .route("/pairing/complete", post(pairing::complete))
        .route("/pairing/{code}/poll", post(pairing::poll))
        .route("/ops", get(ops::list).post(ops::push))
        .route("/status", get(ops::status));
    let cors = cors_layer(&state);

    Router::new()
        .route("/healthz", get(healthz))
        .nest("/api/v1", api)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(State(state): State<AppState>) -> Response {
    let healthy = sqlx::query_scalar::<_, i32>("select 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();

    let body = json!({
        "status": if healthy { "ok" } else { "unavailable" },
        "schemaVersion": state.config.server_max_schema,
        "minClientSchema": state.config.min_client_schema,
    });

    if healthy {
        (StatusCode::OK, Json(body)).into_response()
    } else {
        tracing::error!("healthz : PostgreSQL ne répond pas");
        (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response()
    }
}

fn cors_layer(state: &AppState) -> CorsLayer {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE]);

    if state.config.cors_origins.is_empty() {
        cors
    } else {
        cors.allow_origin(AllowOrigin::list(state.config.cors_origins.clone()))
    }
}
