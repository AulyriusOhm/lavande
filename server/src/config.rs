use anyhow::{bail, Context, Result};
use axum::http::HeaderValue;
use sqlx::postgres::PgConnectOptions;
use std::{env, str::FromStr};

const PREFIX: &str = "LAVANDE_SYNC_";
const DEFAULT_DATABASE_URL: &str = "postgres://lavande:lavande@127.0.0.1:55432/lavande_sync";
const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8787";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub server_max_schema: i32,
    pub min_client_schema: i32,
    pub pairing_ttl_secs: i64,
    pub session_ttl_secs: i64,
    pub cors_origins: Vec<HeaderValue>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let database_url = raw("DATABASE_URL").unwrap_or_else(|| DEFAULT_DATABASE_URL.to_string());
        database_url.parse::<PgConnectOptions>().context(
            "LAVANDE_SYNC_DATABASE_URL invalide (attendu postgres://user:pass@host:port/db)",
        )?;

        let bind_addr = raw("BIND_ADDR").unwrap_or_else(|| DEFAULT_BIND_ADDR.to_string());
        bind_addr
            .parse::<std::net::SocketAddr>()
            .with_context(|| format!("LAVANDE_SYNC_BIND_ADDR invalide : {bind_addr}"))?;

        let config = Self {
            database_url,
            bind_addr,
            server_max_schema: parsed("SERVER_MAX_SCHEMA", 1)?,
            min_client_schema: parsed("MIN_CLIENT_SCHEMA", 1)?,
            pairing_ttl_secs: parsed("PAIRING_TTL_SECS", 300)?,
            session_ttl_secs: parsed("SESSION_TTL_SECS", 2_592_000)?,
            cors_origins: origins()?,
        };

        if config.server_max_schema < 1 {
            bail!("LAVANDE_SYNC_SERVER_MAX_SCHEMA doit être >= 1");
        }
        if config.min_client_schema < 1 || config.min_client_schema > config.server_max_schema {
            bail!("LAVANDE_SYNC_MIN_CLIENT_SCHEMA doit être compris entre 1 et LAVANDE_SYNC_SERVER_MAX_SCHEMA");
        }
        if config.pairing_ttl_secs <= 0 {
            bail!("LAVANDE_SYNC_PAIRING_TTL_SECS doit être > 0");
        }
        if config.session_ttl_secs <= 0 {
            bail!("LAVANDE_SYNC_SESSION_TTL_SECS doit être > 0");
        }

        Ok(config)
    }
}

fn origins() -> Result<Vec<HeaderValue>> {
    raw("CORS_ORIGINS")
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(|origin| {
                    HeaderValue::from_str(origin).with_context(|| {
                        format!("LAVANDE_SYNC_CORS_ORIGINS : origine invalide {origin}")
                    })
                })
                .collect()
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

fn raw(name: &str) -> Option<String> {
    env::var(format!("{PREFIX}{name}"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parsed<T>(name: &str, default: T) -> Result<T>
where
    T: FromStr + Copy,
    T::Err: std::fmt::Display,
{
    match raw(name) {
        None => Ok(default),
        Some(value) => value
            .parse::<T>()
            .map_err(|err| anyhow::anyhow!("{PREFIX}{name} invalide : {value} ({err})")),
    }
}
