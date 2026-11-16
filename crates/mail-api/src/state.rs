//! Shared state: the SQLite store, the accounts file, the secrets and the
//! daemon token.

use std::fs;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use lavande_mail::config::{AccountConfig, AuthConfig};
use lavande_mail::model::Folder;
use lavande_mail::pgp::PgpKeyring;
use lavande_mail::store::Store;
use lavande_mail::tls::TlsOptions;

use crate::calendar_sources::{self, CalendarSource};
use crate::config_file::{self, StoredAccount};
use crate::discovery::{Discovery, DiscoveryEndpoints};
use crate::error::ApiError;
use crate::events::Events;
use crate::oauth_flow::Sessions;
use crate::pgp_keys::PgpStore;
use crate::secrets::{AccountSecrets, SecretBackend, Secrets};
use crate::sync_secrets;
use crate::token;

pub const ACCOUNTS_FILE: &str = "accounts.json";
pub const DATABASE_FILE: &str = "mail.db";

pub struct AppState {
    store: Store,
    accounts_path: PathBuf,
    calendars_path: PathBuf,
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
            calendars_path: data_dir.join(calendar_sources::SOURCES_FILE),
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

    /// One account as `accounts.json` holds it, still without its secrets.
    pub fn stored_account(&self, id: &str) -> Result<StoredAccount, ApiError> {
        self.stored_accounts()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(|| ApiError::not_found(format!("compte « {id} » inconnu")))
    }

    /// Sets the PGP switch of one account. The identity row of the store is
    /// written first: an account known to `accounts.json` but never synced has
    /// no SQLite row yet, and its switch must still be storable.
    pub fn set_pgp_enabled(&self, account: &StoredAccount, enabled: bool) -> Result<(), ApiError> {
        self.store
            .upsert_account(&account.id, &account.label, &account.email)?;
        self.store.set_pgp_enabled(&account.id, enabled)?;
        Ok(())
    }

