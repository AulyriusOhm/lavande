use crate::config::Config;
use anyhow::{Context, Result};
use sqlx::{
    migrate::Migrator,
    postgres::{PgPool, PgPoolOptions},
};
use std::time::Duration;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

pub async fn connect(config: &Config) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await
        .context("connexion à PostgreSQL impossible")
}

pub async fn migrate(pool: &PgPool) -> Result<()> {
    MIGRATOR
        .run(pool)
        .await
        .context("application des migrations impossible")
}
