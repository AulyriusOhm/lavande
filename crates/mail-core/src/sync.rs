//! Account-level sync: one connection, folder discovery, then mapped folders.

use crate::config::{AccountConfig, FolderMapping};
use crate::error::MailError;
use crate::imap::{self, SyncReport};
use crate::model::FolderRole;
use crate::pgp::PgpKeyring;
use crate::store::Store;
use crate::tls::TlsOptions;

/// Connects once against the webpki roots, stores the account and its folders,
/// syncs every folder with a known role (inbox, sent, drafts, archive, spam,
/// trash), then logs out. Custom folders are synced on demand, per folder.
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
    sync_account_keys(store, cfg, mapping, tls_options, &PgpKeyring::new()).await
}

/// `sync_account_with` plus the PGP keyring encrypted bodies are decrypted with.
pub async fn sync_account_keys(
    store: &Store,
    cfg: &AccountConfig,
    mapping: &FolderMapping,
    tls_options: &TlsOptions,
    keys: &PgpKeyring,
) -> Result<Vec<(String, SyncReport)>, MailError> {
    cfg.validate()?;
    store.upsert_account(&cfg.id, &cfg.label, &cfg.email)?;

    let mut session = imap::connect_with(cfg, tls_options).await?;
    let folders = imap::list_folders(&mut session, &cfg.id).await?;
    for folder in &folders {
        // Keep the stored UIDVALIDITY: reconcile compares it against the live
        // SELECT and must still see a server-side change to purge the folder.
        let mut record = folder.clone();
        if let Some(stored) = store.get_folder(&cfg.id, &folder.path)? {
            record.uidvalidity = stored.uidvalidity;
        }
        store.upsert_folder(&record)?;
    }

    let mut reports = Vec::new();
    for folder in &folders {
        if folder.role == FolderRole::Other {
            continue;
        }
        match imap::sync_folder(&mut session, store, &cfg.id, &folder.path, mapping, keys).await {
            Ok(report) => reports.push((folder.path.clone(), report)),
            Err(error) => {
                tracing::warn!(account = %cfg.id, folder = %folder.path, %error, "dossier non synchronisé");
            }
        }
    }

    if let Err(error) = session.logout().await {
        tracing::warn!(%error, "fermeture de la session imap");
    }
    Ok(reports)
}
