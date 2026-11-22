//! `/api/contacts`: the addresses the mailbox has traded mail with, every
//! account merged. The store collects them as it imports headers; this route
//! only reads them. The CardDAV sync of one account is here too: it is what
//! fills the same table with the entries of the directory, so the reader's
//! autocompletion proposes colleagues it never exchanged mail with.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use lavande_mail::carddav::CarddavClient;
use lavande_mail::config::{AccountConfig, AuthConfig};
use lavande_mail::store::Contact;
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/contacts", get(contacts))
        .route("/api/accounts/{id}/carddav/sync", post(carddav_sync))
}

#[derive(Deserialize)]
struct ContactsQuery {
    q: Option<String>,
    limit: Option<i64>,
}

async fn contacts(
    Query(params): Query<ContactsQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Contact>>, ApiError> {
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let query = params.q.as_deref().unwrap_or("");
    Ok(Json(state.store().contacts(query, limit)?))
}

#[derive(Deserialize, Default)]
struct CarddavSyncRequest {
    /// Serveur CardDAV du compte ; par défaut `https://<hôte IMAP>/dav/`.
    #[serde(default)]
    url: Option<String>,
}

/// What one sync did: the addresses the directory holds, and the cards it could
/// not read.
#[derive(Serialize)]
struct CarddavSyncReport {
    count: usize,
    skipped: usize,
}

/// Reads the CardDAV address book of one account into the contact list. The
/// password of the account is the only credential, and it only travels to the
/// account's own server.
async fn carddav_sync(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<CarddavSyncReport>, ApiError> {
    let request: CarddavSyncRequest = if body.is_empty() {
        CarddavSyncRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|error| {
            ApiError::bad_request("carddav", format!("corps de la requête refusé : {error}"))
        })?
    };
    let account = state.account(&id).await?;
    let (username, password) = credentials(&account)?;
    let base = dav_base(&account, request.url.as_deref())?;
    let client = CarddavClient::new(base.as_str(), &username, &password)?;
    let book = client.contacts(&account.email).await?;
    let seen_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    state
        .store()
        .sync_directory_contacts(&id, &book.contacts, &seen_at)?;
    tracing::info!(
        account = %id,
        contacts = book.contacts.len(),
        skipped = book.skipped,
        "carnet CardDAV synchronisé"
    );
    Ok(Json(CarddavSyncReport {
        count: book.contacts.len(),
        skipped: book.skipped,
    }))
}

/// Identifiants du carnet d'un compte : son mot de passe, jamais un secret
/// recopié ailleurs. Un compte OAuth n'a pas de carnet Zimbra à lire ici.
fn credentials(account: &AccountConfig) -> Result<(String, String), ApiError> {
    let password = match &account.auth {
        AuthConfig::Password { password } => password.clone(),
        AuthConfig::OAuth2 { .. } => {
            return Err(ApiError::bad_request(
                "carddav",
                "ce compte utilise OAuth ; son carnet n'est pas joignable par mot de passe",
            ))
        }
    };
    let username = account.username.trim();
    let username = match username.is_empty() {
        true => account.email.trim(),
        false => username,
    };
    if username.is_empty() {
        return Err(ApiError::bad_request(
            "carddav",
            "le compte n'a ni nom d'utilisateur ni adresse",
        ));
    }
    Ok((username.to_string(), password))
}

/// URL du carnet : `https://<hôte IMAP>/dav/` par défaut, ou celle de la
/// requête quand elle vise le même serveur. Le mot de passe du compte ne part
/// que vers son propre serveur mail.
fn dav_base(account: &AccountConfig, url: Option<&str>) -> Result<reqwest::Url, ApiError> {
    let raw = match url.map(str::trim).filter(|url| !url.is_empty()) {
        Some(url) => url.to_string(),
        None => format!("https://{}/dav/", account.imap.host.trim()),
    };
    let base = reqwest::Url::parse(&raw).map_err(|error| {
        ApiError::bad_request("carddav", format!("URL CardDAV invalide : {error}"))
    })?;
    let host = base.host_str().unwrap_or_default();
    if !host.eq_ignore_ascii_case(account.imap.host.trim()) {
        return Err(ApiError::bad_request(
            "carddav",
            "l'URL doit viser le serveur mail du compte",
        ));
    }
    let loopback = matches!(host, "127.0.0.1" | "::1" | "localhost");
    if base.scheme() != "https" && !(loopback && base.scheme() == "http") {
        return Err(ApiError::bad_request(
            "carddav",
            "HTTPS requis pour le carnet du compte",
        ));
    }
    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lavande_mail::config::{Encryption, Endpoint};

    fn account(host: &str, auth: AuthConfig) -> AccountConfig {
        let endpoint = Endpoint {
            host: host.to_string(),
            port: 993,
            encryption: Encryption::Tls,
        };
        AccountConfig {
            id: "perso".to_string(),
            label: "Perso".to_string(),
            email: "roman@lavande.mail".to_string(),
            username: String::new(),
            imap: endpoint.clone(),
            smtp: Endpoint {
                port: 465,
                ..endpoint
            },
            auth,
            synced_folders: None,
        }
    }

    fn password() -> AuthConfig {
        AuthConfig::Password {
            password: "secret".to_string(),
        }
    }

    #[test]
    fn the_address_book_lives_on_the_mail_server() {
        let config = account("zimbra.exemple.tld", password());
        assert_eq!(
            dav_base(&config, None).expect("URL").as_str(),
            "https://zimbra.exemple.tld/dav/"
        );
        // Un compte sans nom d'utilisateur s'authentifie avec son adresse.
        assert_eq!(
            credentials(&config).expect("identifiants").0,
            "roman@lavande.mail"
        );
    }

    #[test]
    fn a_url_outside_the_mail_server_is_refused() {
        let config = account("zimbra.exemple.tld", password());
        let error = dav_base(&config, Some("https://ailleurs.tld/dav/")).expect_err("refus");
        assert!(error.message().contains("serveur mail"), "{error:?}");
    }

    #[test]
    fn cleartext_is_only_allowed_on_the_loopback() {
        let config = account("127.0.0.1", password());
        assert!(dav_base(&config, Some("http://127.0.0.1:8080/dav/")).is_ok());
        let remote = account("zimbra.exemple.tld", password());
        assert!(dav_base(&remote, Some("http://zimbra.exemple.tld/dav/")).is_err());
    }

    #[test]
    fn an_oauth_account_has_no_password_address_book() {
        let config = account(
            "imap.gmail.com",
            AuthConfig::OAuth2 {
                client_id: "id".to_string(),
                client_secret: "secret".to_string(),
                refresh_token: "refresh".to_string(),
                token_endpoint: "https://oauth2.googleapis.com/token".to_string(),
            },
        );
        let error = credentials(&config).expect_err("refus");
        assert!(error.message().contains("OAuth"), "{error:?}");
        assert!(!error.message().contains("refresh"), "{error:?}");
    }
}
