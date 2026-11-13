//! OAuth2 « application installée » : consentement dans le navigateur, retour
//! sur la boucle locale du démon, jeton conservé côté service. Le navigateur ne
//! voit jamais de jeton : il est redirigé, puis suit l'état de la session.

use std::collections::HashMap;
use std::env;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use lavande_mail::config::{AccountConfig, AuthConfig, Endpoint};
use lavande_mail::http::client_builder;
use lavande_mail::imap;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::ApiError;
use crate::state::AppState;

const SESSION_TTL: Duration = Duration::from_secs(600);
const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE: &str =
    "https://mail.google.com/ https://www.googleapis.com/auth/calendar openid email";
const MICROSOFT_AUTH: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_SCOPE: &str =
    "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email";

#[derive(Deserialize)]
pub struct StartRequest {
    pub provider: String,
    pub email: String,
    pub label: String,
    pub id: Option<String>,
    pub imap: Endpoint,
    pub smtp: Endpoint,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub token_endpoint: Option<String>,
    #[serde(default)]
    pub auth_endpoint: Option<String>,
}

#[derive(Serialize)]
pub struct StartResponse {
    pub session: String,
    pub auth_url: String,
    pub redirect_uri: String,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct StatusQuery {
    pub session: String,
}

#[derive(Clone)]
struct Provider {
    auth_endpoint: String,
    token_endpoint: String,
    scope: String,
    client_id: String,
    client_secret: Option<String>,
}

enum Outcome {
    Pending,
    CodeReceived { code: String, redirect_uri: String },
    Finishing,
    Done(String),
    Failed(String),
}

struct Session {
    state: String,
    verifier: String,
    provider: Provider,
    config: AccountConfig,
    created: Instant,
    outcome: Outcome,
}

#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, Session>>,
}

impl Sessions {
    fn insert(&self, session: Session) -> String {
        let id = token(24);
        let mut sessions = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        sessions.retain(|_, entry| entry.created.elapsed() < SESSION_TTL);
        sessions.insert(id.clone(), session);
        id
    }

    fn with<F, T>(&self, id: &str, apply: F) -> Option<T>
    where
        F: FnOnce(&mut Session) -> Option<T>,
    {
        let mut sessions = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        sessions.retain(|_, entry| entry.created.elapsed() < SESSION_TTL);
        sessions.get_mut(id).and_then(apply)
    }

    fn by_state<F, T>(&self, state: &str, apply: F) -> Option<T>
    where
        F: FnOnce(&mut Session) -> Option<T>,
    {
        let mut sessions = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        sessions.retain(|_, entry| entry.created.elapsed() < SESSION_TTL);
        sessions
            .values_mut()
            .find(|session| session.state == state)
            .and_then(apply)
    }

    pub fn status(&self, id: &str) -> Option<StatusResponse> {
        self.with(id, |session| {
            let (status, account_id, error) = match &session.outcome {
                Outcome::Pending => ("pending", None, None),
                Outcome::CodeReceived { .. } => ("code_received", None, None),
                Outcome::Finishing => ("pending", None, None),
                Outcome::Done(account) => ("done", Some(account.clone()), None),
                Outcome::Failed(error) => ("failed", None, Some(error.clone())),
            };
            Some(StatusResponse {
                status,
                account_id,
                error,
            })
        })
    }
}

pub async fn start(state: &AppState, request: StartRequest) -> Result<StartResponse, ApiError> {
    let provider = provider_of(&request)?;
    let redirect_uri = format!("{}/api/oauth/callback", state.public_url());
    let verifier = token(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let oauth_state = token(24);

    let config = AccountConfig {
        id: request.id.clone().unwrap_or_else(|| slug(&request.email)),
        label: request.label.clone(),
        email: request.email.clone(),
        username: request.email.clone(),
        imap: request.imap.clone(),
        smtp: request.smtp.clone(),
        auth: AuthConfig::OAuth2 {
            client_id: provider.client_id.clone(),
            client_secret: provider.client_secret.clone().unwrap_or_default(),
            refresh_token: String::new(),
            token_endpoint: provider.token_endpoint.clone(),
        },
    };

    let auth_url = authorize_url(&provider, &redirect_uri, &oauth_state, &challenge)?;
    let session = Session {
        state: oauth_state,
        verifier,
        provider,
        config,
        created: Instant::now(),
        outcome: Outcome::Pending,
    };
    let id = state.sessions().insert(session);
    tracing::info!(session = %id, "consentement OAuth2 demandé");
    Ok(StartResponse {
        session: id,
        auth_url,
        redirect_uri,
    })
}

/// Le navigateur arrive ici après consentement : seule la réception du code a
/// lieu, sans aucun appel réseau (l'application peut être en arrière-plan).
pub async fn callback(state: &AppState, query: CallbackQuery) -> (axum::http::StatusCode, String) {
    let Some(code) = query.code.clone() else {
        if let Some(reason) = &query.error {
            mark_by_state(state, query.state.as_deref(), Err(reason.clone()));
        }
        return (
            axum::http::StatusCode::OK,
            page("Connexion refusée", "Le consentement a été refusé.", false),
        );
    };
    let Some(oauth_state) = query.state.clone() else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            page("Connexion impossible", "Paramètre state manquant.", false),
        );
    };

    let redirect_uri = format!("{}/api/oauth/callback", state.public_url());
    let found = state.sessions().by_state(&oauth_state, |session| {
        if !matches!(session.outcome, Outcome::Pending) {
            return None;
        }
        session.outcome = Outcome::CodeReceived {
            code: code.clone(),
            redirect_uri: redirect_uri.clone(),
        };
        Some(())
    });
    if found.is_none() {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            page(
                "Connexion impossible",
                "Cette demande a expiré ou a déjà servi.",
                false,
            ),
        );
    }

    tracing::info!("code de consentement OAuth2 reçu");
    (
        axum::http::StatusCode::OK,
        page(
            "Consentement enregistré",
            "Revenez à Lavande : la connexion se termine automatiquement.",
            true,
        ),
    )
}

