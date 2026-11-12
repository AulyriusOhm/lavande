//! Secrets de la synchronisation E2EE : la clé privée de l'appareil et le jeton
//! de session de chaque compte, **hors du `localStorage` du front**, dans le
//! coffre du démon (trousseau système ou fichier chiffré).
//!
//! Identifiants stables : `sync:device` pour la clé privée, `sync:<COMPTE>`
//! pour le jeton d'un compte. Ce module ne fait que nommer et valider : les
//! valeurs passent par [`crate::secrets`], et ne sortent que par les routes
//! authentifiées de `routes::sync`.

use crate::error::ApiError;

pub const DEVICE_SECRET_ID: &str = "sync:device";

const ACCOUNT_PREFIX: &str = "sync:";
const MAX_ACCOUNT_ID: usize = 128;
const MAX_SECRET_LEN: usize = 8192;

pub fn account_secret_id(account_id: &str) -> String {
    format!("{ACCOUNT_PREFIX}{account_id}")
}

/// Segment d'URL et entrée de trousseau : alphanumériques, `-`, `_` et `.`.
pub fn validate_account_id(account_id: &str) -> Result<(), ApiError> {
    let valid = !account_id.is_empty()
        && account_id.len() <= MAX_ACCOUNT_ID
        && account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "sync",
            "identifiant de compte invalide",
        ))
    }
}

/// Une valeur reçue du front : ni vide, ni démesurée, sans caractère de contrôle.
pub fn validate_secret(value: &str, label: &str) -> Result<(), ApiError> {
    let valid =
        !value.is_empty() && value.len() <= MAX_SECRET_LEN && !value.chars().any(char::is_control);
    if valid {
        Ok(())
    } else {
        Err(ApiError::bad_request("sync", format!("{label} invalide")))
    }
}
