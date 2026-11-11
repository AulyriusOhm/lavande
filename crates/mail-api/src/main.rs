//! `lavande-maild`: environment, store, router, bind. Every setting comes from
//! the environment, never from the command line.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;
use std::sync::Arc;

use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::events;
use lavande_mail_api::state::AppState;
use tokio::net::TcpListener;
use tokio::signal;

/// Loopback by default: the daemon is reached through the front's `/api` proxy.
const DEFAULT_BIND: &str = "127.0.0.1:8790";

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();
    if let Err(error) = run().await {
        tracing::error!(error = %error, "lavande-maild s'arrête");
        eprintln!("lavande-maild : {error}");
        process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let data_dir = data_dir()?;
    let state = Arc::new(
        AppState::open(&data_dir, tls_options()?)
            .await
            .map_err(|error| format!("ouverture de {} : {error}", data_dir.display()))?,
    );

    let bind = env::var("LAVANDE_MAIL_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let listener = TcpListener::bind(&bind)
        .await
        .map_err(|error| format!("impossible d'écouter sur {bind} : {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("adresse locale illisible : {error}"))?;
    tracing::info!(%address, data = %data_dir.display(), "lavande-maild écoute");

    events::watch_all(&state).await;
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|error| format!("serveur arrêté : {error}"))
}

fn data_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = env::var("LAVANDE_MAIL_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if let Ok(base) = env::var("XDG_DATA_HOME") {
        return Ok(PathBuf::from(base).join("lavande"));
    }
    match env::var("HOME") {
        Ok(home) => Ok(PathBuf::from(home).join(".local/share/lavande")),
        Err(_) => Err("LAVANDE_MAIL_DATA_DIR, XDG_DATA_HOME et HOME sont tous absents".to_string()),
    }
}

fn tls_options() -> Result<TlsOptions, String> {
    match env::var("LAVANDE_MAIL_EXTRA_ROOTS") {
        Ok(path) => {
            let pem = fs::read(&path).map_err(|error| format!("lecture de {path} : {error}"))?;
            Ok(TlsOptions {
                extra_roots_pem: vec![pem],
            })
        }
        Err(_) => Ok(TlsOptions::default()),
    }
}

async fn shutdown() {
    let interrupt = async {
        let _ = signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => tracing::warn!(error = %error, "signal SIGTERM indisponible"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
    tracing::info!("arrêt demandé");
}
