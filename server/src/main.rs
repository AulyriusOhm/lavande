use lavande_sync::{config::Config, db, routes, state::AppState};
use anyhow::{Context, Result};
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Config::from_env().context("configuration invalide")?;
    tracing::info!(database = %redacted(&config.database_url), "connexion à PostgreSQL");

    let pool = db::connect(&config).await?;
    db::migrate(&pool).await?;
    tracing::info!("migrations à jour");

    let state = AppState {
        pool,
        config: Arc::new(config),
    };
    let bind_addr = state.config.bind_addr.clone();
    let app = routes::router(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("écoute impossible sur {bind_addr}"))?;
    tracing::info!("lavande-sync à l'écoute sur http://{bind_addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("erreur du serveur HTTP")
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

fn redacted(database_url: &str) -> String {
    match database_url.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('@') {
            Some((_, host)) => format!("{scheme}://***@{host}"),
            None => format!("{scheme}://{rest}"),
        },
        None => "***".to_string(),
    }
}

async fn shutdown_signal() {
    match tokio::signal::ctrl_c().await {
        Ok(()) => tracing::info!("arrêt demandé, fermeture en cours"),
        Err(err) => tracing::error!(error = %err, "impossible d'écouter Ctrl-C"),
    }
}
