//! `/api/accounts/{id}/zimbra`: socle SOAP Zimbra d'un compte mail.
//!
//! Le mot de passe lu dans le coffre ne sert que dans le corps de
//! l'`AuthRequest` : ni la requête HTTP ni la réponse ne portent d'identifiant
//! ou de jeton. Un compte OAuth2 n'a rien à présenter à Zimbra.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use lavande_mail::config::AuthConfig;
use lavande_mail::soap::{account_endpoint, AccountInfo, SoapClient};

use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/accounts/{id}/zimbra/info", get(info))
}

/// `GetInfo` du serveur Zimbra du compte : nom, identifiant et version.
async fn info(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<AccountInfo>, ApiError> {
    let account = state.account(&id).await?;
    let password = match &account.auth {
        AuthConfig::Password { password } => password.clone(),
        AuthConfig::OAuth2 { .. } => {
            return Err(ApiError::bad_request(
                "zimbra",
                "ce compte utilise OAuth ; Zimbra ne demande que son mot de passe",
            ))
        }
    };
    let username = account.username.trim();
    let username = if username.is_empty() {
        account.email.trim()
    } else {
        username
    };
    let endpoint = account_endpoint(&account.imap.host);
    let client = SoapClient::new(&endpoint, username, &password)?;
    let info = client.get_info().await?;
    tracing::debug!(account = %id, "SOAP Zimbra : GetInfo");
    Ok(Json(info))
}
