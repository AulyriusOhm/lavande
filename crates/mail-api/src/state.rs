//! Shared state: the SQLite store, the accounts file, the secrets and the
//! daemon token.

use std::fs;
use std::path::{Path, PathBuf};

use lavande_mail::config::AccountConfig;
use lavande_mail::model::Folder;
use lavande_mail::store::Store;
use lavande_mail::tls::TlsOptions;

use crate::config_file::{self, StoredAccount};
use crate::discovery::{Discovery, DiscoveryEndpoints};
use crate::error::ApiError;
use crate::events::Events;
use crate::oauth_flow::Sessions;
use crate::pgp_keys::PgpStore;
use crate::secrets::{SecretBackend, Secrets};
use crate::token;

pub const ACCOUNTS_FILE: &str = "accounts.json";
pub const DATABASE_FILE: &str = "mail.db";

pub struct AppState {
    store: Store,
    accounts_path: PathBuf,
    secrets: Secrets,
    token: String,
    tls: TlsOptions,
    discovery: Discovery,
    sessions: Sessions,
    events: Events,
    pgp: PgpStore,
    public_url: String,
}

impl AppState {
    /// Opens and migrates the store of `data_dir`. `accounts.json` is read on
    /// demand: the file is the source of truth for the accounts. Secrets live
    /// outside it (keychain or encrypted file) and legacy inline secrets are
    /// migrated on open.
    pub async fn open(data_dir: impl AsRef<Path>, tls: TlsOptions) -> Result<Self, ApiError> {
        Self::open_with(
            data_dir,
            tls,
            DiscoveryEndpoints::default(),
            SecretBackend::from_env()?,
        )
        .await
    }

    pub async fn open_with(
        data_dir: impl AsRef<Path>,
        tls: TlsOptions,
        endpoints: DiscoveryEndpoints,
        backend: SecretBackend,
    ) -> Result<Self, ApiError> {
        let data_dir = data_dir.as_ref();
        fs::create_dir_all(data_dir)?;
        let store = Store::open(data_dir.join(DATABASE_FILE))?;
        store.migrate()?;
        let secrets = Secrets::open(backend, data_dir).await?;
        let pgp = PgpStore::open(data_dir, secrets.clone());
        let token = token::load_or_create(data_dir)?;
        let state = Self {
            store,
            accounts_path: data_dir.join(ACCOUNTS_FILE),
            secrets,
            token,
            tls,
            discovery: Discovery::new(endpoints)?,
            sessions: Sessions::default(),
            events: Events::default(),
            pgp,
            public_url: env_url(),
        };
        state.migrate_inline_secrets().await?;
        Ok(state)
    }

    /// Legacy `accounts.json` carried passwords and refresh tokens inline:
    /// move them to the secret store once, then rewrite the file stripped.
    async fn migrate_inline_secrets(&self) -> Result<(), ApiError> {
        let mut accounts = config_file::load(&self.accounts_path)?;
        let migrated = self.extract_secrets(&mut accounts).await?;
        if migrated > 0 {
            config_file::save(&self.accounts_path, &accounts)?;
            tracing::info!(
                accounts = migrated,
                "secrets déplacés hors de accounts.json"
            );
        }
        Ok(())
    }

