//! Account-level sync: one connection, folder discovery, then mapped folders.

use chrono::{Duration, SecondsFormat, Utc};

use crate::config::{AccountConfig, FolderMapping};
use crate::error::MailError;
use crate::imap::{self, SyncReport};
use crate::model::{Folder, FolderRole};
use crate::store::Store;
use crate::tls::TlsOptions;

/// Bodies older than this leave the store: opening the message re-reads them
/// from the server.
const EVICT_BODY_DAYS: u32 = 30;

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
    sync_account_selected(store, cfg, mapping, tls_options, None).await
}

/// `sync_account_with` with the folders the account syncs by itself: `None`
/// keeps the default (every folder with a known role), `Some(paths)` limits the
/// automatic pass to those folders, `Some([])` syncs none of them. Folder
/// discovery and the on-demand per-folder sync are untouched.
pub async fn sync_account_selected(
    store: &Store,
    cfg: &AccountConfig,
    mapping: &FolderMapping,
    tls_options: &TlsOptions,
    synced_folders: Option<&[String]>,
) -> Result<Vec<(String, SyncReport)>, MailError> {
    cfg.validate()?;
    store.upsert_account(&cfg.id, &cfg.label, &cfg.email)?;

    let mut session = imap::connect_with(cfg, tls_options).await?;
    // RFC 5161 only allows ENABLE outside a selected mailbox, and this session
    // selects one folder per round: the opt-in has to happen here, once.
    imap::enable_condstore(&mut session).await;
    let folders = imap::list_folders(&mut session, &cfg.id).await?;
    for folder in &folders {
        // Keep the stored UIDVALIDITY: reconcile compares it against the live
        // SELECT and must still see a server-side change to purge the folder.
        // The stored modseq is the baseline an incremental pass resumes from;
        // reconcile drops it itself when the UIDVALIDITY moved.
        let mut record = folder.clone();
        if let Some(stored) = store.get_folder(&cfg.id, &folder.path)? {
            record.uidvalidity = stored.uidvalidity;
            record.modseq = stored.modseq;
        }
        store.upsert_folder(&record)?;
    }

    let mut reports = Vec::new();
    for folder in &folders {
        if !auto_syncs(folder, synced_folders) {
            continue;
        }
        match imap::sync_folder(&mut session, store, &cfg.id, &folder.path, mapping).await {
            Ok(report) => reports.push((folder.path.clone(), report)),
            Err(error) => {
                tracing::warn!(account = %cfg.id, folder = %folder.path, %error, "dossier non synchronisé");
                // Une réponse que le client n'a pas su lire laisse la session
                // désalignée : les dossiers suivants repartent d'une connexion
                // neuve plutôt que d'échouer en cascade.
                session = imap::connect_with(cfg, tls_options).await?;
                imap::enable_condstore(&mut session).await;
            }
        }
    }

    evict_bodies(store, &cfg.id);

    if let Err(error) = session.logout().await {
        tracing::warn!(%error, "fermeture de la session imap");
    }
    Ok(reports)
}

/// Drops the bodies loaded more than `EVICT_BODY_DAYS` ago. A failure leaves the
/// store as it was and never fails the sync that just succeeded.
fn evict_bodies(store: &Store, account_id: &str) {
    let cutoff = (Utc::now() - Duration::days(i64::from(EVICT_BODY_DAYS)))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    match store.evict_bodies_before(account_id, &cutoff) {
        Ok(evicted) => tracing::debug!(account = account_id, evicted, "corps évincés"),
        Err(error) => tracing::warn!(account = account_id, %error, "éviction des corps impossible"),
    }
}

/// `true` when the automatic pass of the account covers `folder`: the explicit
/// selection when there is one, every folder with a known role otherwise.
pub fn auto_syncs(folder: &Folder, synced_folders: Option<&[String]>) -> bool {
    match synced_folders {
        Some(paths) => paths.iter().any(|path| path == &folder.path),
        None => folder.role != FolderRole::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::auto_syncs;
    use crate::model::{Folder, FolderRole};

    fn folder(path: &str, role: FolderRole) -> Folder {
        Folder {
            account_id: "perso".to_string(),
            path: path.to_string(),
            name: path.to_string(),
            role,
            uidvalidity: 1,
            uidnext: 1,
            last_sync_at: None,
            modseq: None,
            delimiter: None,
        }
    }

    #[test]
    fn no_selection_keeps_every_known_role() {
        assert!(auto_syncs(&folder("INBOX", FolderRole::Inbox), None));
        assert!(auto_syncs(&folder("Archive", FolderRole::Archive), None));
        assert!(!auto_syncs(&folder("Projets", FolderRole::Other), None));
    }

    #[test]
    fn an_explicit_selection_limits_the_pass_to_it() {
        let selection = vec!["Archive".to_string()];
        assert!(auto_syncs(
            &folder("Archive", FolderRole::Archive),
            Some(&selection)
        ));
        assert!(!auto_syncs(
            &folder("INBOX", FolderRole::Inbox),
            Some(&selection)
        ));
    }

    #[test]
    fn a_custom_folder_can_be_selected_by_name() {
        let selection = vec!["Projets".to_string()];
        assert!(auto_syncs(
            &folder("Projets", FolderRole::Other),
            Some(&selection)
        ));
    }

    #[test]
    fn an_empty_selection_syncs_nothing() {
        let selection: Vec<String> = Vec::new();
        assert!(!auto_syncs(
            &folder("INBOX", FolderRole::Inbox),
            Some(&selection)
        ));
        assert!(!auto_syncs(
            &folder("Projets", FolderRole::Other),
            Some(&selection)
        ));
    }

    #[test]
    fn a_selection_naming_a_missing_folder_matches_nothing() {
        let selection = vec!["Absent".to_string()];
        assert!(!auto_syncs(
            &folder("INBOX", FolderRole::Inbox),
            Some(&selection)
        ));
    }
}
