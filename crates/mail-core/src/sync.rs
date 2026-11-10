//! Account-level sync: one connection, folder discovery, then mapped folders.

use crate::config::{AccountConfig, FolderMapping};
use crate::error::MailError;
use crate::imap::{self, SyncReport};
use crate::model::FolderRole;
use crate::store::Store;
use crate::tls::TlsOptions;

/// Connects once against the webpki roots, stores the account and its folders,
/// syncs the inbox and the sent folder when the server exposes them, then logs
/// out.
pub async fn sync_account(
    store: &Store,
    cfg: &AccountConfig,
    mapping: &FolderMapping,
) -> Result<Vec<(String, SyncReport)>, MailError> {
    sync_account_with(store, cfg, mapping, &TlsOptions::default()).await
}

/// `sync_account` with extra trust roots: a test server today, an enterprise
/// certificate authority later.
pub async fn sync_account_with(
    store: &Store,
    cfg: &AccountConfig,
    mapping: &FolderMapping,
    tls_options: &TlsOptions,
) -> Result<Vec<(String, SyncReport)>, MailError> {
    cfg.validate()?;
    store.upsert_account(&cfg.id, &cfg.label, &cfg.email)?;

    let mut session = imap::connect_with(cfg, tls_options).await?;
    let folders = imap::list_folders(&mut session, &cfg.id).await?;
    for folder in &folders {
        store.upsert_folder(folder)?;
    }

    let mut reports = Vec::new();
    for folder in &folders {
        if matches!(folder.role, FolderRole::Inbox | FolderRole::Sent) {
            let report =
                imap::sync_folder(&mut session, store, &cfg.id, &folder.path, mapping).await?;
            reports.push((folder.path.clone(), report));
        }
    }

    session
        .logout()
        .await
        .map_err(|error| MailError::Imap(error.to_string()))?;
    Ok(reports)
}