    /// Moves any inline secret to the secret store; returns how many moved.
    async fn extract_secrets(&self, accounts: &mut [StoredAccount]) -> Result<usize, ApiError> {
        let mut moved = 0;
        for account in accounts.iter_mut() {
            if let Some(secrets) = account.take_secrets() {
                self.secrets.put(&account.id, &secrets).await?;
                moved += 1;
            }
        }
        Ok(moved)
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

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn secrets(&self) -> &Secrets {
        &self.secrets
    }

    pub fn pgp(&self) -> &PgpStore {
        &self.pgp
    }

    /// Accounts without their secrets: listing, duplicate and existence checks.
    pub fn stored_accounts(&self) -> Result<Vec<StoredAccount>, ApiError> {
        config_file::load(&self.accounts_path)
    }

    pub fn ensure_account(&self, id: &str) -> Result<(), ApiError> {
        if self
            .stored_accounts()?
            .iter()
            .any(|account| account.id == id)
        {
            Ok(())
        } else {
            Err(ApiError::not_found(format!("compte « {id} » inconnu")))
        }
    }

    pub async fn accounts(&self) -> Result<Vec<AccountConfig>, ApiError> {
        let stored = self.stored_accounts()?;
        let mut configs = Vec::with_capacity(stored.len());
        for account in stored {
            let secrets = self.secrets.get(&account.id).await?;
            configs.push(account.into_config(secrets)?);
        }
        Ok(configs)
    }

    pub async fn account(&self, id: &str) -> Result<AccountConfig, ApiError> {
        let stored = self
            .stored_accounts()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(|| ApiError::not_found(format!("compte « {id} » inconnu")))?;
        let secrets = self.secrets.get(id).await?;
        stored.into_config(secrets)
    }

    /// Updates the label of one account only: the email, the endpoints and the
    /// secrets stay untouched.
    pub async fn rename_account(&self, id: &str, label: &str) -> Result<StoredAccount, ApiError> {
        let mut accounts = self.stored_accounts()?;
        let account = accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| ApiError::not_found(format!("compte « {id} » inconnu")))?;
        account.label = label.to_string();
        let renamed = account.clone();
        self.save_accounts(&mut accounts).await?;
        self.store.upsert_account(id, label, &renamed.email)?;
        Ok(renamed)
    }

    /// Which folders an account syncs. `None` means the default selection
    /// (every folder with a known role).
    pub fn sync_folders(&self, id: &str) -> Result<Option<Vec<String>>, ApiError> {
        let account = self
            .stored_accounts()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(|| ApiError::not_found(format!("compte « {id} » inconnu")))?;
        Ok(account.synced_folders)
    }

    pub async fn add_account(
        &self,
        config: &AccountConfig,
        folders: &[Folder],
    ) -> Result<(), ApiError> {
        let mut accounts = self.stored_accounts()?;
        let mut stored = StoredAccount::from_config(config);
        if let Some(secrets) = stored.take_secrets() {
            self.secrets.put(&config.id, &secrets).await?;
        }
        accounts.push(stored);
        if let Err(error) = self.save_accounts(&mut accounts).await {
            let _ = self.secrets.delete(&config.id).await;
            return Err(error);
        }
        self.store
            .upsert_account(&config.id, &config.label, &config.email)?;
        for folder in folders {
            self.store.upsert_folder(folder)?;
        }
        Ok(())
    }

    /// Records the folder selection of one account only: the label, the
    /// endpoints and the secrets stay untouched.
    pub async fn update_sync_folders(
        &self,
        id: &str,
        folders: Option<Vec<String>>,
    ) -> Result<StoredAccount, ApiError> {
        let mut accounts = self.stored_accounts()?;
        let account = accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| ApiError::not_found(format!("compte « {id} » inconnu")))?;
        account.synced_folders = folders;
        let updated = account.clone();
        self.save_accounts(&mut accounts).await?;
        Ok(updated)
    }

    /// `true` when the account was listed in `accounts.json`.
    pub async fn remove_account(&self, id: &str) -> Result<bool, ApiError> {
        let accounts = self.stored_accounts()?;
        if !accounts.iter().any(|account| account.id == id) {
            return Ok(false);
        }
        let mut kept: Vec<StoredAccount> = accounts
            .into_iter()
            .filter(|account| account.id != id)
            .collect();
        self.save_accounts(&mut kept).await?;
        self.secrets.delete(id).await?;
        Ok(true)
    }

    async fn save_accounts(&self, accounts: &mut [StoredAccount]) -> Result<(), ApiError> {
        self.extract_secrets(accounts).await?;
        config_file::save(&self.accounts_path, accounts)
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