/// Échange le code reçu, appelé au retour de l'application au premier plan.
pub async fn complete(state: &AppState, session: &str) -> Result<StatusResponse, ApiError> {
    let received = state.sessions().with(session, |entry| {
        let (code, redirect_uri) = match &entry.outcome {
            Outcome::CodeReceived { code, redirect_uri } => (code.clone(), redirect_uri.clone()),
            _ => return None,
        };
        let provider = entry.provider.clone();
        let verifier = entry.verifier.clone();
        let config = entry.config.clone();
        entry.outcome = Outcome::Finishing;
        Some((provider, verifier, config, code, redirect_uri))
    });
    let Some((provider, verifier, config, code, redirect_uri)) = received else {
        return status(state, session);
    };

    let outcome = match finish(state, provider, verifier, config, code, redirect_uri).await {
        Ok(account_id) => {
            tracing::info!(account = %account_id, "compte OAuth2 connecté");
            Ok(account_id)
        }
        Err(error) => {
            let message = error.message().to_string();
            tracing::warn!(error = %message, "connexion OAuth2 refusée");
            Err(message)
        }
    };
    state.sessions().with(session, |entry| {
        entry.outcome = match outcome {
            Ok(account_id) => Outcome::Done(account_id),
            Err(error) => Outcome::Failed(error),
        };
        Some(())
    });
    status(state, session)
}

pub fn status(state: &AppState, session: &str) -> Result<StatusResponse, ApiError> {
    state
        .sessions()
        .status(session)
        .ok_or_else(|| ApiError::not_found("session OAuth2 inconnue ou expirée"))
}

async fn finish(
    state: &AppState,
    provider: Provider,
    verifier: String,
    mut config: AccountConfig,
    code: String,
    redirect_uri: String,
) -> Result<String, ApiError> {
    let refresh_token = exchange(&provider, &verifier, &code, &redirect_uri).await?;
    config.auth = AuthConfig::OAuth2 {
        client_id: provider.client_id,
        client_secret: provider.client_secret.unwrap_or_default(),
        refresh_token,
        token_endpoint: provider.token_endpoint,
    };
    config.validate()?;

    if state
        .stored_accounts()?
        .iter()
        .any(|known| known.id == config.id)
    {
        return Err(ApiError::conflict(
            "config",
            format!("le compte « {} » existe déjà", config.id),
        ));
    }
    let mut session = imap::connect_with(&config, state.tls()).await?;
    let folders = imap::list_folders(&mut session, &config.id).await?;
    let _ = session.logout().await;
    state.add_account(&config, &folders).await?;
    Ok(config.id)
}

async fn exchange(
    provider: &Provider,
    verifier: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<String, ApiError> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", provider.client_id.as_str()),
        ("code_verifier", verifier),
    ];
    if let Some(secret) = &provider.client_secret {
        form.push(("client_secret", secret.as_str()));
    }
    let client = client_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| ApiError::internal("oauth", format!("client HTTP : {error}")))?;
    let response = client
        .post(&provider.token_endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|error| {
            let mut message = format!("{error}");
            let mut cause = std::error::Error::source(&error);
            while let Some(source) = cause {
                message.push_str(&format!(" → {source}"));
                cause = source.source();
            }
            ApiError::gateway("oauth", format!("échange du code impossible : {message}"))
        })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ApiError::gateway(
            "oauth",
            format!("le fournisseur a refusé le code ({})", status.as_u16()),
        ));
    }
    let payload: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
        ApiError::gateway(
            "oauth",
            format!("réponse du fournisseur illisible : {error}"),
        )
    })?;
    payload
        .get("refresh_token")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError::gateway(
                "oauth",
                "aucun refresh token : l'accès hors ligne n'a pas été accordé",
            )
        })
}

