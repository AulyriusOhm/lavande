//! `accounts.json`: the source of truth for the accounts. Mode 0600, written
//! atomically, never returned as is by the API.

use std::fs;
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process;

use lavande_mail::config::AccountConfig;

use crate::error::ApiError;

pub fn load(path: &Path) -> Result<Vec<AccountConfig>, ApiError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            ApiError::internal(
                "config",
                format!("{} est illisible : {error}", path.display()),
            )
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(ApiError::internal(
            "config",
            format!("lecture de {} : {error}", path.display()),
        )),
    }
}

pub fn save(path: &Path, accounts: &[AccountConfig]) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(accounts).map_err(|error| {
        ApiError::internal("config", format!("sérialisation des comptes : {error}"))
    })?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("accounts.json");
    let temporary = path.with_file_name(format!("{name}.{}.tmp", process::id()));

    let written = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(&bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(ApiError::internal(
            "config",
            format!("écriture de {} : {error}", temporary.display()),
        ));
    }

    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        ApiError::internal(
            "config",
            format!("installation de {} : {error}", path.display()),
        )
    })
}
