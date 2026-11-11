//! Jeton d'accès du démon : aléatoire, persisté dans le répertoire de données
//! (0600). Tous les clients lisent le même fichier : proxy Vite, nginx, coquille
//! Tauri. La valeur n'est jamais journalisée.

use std::fs;
use std::io::{ErrorKind, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;

use crate::error::ApiError;

pub const TOKEN_FILE: &str = "daemon-token";

/// Lit le jeton, ou le crée au premier lancement. Création exclusive : deux
/// démarrages concurrents (coquille + démon) aboutissent au même jeton.
pub fn load_or_create(data_dir: &Path) -> Result<String, ApiError> {
    let path = data_dir.join(TOKEN_FILE);
    if let Some(token) = read(&path)? {
        return Ok(token);
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(token.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    ApiError::internal("auth", format!("écriture de {} : {error}", path.display()))
                })?;
            Ok(token)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => read(&path)?.ok_or_else(|| {
            ApiError::internal(
                "auth",
                format!("{} vient d'être créé mais est vide", path.display()),
            )
        }),
        Err(error) => Err(ApiError::internal(
            "auth",
            format!("création de {} : {error}", path.display()),
        )),
    }
}

fn read(path: &Path) -> Result<Option<String>, ApiError> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let token = raw.trim();
            if token.is_empty() {
                Err(ApiError::internal(
                    "auth",
                    format!("{} est vide", path.display()),
                ))
            } else {
                Ok(Some(token.to_string()))
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ApiError::internal(
            "auth",
            format!("lecture de {} : {error}", path.display()),
        )),
    }
}