fn provider_of(request: &StartRequest) -> Result<Provider, ApiError> {
    let provider = request.provider.to_ascii_lowercase();
    let (auth_default, token_default, scope_default) = match provider.as_str() {
        "google" => (GOOGLE_AUTH, GOOGLE_TOKEN, GOOGLE_SCOPE),
        "microsoft" => (MICROSOFT_AUTH, MICROSOFT_TOKEN, MICROSOFT_SCOPE),
        "custom" => ("", "", ""),
        other => {
            return Err(ApiError::bad_request(
                "config",
                format!("fournisseur OAuth2 inconnu : « {other} »"),
            ))
        }
    };
    let auth_endpoint = request
        .auth_endpoint
        .clone()
        .unwrap_or_else(|| auth_default.to_string());
    let token_endpoint = request
        .token_endpoint
        .clone()
        .unwrap_or_else(|| token_default.to_string());
    if auth_endpoint.is_empty() || token_endpoint.is_empty() {
        return Err(ApiError::bad_request(
            "config",
            "fournisseur « custom » : auth_endpoint et token_endpoint sont obligatoires",
        ));
    }
    let client_id = request
        .client_id
        .clone()
        .or_else(|| {
            env::var(format!(
                "LAVANDE_MAIL_{}_CLIENT_ID",
                provider.to_uppercase()
            ))
            .ok()
        })
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad_request(
                "config",
                format!(
                    "aucun identifiant d'application pour « {provider} » : renseigne client_id \
                     (ou LAVANDE_MAIL_{}_CLIENT_ID)",
                    provider.to_uppercase()
                ),
            )
        })?;
    let client_secret = request.client_secret.clone().or_else(|| {
        env::var(format!(
            "LAVANDE_MAIL_{}_CLIENT_SECRET",
            provider.to_uppercase()
        ))
        .ok()
    });
    Ok(Provider {
        auth_endpoint,
        token_endpoint,
        scope: request
            .scope
            .clone()
            .unwrap_or_else(|| scope_default.to_string()),
        client_id,
        client_secret,
    })
}

fn authorize_url(
    provider: &Provider,
    redirect_uri: &str,
    oauth_state: &str,
    challenge: &str,
) -> Result<String, ApiError> {
    let mut url = Url::parse(&provider.auth_endpoint).map_err(|error| {
        ApiError::bad_request("config", format!("auth_endpoint invalide : {error}"))
    })?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", &provider.client_id);
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("scope", &provider.scope);
        query.append_pair("state", oauth_state);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        if provider.auth_endpoint == GOOGLE_AUTH {
            query.append_pair("access_type", "offline");
            query.append_pair("prompt", "consent");
        }
    }
    Ok(url.to_string())
}

fn mark_by_state(state: &AppState, oauth_state: Option<&str>, outcome: Result<String, String>) {
    let Some(oauth_state) = oauth_state else {
        return;
    };
    let sessions = state.sessions();
    let mut guard = sessions
        .inner
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(session) = guard.values_mut().find(|entry| entry.state == oauth_state) {
        session.outcome = match outcome {
            Ok(account) => Outcome::Done(account),
            Err(error) => Outcome::Failed(error),
        };
    }
}

fn page(title: &str, message: &str, success: bool) -> String {
    let accent = if success { "#3f9d6b" } else { "#b0455c" };
    let safe_title = escape(title);
    let safe_message = escape(message);
    format!(
        "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>Lavande — {safe_title}</title></head>\
         <body style=\"margin:0;min-height:100vh;display:grid;place-items:center;\
         font:16px/1.5 system-ui,sans-serif;background:#faf8ff;color:#241d33\">\
         <main style=\"max-width:420px;padding:32px;text-align:center\">\
         <div style=\"width:48px;height:48px;margin:0 auto 16px;border-radius:16px;\
         background:{accent};color:#fff;display:grid;place-items:center;font-size:24px\">\
         {mark}</div><h1 style=\"font-size:20px;margin:0 0 8px\">{safe_title}</h1>\
         <p style=\"margin:0;color:#5b5370\">{safe_message}</p></main></body></html>",
        mark = if success { "✓" } else { "!" }
    )
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

pub fn slug(email: &str) -> String {
    let slug: String = email
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "compte".to_string()
    } else {
        trimmed
    }
}
