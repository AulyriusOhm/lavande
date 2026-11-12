//! OAuth2 refresh-token exchange and XOAUTH2 authentication payloads.
//!
//! Only the refresh flow lives here: the browser consent flow is out of scope,
//! so a refresh token is assumed to be provisioned by the caller.

use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::MailError;
use crate::http::client_builder;

/// Google token endpoint, used when the account config leaves it empty.
pub const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

const EXPIRY_MARGIN: u64 = 60;

/// SASL XOAUTH2 initial response: `user=<email>\x01auth=Bearer <token>\x01\x01`.
pub fn xoauth2_payload(email: &str, access_token: &str) -> String {
    format!("user={email}\x01auth=Bearer {access_token}\x01\x01")
}

/// IMAP `AUTHENTICATE XOAUTH2` responder.
pub struct XOAuth2Authenticator {
    email: String,
    access_token: String,
}

impl XOAuth2Authenticator {
    pub fn new(email: impl Into<String>, access_token: impl Into<String>) -> Self {
        Self {
            email: email.into(),
            access_token: access_token.into(),
        }
    }
}

impl async_imap::Authenticator for XOAuth2Authenticator {
    type Response = String;

    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        xoauth2_payload(&self.email, &self.access_token)
    }
}

/// Exchanges a refresh token for an access token and keeps it in memory until
/// it nears expiry. Secrets never appear in error messages.
pub struct OAuth2Provider {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    token_endpoint: String,
    http: reqwest::Client,
    cached: Option<CachedToken>,
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

impl OAuth2Provider {
    pub fn new(
        client_id: impl Into<String>,
        client_secret: impl Into<String>,
        refresh_token: impl Into<String>,
        token_endpoint: impl Into<String>,
    ) -> Self {
        let token_endpoint = token_endpoint.into();
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            refresh_token: refresh_token.into(),
            token_endpoint: if token_endpoint.is_empty() {
                GOOGLE_TOKEN_ENDPOINT.to_string()
            } else {
                token_endpoint
            },
            http: client_builder().build().expect("client HTTP OAuth2"),
            cached: None,
        }
    }

    pub async fn access_token(&mut self) -> Result<String, MailError> {
        if let Some(cached) = &self.cached {
            if Instant::now() < cached.expires_at {
                return Ok(cached.access_token.clone());
            }
        }

        let response = self
            .http
            .post(&self.token_endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", self.refresh_token.as_str()),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
            ])
            .send()
            .await
            .map_err(|error| MailError::OAuth(format!("token request failed: {error}")))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| MailError::OAuth(format!("token response unreadable: {error}")))?;

        if !status.is_success() {
            return Err(MailError::OAuth(format!(
                "token endpoint refused the refresh token ({}): {}",
                status.as_u16(),
                token_error(&body)
            )));
        }

        let token: TokenResponse = serde_json::from_str(&body)
            .map_err(|error| MailError::OAuth(format!("invalid token response: {error}")))?;
        let lifetime = token.expires_in.saturating_sub(EXPIRY_MARGIN);
        self.cached = Some(CachedToken {
            access_token: token.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(lifetime),
        });
        Ok(token.access_token)
    }
}

fn token_error(body: &str) -> String {
    match serde_json::from_str::<TokenError>(body) {
        Ok(error) => match error.error_description {
            Some(description) => format!("{} ({description})", error.error),
            None => error.error,
        },
        Err(_) => "unexpected error response".to_string(),
    }
}
