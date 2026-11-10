//! Shared state: the SQLite store, the accounts file and the trust roots.

use std::fs;
use std::path::{Path, PathBuf};

use lavande_mail::config::AccountConfig;
use lavande_mail::error::MailError;
use lavande_mail::model::Folder;
use lavande_mail::store::Store;
use lavande_mail::tls::TlsOptions;

use crate::config_file;
use crate::discovery::{Discovery, DiscoveryEndpoints};
use crate::error::ApiError;

pub const ACCOUNTS_FILE: &str = "accounts.json";
pub const DATABASE_FILE: &str = "mail.db";

pub struct AppState {
    store: Store,
    accounts_path: PathBuf,
    tls: TlsOptions,
    discovery: Discovery,
}

impl AppState {
    /// Opens and migrates the store of `data_dir`. `accounts.json` is read on
    /// demand: the file is the source of truth for the accounts.
    pub fn open(data_dir: impl AsRef<Path>, tls: TlsOptions) -> Result<Self, MailError> {
        Self::open_with(data_dir, tls, DiscoveryEndpoints::default())
    }

    pub fn open_with(
        data_dir: impl AsRef<Path>,
        tls: TlsOptions,
        endpoints: DiscoveryEndpoints,
    ) -> Result<Self, MailError> {
        fs::create_dir_all(data_dir.as_ref())?;
        let store = Store::open(data_dir.as_ref().join(DATABASE_FILE))?;
        store.migrate()?;
        Ok(Self {
            store,
            accounts_path: data_dir.as_ref().join(ACCOUNTS_FILE),
            tls,
            discovery: Discovery::new(endpoints)?,
        })
    }

    pub fn discovery(&self) -> &Discovery {
        &self.discovery
    }

    pub fn tls(&self) -> &TlsOptions {
        &self.tls
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn accounts(&self) -> Result<Vec<AccountConfig>, ApiError> {
        config_file::load(&self.accounts_path)
    }

    pub fn account(&self, id: &str) -> Result<AccountConfig, ApiError> {
        self.accounts()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(|| ApiError::not_found(format!("compte « {id} » inconnu")))
    }

    pub fn add_account(&self, config: &AccountConfig, folders: &[Folder]) -> Result<(), ApiError> {
        let mut accounts = self.accounts()?;
        accounts.push(config.clone());
        config_file::save(&self.accounts_path, &accounts)?;
        self.store
            .upsert_account(&config.id, &config.label, &config.email)?;
        for folder in folders {
            self.store.upsert_folder(folder)?;
        }
        Ok(())
    }

    /// `true` when the account was listed in `accounts.json`.
    pub fn remove_account(&self, id: &str) -> Result<bool, ApiError> {
        let accounts = self.accounts()?;
        if !accounts.iter().any(|account| account.id == id) {
            return Ok(false);
        }
        let kept: Vec<AccountConfig> = accounts
            .into_iter()
            .filter(|account| account.id != id)
            .collect();
        config_file::save(&self.accounts_path, &kept)?;
        Ok(true)
    }
}
