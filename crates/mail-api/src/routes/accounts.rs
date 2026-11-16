//! `/api/accounts`: listing, connection-tested creation, renaming, deletion,
//! folders, and the local purge of one folder.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use lavande_mail::config::AccountConfig;
use lavande_mail::imap;
use lavande_mail::model::{Folder, FolderRole};

use crate::config_file::StoredAccount;
use crate::dto::{AccountSummary, ApiJson, PgpEnabledRequest, RenameRequest, SyncFoldersRequest};
use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/accounts", get(list).post(add))
        .route("/api/accounts/preview", post(preview))
        .route("/api/accounts/{id}", delete(remove).patch(rename))
        .route("/api/accounts/{id}/sync-folders", patch(set_sync_folders))
        .route("/api/accounts/{id}/pgp", patch(set_pgp))
        .route("/api/accounts/{id}/folders", get(folders))
        .route("/api/accounts/{id}/folders/{path}", delete(delete_folder))
        .route("/api/accounts/{id}/folders/{path}/local", delete(desync))
}

async fn list(State(state): State<Arc<AppState>>) -> Result<Json<Vec<AccountSummary>>, ApiError> {
    let accounts = state.stored_accounts()?;
    let mut summaries = Vec::with_capacity(accounts.len());
    for config in &accounts {
        let folders = state.store().list_folders(&config.id)?.len();
        let pgp = state.store().pgp_enabled(&config.id)?;
        summaries.push(AccountSummary::new(config, folders, pgp));
    }
    Ok(Json(summaries))
}

async fn add(
    State(state): State<Arc<AppState>>,
    ApiJson(mut config): ApiJson<AccountConfig>,
) -> Result<(StatusCode, Json<AccountSummary>), ApiError> {
    config.validate()?;
    if state
        .stored_accounts()?
        .iter()
        .any(|known| known.id == config.id)
    {
        return Err(ApiError::conflict(
            "config",
            format!(
                "le compte « {} » est déjà connecté sur cet appareil ; retire-le dans \
                 Réglages → Comptes avant de le reconfigurer",
                config.id
            ),
        ));
    }

    let folders = probe(&state, &config).await?;
    let paths = folder_paths(&folders);
    config.synced_folders = selected_folders(config.synced_folders.take(), &paths)?;
    state.add_account(&config, &folders).await?;
    crate::events::watch_account(&state, config.clone());
    tracing::info!(account = %config.id, folders = folders.len(), "compte ajouté");
    Ok((
        StatusCode::CREATED,
        Json(AccountSummary::new(
            &StoredAccount::from_config(&config),
            folders.len(),
            state.store().pgp_enabled(&config.id)?,
        )),
    ))
}

/// The folders a server holds for these credentials, with their hierarchy
/// delimiter: the account is not created, nothing is stored.
async fn preview(
    State(state): State<Arc<AppState>>,
    ApiJson(config): ApiJson<AccountConfig>,
) -> Result<Json<Vec<Folder>>, ApiError> {
    config.validate()?;
    let folders = probe(&state, &config).await?;
    tracing::info!(account = %config.id, folders = folders.len(), "dossiers prévisualisés");
    Ok(Json(folders))
}

/// The connection test: nothing is stored unless the server answers.
async fn probe(state: &AppState, config: &AccountConfig) -> Result<Vec<Folder>, ApiError> {
    let mut session = imap::connect_with(config, state.tls()).await?;
    let folders = imap::list_folders(&mut session, &config.id).await?;
    if let Err(error) = session.logout().await {
        tracing::debug!(error = %error, "fermeture de la session imap");
    }
    Ok(folders)
}

async fn remove(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let known = state.remove_account(&id).await?;
    let deleted = state.store().delete_account(&id)?;
    if !known && deleted == 0 {
        return Err(ApiError::not_found(format!("compte « {id} » inconnu")));
    }
    tracing::info!(account = %id, rows = deleted, "compte supprimé");
    Ok(StatusCode::NO_CONTENT)
}

async fn folders(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Folder>>, ApiError> {
    state.ensure_account(&id)?;
    Ok(Json(state.store().list_folders(&id)?))
}

fn folder_paths(folders: &[Folder]) -> Vec<String> {
    folders.iter().map(|folder| folder.path.clone()).collect()
}

/// Normalises a requested selection: trimmed, deduplicated, and refused when it
/// names a folder the server does not hold — a typo would otherwise sync
/// nothing without a word.
fn selected_folders(
    requested: Option<Vec<String>>,
    known: &[String],
) -> Result<Option<Vec<String>>, ApiError> {
    let Some(paths) = requested else {
        return Ok(None);
    };
    let mut kept: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        let path = path.trim().to_string();
        if path.is_empty() {
            continue;
        }
        if !known.contains(&path) {
            return Err(ApiError::bad_request(
                "config",
                format!("dossier « {path} » inconnu pour ce compte"),
            ));
        }
        if !kept.contains(&path) {
            kept.push(path);
        }
    }
    Ok(Some(kept))
}