    /// The keyring one account may decrypt with: the whole one when its PGP
    /// switch is on, an empty one otherwise, so encrypted bodies stay closed.
    pub async fn keyring_for(&self, account_id: &str) -> Result<PgpKeyring, ApiError> {
        if self.store.pgp_enabled(account_id)? {
            self.pgp.keyring().await
        } else {
            Ok(PgpKeyring::new())
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
        let stored = self.stored_account(id)?;
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
        Ok(self.stored_account(id)?.synced_folders)
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
        let indexed = (|| -> Result<(), ApiError> {
            self.store
                .upsert_account(&config.id, &config.label, &config.email)?;
            for folder in folders {
                self.store.upsert_folder(folder)?;
            }
            Ok(())
        })();
        if let Err(error) = indexed {
            let _ = self.secrets.delete(&config.id).await;
            let _ = self.store.delete_account(&config.id);
            return Err(error);
        }
        accounts.push(stored);
        if let Err(error) = self.save_accounts(&mut accounts).await {
            let _ = self.secrets.delete(&config.id).await;
            let _ = self.store.delete_account(&config.id);
            return Err(error);
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

    /// CalDAV sources without their credentials: listing and existence checks.
    pub fn calendar_sources(&self) -> Result<Vec<CalendarSource>, ApiError> {
        calendar_sources::load(&self.calendars_path)
    }

    pub fn calendar_source(&self, id: &str) -> Result<CalendarSource, ApiError> {
        self.calendar_sources()?
            .into_iter()
            .find(|source| source.id == id)
            .ok_or_else(|| ApiError::not_found(format!("source CalDAV « {id} » inconnue")))
    }

    /// Stores the credentials first, then the source: a source whose secrets
    /// could not be written is dropped again. The identifier is derived from
    /// the name and made unique against the sources already stored.
    pub async fn add_calendar_source(
        &self,
        name: &str,
        url: &str,
        calendar_href: Option<String>,
        credentials: AccountSecrets,
    ) -> Result<CalendarSource, ApiError> {
        let mut sources = self.calendar_sources()?;
        let source = CalendarSource {
            id: calendar_sources::unique_id(name, &sources),
            name: name.to_string(),
            url: url.to_string(),
            calendar_href,
            account_id: None,
        };
        let secret_id = calendar_sources::secret_id(&source.id);
        self.secrets.put(&secret_id, &credentials).await?;
        sources.push(source.clone());
        if let Err(error) = calendar_sources::save(&self.calendars_path, &sources) {
            let _ = self.secrets.delete(&secret_id).await;
            return Err(error);
        }
        Ok(source)
    }

    /// Source whose credentials are those of a mail account: nothing is written
    /// to the secret store, so removing the source has nothing to delete.
    pub fn add_account_calendar_source(
        &self,
        name: &str,
        url: &str,
        calendar_href: Option<String>,
        account_id: &str,
    ) -> Result<CalendarSource, ApiError> {
        let mut sources = self.calendar_sources()?;
        let source = CalendarSource {
            id: calendar_sources::unique_id(name, &sources),
            name: name.to_string(),
            url: url.to_string(),
            calendar_href,
            account_id: Some(account_id.to_string()),
        };
        sources.push(source.clone());
        calendar_sources::save(&self.calendars_path, &sources)?;
        Ok(source)
    }

    /// `true` when the source was listed in `calendars.json`.
    pub async fn remove_calendar_source(&self, id: &str) -> Result<bool, ApiError> {
        let sources = self.calendar_sources()?;
        if !sources.iter().any(|source| source.id == id) {
            return Ok(false);
        }
        let kept: Vec<CalendarSource> = sources
            .into_iter()
            .filter(|source| source.id != id)
            .collect();
        calendar_sources::save(&self.calendars_path, &kept)?;
        self.secrets
            .delete(&calendar_sources::secret_id(id))
            .await?;
        Ok(true)
    }

    /// Credentials of one stored source. A source without a usable secret is
    /// an error, never an anonymous request. A source tied to a mail account
    /// borrows the credentials of that account: the password follows the
    /// account instead of being copied here.
    pub async fn calendar_credentials(&self, id: &str) -> Result<(String, String), ApiError> {
        if let Some(account_id) = self.calendar_source(id)?.account_id {
            return self.account_caldav_credentials(&account_id).await;
        }
        match self
            .secrets
            .get(&calendar_sources::secret_id(id))
            .await?
        {
            Some(AccountSecrets::Caldav { username, password }) => Ok((username, password)),
            Some(_) => Err(ApiError::internal(
                "caldav",
                format!("identifiants de la source « {id} » incompatibles avec CalDAV"),
            )),
            None => Err(ApiError::internal(
                "caldav",
                format!(
                    "identifiants de la source « {id} » absents du coffre : supprimez la source et rajoutez-la"
                ),
            )),
        }
    }

    /// Identifiants CalDAV du compte mail lié : son nom d'utilisateur et son
    /// mot de passe, jamais un secret recopié dans le coffre de la source.
    async fn account_caldav_credentials(
        &self,
        account_id: &str,
    ) -> Result<(String, String), ApiError> {
        let account = match self.account(account_id).await {
            Ok(account) => account,
            Err(error) if error.status() == StatusCode::NOT_FOUND => {
                return Err(ApiError::not_found(format!(
                    "le compte mail lié « {account_id} » n'existe plus"
                )))
            }
            Err(error) => return Err(error),
        };
        match account.auth {
            AuthConfig::Password { password } => {
                let username = account.username.trim();
                let username = if username.is_empty() {
                    account.email.trim().to_string()
                } else {
                    username.to_string()
                };
                Ok((username, password))
            }
            AuthConfig::OAuth2 { .. } => Err(ApiError::bad_request(
                "caldav",
                "ce compte utilise OAuth ; ajoutez son agenda via Google",
            )),
        }
    }

    /// Clé privée de l'appareil de synchronisation, `None` tant que le front ne
    /// l'a pas déposée (appareil neuf ou migration pas encore faite).
    pub async fn sync_device_key(&self) -> Result<Option<String>, ApiError> {
        match self.secrets.get(sync_secrets::DEVICE_SECRET_ID).await? {
            Some(AccountSecrets::SyncDevice { private_key }) => Ok(Some(private_key)),
            Some(_) => Err(ApiError::internal(
                "sync",
                "secret d'appareil incompatible : clé privée attendue",
            )),
            None => Ok(None),
        }
    }

    pub async fn set_sync_device_key(&self, private_key: &str) -> Result<(), ApiError> {
        self.secrets
            .put(
                sync_secrets::DEVICE_SECRET_ID,
                &AccountSecrets::SyncDevice {
                    private_key: private_key.to_string(),
                },
            )
            .await
    }

    pub async fn sync_account_token(&self, account_id: &str) -> Result<Option<String>, ApiError> {
        match self
            .secrets
            .get(&sync_secrets::account_secret_id(account_id))
            .await?
        {
            Some(AccountSecrets::SyncAccount { token }) => Ok(Some(token)),
            Some(_) => Err(ApiError::internal(
                "sync",
                format!("secret du compte « {account_id} » incompatible : jeton attendu"),
            )),
            None => Ok(None),
        }
    }

    pub async fn set_sync_account_token(
        &self,
        account_id: &str,
        token: &str,
    ) -> Result<(), ApiError> {
        self.secrets
            .put(
                &sync_secrets::account_secret_id(account_id),
                &AccountSecrets::SyncAccount {
                    token: token.to_string(),
                },
            )
            .await
    }

    pub async fn remove_sync_account_token(&self, account_id: &str) -> Result<(), ApiError> {
        self.secrets
            .delete(&sync_secrets::account_secret_id(account_id))
            .await
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
