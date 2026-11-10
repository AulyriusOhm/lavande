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
use crate::events::Events;
use crate::oauth_flow::Sessions;

pub const ACCOUNTS_FILE: &str = "accounts.json";
pub const DATABASE_FILE: &str = "mail.db";

pub struct AppState {
    store: Store,
    accounts_path: PathBuf,
    tls: TlsOptions,
    discovery: Discovery,
    sessions: Sessions,
    events: Events,
    public_url: String,
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
            sessions: Sessions::default(),
            events: Events::default(),
            public_url: env_url(),
        })
    }

    pub fn discovery(&self) -> &Discovery {
        &self.discovery
    }

    pub fn sessions(&self) -> &Sessions {
        &self.sessions
    }

    pub fn events(&self) -> &Events {
        &self.events
    }

    /// Base publique du démon, utilisée comme `redirect_uri` OAuth2.
    pub fn public_url(&self) -> &str {
        &self.public_url
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

fn env_url() -> String {
    std::env::var("LAVANDE_MAIL_PUBLIC_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            let bind =
                std::env::var("LAVANDE_MAIL_BIND").unwrap_or_else(|_| "127.0.0.1:8790".to_string());
            format!("http://{bind}")
        })
        .trim_end_matches('/')
        .to_string()
}