/// Changes the label of an account and nothing else.
async fn rename(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<RenameRequest>,
) -> Result<Json<AccountSummary>, ApiError> {
    let label = request.label.trim();
    if label.is_empty() {
        return Err(ApiError::bad_request(
            "config",
            "le libellé du compte ne peut pas être vide",
        ));
    }
    let renamed = state.rename_account(&id, label).await?;
    let folders = state.store().list_folders(&id)?.len();
    tracing::info!(account = %id, label, "compte renommé");
    Ok(Json(AccountSummary::new(
        &renamed,
        folders,
        state.store().pgp_enabled(&id)?,
    )))
}

/// Selects the folders the account syncs by itself. `folders: null` restores
/// the default (every folder with a known role), `[]` syncs none.
async fn set_sync_folders(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<SyncFoldersRequest>,
) -> Result<Json<AccountSummary>, ApiError> {
    state.ensure_account(&id)?;
    let known = folder_paths(&state.store().list_folders(&id)?);
    let selected = selected_folders(request.folders, &known)?;
    let updated = state.update_sync_folders(&id, selected).await?;
    let folders = known.len();
    tracing::info!(
        account = %id,
        selection = updated.synced_folders.as_ref().map_or(-1, |paths| paths.len() as i64),
        "dossiers synchronisés choisis"
    );
    Ok(Json(AccountSummary::new(
        &updated,
        folders,
        state.store().pgp_enabled(&id)?,
    )))
}

/// Ouvre ou ferme l'interrupteur PGP du compte : fermé, le démon ne déchiffre
/// plus rien pour lui, et ce qui avait été déchiffré de messages chiffrés est
/// effacé de la base (le corps revient sur demande une fois l'interrupteur
/// rouvert).
async fn set_pgp(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<PgpEnabledRequest>,
) -> Result<Json<AccountSummary>, ApiError> {
    let account = state.stored_account(&id)?;
    state.set_pgp_enabled(&account, request.enabled)?;
    let closed = if request.enabled {
        0
    } else {
        state.store().close_encrypted_bodies(&id)?
    };
    let folders = state.store().list_folders(&id)?.len();
    tracing::info!(
        account = %id,
        pgp = request.enabled,
        messages = closed,
        "interrupteur pgp"
    );
    Ok(Json(AccountSummary::new(
        &account,
        folders,
        state.store().pgp_enabled(&id)?,
    )))
}

/// Forgets what is stored locally for one folder; the server is left alone.
async fn desync(
    Path((id, path)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    state.ensure_account(&id)?;
    if state.store().get_folder(&id, &path)?.is_none() {
        return Err(ApiError::not_found(format!("dossier « {path} » inconnu")));
    }
    let dropped = state.store().reset_folder(&id, &path)?;
    tracing::info!(account = %id, folder = %path, messages = dropped, "dossier désynchronisé");
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes one custom folder on the server, then locally. The local rows are
/// only dropped once the server accepted: a refused `DELETE` leaves the store
/// untouched. Folders holding a role are never candidates.
async fn delete_folder(
    Path((id, path)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    state.ensure_account(&id)?;
    let folder = state
        .store()
        .get_folder(&id, &path)?
        .ok_or_else(|| ApiError::not_found(format!("dossier « {path} » inconnu")))?;
    if folder.role != FolderRole::Other {
        return Err(ApiError::bad_request(
            "config",
            format!(
                "le dossier « {path} » tient le rôle {} : il ne peut pas être supprimé",
                folder.role.as_str()
            ),
        ));
    }
    let config = state.account(&id).await?;
    let mut session = imap::connect_with(&config, state.tls()).await?;
    let removed = imap::delete_folder(&mut session, &path).await;
    if let Err(error) = session.logout().await {
        tracing::debug!(error = %error, "fermeture de la session imap");
    }
    removed?;
    let dropped = state.store().delete_folder(&id, &path)?;
    tracing::info!(account = %id, folder = %path, messages = dropped, "dossier supprimé");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::{selected_folders, StatusCode};

    fn known() -> Vec<String> {
        vec!["INBOX".to_string(), "Archive".to_string()]
    }

    #[test]
    fn no_selection_keeps_the_default() {
        assert_eq!(selected_folders(None, &known()).expect("choix"), None);
    }

    #[test]
    fn a_selection_is_trimmed_and_deduplicated() {
        let asked = vec![
            " Archive ".to_string(),
            "INBOX".to_string(),
            "Archive".to_string(),
            String::new(),
        ];
        assert_eq!(
            selected_folders(Some(asked), &known()).expect("choix"),
            Some(vec!["Archive".to_string(), "INBOX".to_string()])
        );
    }

    #[test]
    fn an_empty_selection_syncs_nothing() {
        assert_eq!(
            selected_folders(Some(Vec::new()), &known()).expect("choix"),
            Some(Vec::new())
        );
    }

    #[test]
    fn an_unknown_folder_is_refused() {
        let refused =
            selected_folders(Some(vec!["Fantome".to_string()]), &known()).expect_err("refus");
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    }
}
