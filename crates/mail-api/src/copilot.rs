//! GitHub Copilot pour l'agent IA : device flow OAuth exécuté par le démon (le
//! navigateur ne voit jamais de jeton), jetons rangés dans le coffre de secrets,
//! puis proxy chat vers `api.githubcopilot.com`.
//!
//! Le client_id embarqué par défaut est l'identifiant public de VS Code : Roman a
//! acté cette zone grise des conditions d'utilisation de GitHub, un client_id
//! propre peut le remplacer à la demande.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::{header, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::oauth_flow::token;
use crate::state::AppState;

pub const SECRET_ID: &str = "llm:copilot";

const DEFAULT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const SCOPE: &str = "read:user";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
pub const EDITOR_VERSION: &str = "Lavande/0.2.18";
const INTEGRATION_ID: &str = "vscode-chat";
const SESSION_TTL: Duration = Duration::from_secs(600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const REFRESH_MARGIN_SECS: i64 = 60;
const UNKNOWN_SESSION: &str = "session GitHub Copilot inconnue ou expirée";

/// Points d'entrée GitHub, Copilot et budget du proxy chat : surchargeables pour
/// les tests, valeurs réelles par défaut.
#[derive(Clone, Debug)]
pub struct Settings {
    pub github: String,
    pub api: String,
    pub copilot: String,
    pub chat_timeout: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            github: "https://github.com".to_string(),
            api: "https://api.github.com".to_string(),
            copilot: "https://api.githubcopilot.com".to_string(),
            chat_timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CopilotTokens {
    pub github_token: String,
    pub copilot_token: Option<String>,
    pub expires_at: Option<i64>,
    pub login: Option<String>,
}

#[derive(Deserialize)]
pub struct StartRequest {
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Serialize)]
pub struct StartResponse {
    pub session: String,
    pub verification_uri: String,
    pub user_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub status: &'static str,
    pub interval: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
}

#[derive(Deserialize)]
pub struct StatusQuery {
    pub session: String,
}

#[derive(Serialize)]
pub struct ConnectionResponse {
    pub connected: bool,
    pub login: Option<String>,
}

#[derive(Serialize)]
pub struct LogoutResponse {
    pub ok: bool,
}

#[derive(Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

enum Phase {
    Waiting,
    Finishing { github_token: String },
    Done { login: Option<String> },
    Failed(String),
    Expired,
}

struct Session {
    device_code: String,
    client_id: String,
    interval: u64,
    created: Instant,
    phase: Phase,
}

struct Attempt {
    device_code: String,
    client_id: String,
}

enum Next {
    Poll(Attempt),
    Finish { github_token: String },
    Report(StatusResponse),
}

enum Polled {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Failed(String),
    Authorized(String),
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
}

impl Session {
    fn next(&mut self) -> Next {
        match &self.phase {
            Phase::Waiting => Next::Poll(Attempt {
                device_code: self.device_code.clone(),
                client_id: self.client_id.clone(),
            }),
            Phase::Finishing { github_token } => Next::Finish {
                github_token: github_token.clone(),
            },
            _ => Next::Report(self.report()),
        }
    }

    fn report(&self) -> StatusResponse {
        let (status, error, login) = match &self.phase {
            Phase::Waiting | Phase::Finishing { .. } => ("pending", None, None),
            Phase::Done { login } => ("done", None, login.clone()),
            Phase::Failed(error) => ("failed", Some(error.clone()), None),
            Phase::Expired => ("expired", None, None),
        };
        StatusResponse {
            status,
            interval: self.interval,
            error,
            login,
        }
    }
}

pub async fn start(state: &AppState, request: StartRequest) -> Result<StartResponse, ApiError> {
    let client_id = request
        .client_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());
    let response = http_client(REQUEST_TIMEOUT)?
        .post(format!("{}/login/device/code", state.copilot().github))
        .header(header::ACCEPT, "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|error| {
            ApiError::gateway(
                "copilot",
                format!("GitHub injoignable pour démarrer la connexion : {error}"),
            )
        })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let reason = reason_of(&body).unwrap_or_else(|| format!("code {}", status.as_u16()));
        return Err(ApiError::gateway(
            "copilot",
            format!(
                "GitHub a refusé de démarrer la connexion ({reason}). Réessaie dans un instant."
            ),
        ));
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| {
        ApiError::gateway("copilot", format!("réponse de GitHub illisible : {error}"))
    })?;
    let field = |name: &str| {
        payload
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let incomplete = || {
        ApiError::gateway(
            "copilot",
            "réponse de GitHub incomplète : réessaie dans un instant.",
        )
    };
    let device_code = field("device_code").ok_or_else(incomplete)?;
    let user_code = field("user_code").ok_or_else(incomplete)?;
    let verification_uri = field("verification_uri").ok_or_else(incomplete)?;
    let interval = payload.get("interval").and_then(Value::as_u64).unwrap_or(5);
    let expires_in = payload
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(900);
    let id = state.copilot_sessions().insert(Session {
        device_code,
        client_id,
        interval,
        created: Instant::now(),
        phase: Phase::Waiting,
    });
    tracing::info!(session = %id, "connexion GitHub Copilot demandée");
    Ok(StartResponse {
        session: id,
        verification_uri,
        user_code,
        interval,
        expires_in,
    })
}

pub async fn status(state: &AppState, id: &str) -> Result<StatusResponse, ApiError> {
    match state
        .copilot_sessions()
        .with(id, |session| Some(session.next()))
    {
        Some(Next::Report(response)) => Ok(response),
        Some(Next::Poll(attempt)) => poll(state, id, attempt).await,
        Some(Next::Finish { github_token }) => finish(state, id, &github_token).await,
        None => Err(ApiError::not_found(UNKNOWN_SESSION)),
    }
}

pub async fn connection(state: &AppState) -> Result<ConnectionResponse, ApiError> {
    let tokens = state.copilot_tokens().await?;
    Ok(ConnectionResponse {
        connected: tokens.is_some(),
        login: tokens.and_then(|tokens| tokens.login),
    })
}

pub async fn logout(state: &AppState) -> Result<LogoutResponse, ApiError> {
    state.remove_copilot_tokens().await?;
    Ok(LogoutResponse { ok: true })
}

pub async fn chat(state: &AppState, request: ChatRequest) -> Result<Value, ApiError> {
    if request.messages.is_empty() {
        return Err(ApiError::bad_request(
            "copilot",
            "aucun message à envoyer au modèle",
        ));
    }
    let settings = state.copilot().clone();
    let Some(tokens) = state.copilot_tokens().await? else {
        return Err(ApiError::conflict(
            "copilot",
            "Connecte ton compte GitHub Copilot dans les réglages IA.",
        ));
    };
    let copilot_token = fresh_token(state, &settings, &tokens).await?;
    let mut body = json!({ "model": request.model, "messages": request.messages });
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    let response = http_client(settings.chat_timeout)?
        .post(format!("{}/chat/completions", settings.copilot))
        .header(header::AUTHORIZATION, format!("Bearer {copilot_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header("Copilot-Integration-Id", INTEGRATION_ID)
        .header("Editor-Version", EDITOR_VERSION)
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                ApiError::new(
                    StatusCode::GATEWAY_TIMEOUT,
                    "copilot",
                    format!(
                        "GitHub Copilot n'a pas répondu en {} s : réessaie avec une demande plus courte.",
                        settings.chat_timeout.as_secs().max(1)
                    ),
                )
            } else {
                ApiError::gateway(
                    "copilot",
                    format!("GitHub Copilot injoignable : {error}"),
                )
            }
        })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(refusal(status, &text));
    }
    let payload: Value = serde_json::from_str(&text).map_err(|error| {
        ApiError::gateway("copilot", format!("réponse du modèle illisible : {error}"))
    })?;
    let answered = payload
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            !choices.is_empty() && choices[0].get("message").is_some_and(Value::is_object)
        });
    if !answered {
        return Err(ApiError::gateway(
            "copilot",
            "réponse du modèle incomplète : aucun message retourné.",
        ));
    }
    Ok(payload)
}

async fn poll(state: &AppState, id: &str, attempt: Attempt) -> Result<StatusResponse, ApiError> {
    let polled = match poll_device(state.copilot(), &attempt).await {
        Ok(polled) => polled,
        Err(error) => {
            tracing::warn!(
                error = %error.message(),
                "interrogation de GitHub Copilot interrompue : nouvel essai au prochain appel"
            );
            return report(state, id);
        }
    };
    match polled {
        Polled::Authorized(github_token) => {
            let stored = state.copilot_sessions().with(id, |session| {
                session.phase = Phase::Finishing {
                    github_token: github_token.clone(),
                };
                Some(())
            });
            if stored.is_none() {
                return Err(ApiError::not_found(UNKNOWN_SESSION));
            }
            finish(state, id, &github_token).await
        }
        other => {
            let updated =
                state.copilot_sessions().with(id, |session| {
                    match other {
                        Polled::Pending => {}
                        Polled::SlowDown => session.interval += 5,
                        Polled::Expired => session.phase = Phase::Expired,
                        Polled::Denied => session.phase = Phase::Failed(
                            "autorisation refusée sur GitHub : relance la connexion et autorise \
                             l'accès Copilot."
                                .to_string(),
                        ),
                        Polled::Failed(message) => session.phase = Phase::Failed(message),
                        Polled::Authorized(_) => {}
                    }
                    Some(session.report())
                });
            updated.ok_or_else(|| ApiError::not_found(UNKNOWN_SESSION))
        }
    }
}

async fn finish(
    state: &AppState,
    id: &str,
    github_token: &str,
) -> Result<StatusResponse, ApiError> {
    let settings = state.copilot().clone();
    match connect(&settings, github_token).await {
        Ok(tokens) => {
            state.set_copilot_tokens(&tokens).await?;
            let login = tokens.login.clone();
            state.copilot_sessions().with(id, |session| {
                session.phase = Phase::Done {
                    login: login.clone(),
                };
                Some(())
            });
            tracing::info!(
                login = login.as_deref().unwrap_or("-"),
                "GitHub Copilot connecté"
            );
            report(state, id)
        }
        Err(error) if error.is_transient() => {
            tracing::warn!(
                error = %error.message(),
                "connexion à GitHub Copilot interrompue : nouvel essai au prochain appel"
            );
            report(state, id)
        }
        Err(error) => {
            let message = error.message().to_string();
            tracing::warn!(error = %message, "connexion à GitHub Copilot refusée");
            state.copilot_sessions().with(id, |session| {
                session.phase = Phase::Failed(message.clone());
                Some(())
            });
            report(state, id)
        }
    }
}

async fn connect(settings: &Settings, github_token: &str) -> Result<CopilotTokens, ApiError> {
    let login = match fetch_login(settings, github_token).await {
        Ok(login) => Some(login),
        Err(error) => {
            tracing::warn!(error = %error.message(), "nom du compte GitHub indisponible");
            None
        }
    };
    let (copilot_token, expires_at) = match fetch_copilot_token(settings, github_token).await {
        Ok(token) => token,
        Err(error) => {
            return Err(match login {
                Some(login) if !error.is_transient() => ApiError::gateway(
                    "copilot",
                    format!("Compte GitHub « {login} » : {}", error.message()),
                ),
                _ => error,
            })
        }
    };
    Ok(CopilotTokens {
        github_token: github_token.to_string(),
        copilot_token: Some(copilot_token),
        expires_at: Some(expires_at),
        login,
    })
}

async fn fresh_token(
    state: &AppState,
    settings: &Settings,
    tokens: &CopilotTokens,
) -> Result<String, ApiError> {
    let now = chrono::Utc::now().timestamp();
    if let (Some(token), Some(expires_at)) = (&tokens.copilot_token, tokens.expires_at) {
        if expires_at - now >= REFRESH_MARGIN_SECS {
            return Ok(token.clone());
        }
    }
    tracing::info!("jeton Copilot absent ou proche de l'expiration : rafraîchissement");
    let (copilot_token, expires_at) = fetch_copilot_token(settings, &tokens.github_token).await?;
    state
        .set_copilot_tokens(&CopilotTokens {
            github_token: tokens.github_token.clone(),
            copilot_token: Some(copilot_token.clone()),
            expires_at: Some(expires_at),
            login: tokens.login.clone(),
        })
        .await?;
    Ok(copilot_token)
}

async fn poll_device(settings: &Settings, attempt: &Attempt) -> Result<Polled, ApiError> {
    let response = http_client(REQUEST_TIMEOUT)?
        .post(format!("{}/login/oauth/access_token", settings.github))
        .header(header::ACCEPT, "application/json")
        .form(&[
            ("client_id", attempt.client_id.as_str()),
            ("device_code", attempt.device_code.as_str()),
            ("grant_type", DEVICE_GRANT),
        ])
        .send()
        .await
        .map_err(|error| ApiError::transport("copilot", format!("GitHub injoignable : {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&body).map_err(|error| {
        ApiError::gateway("copilot", format!("réponse de GitHub illisible : {error}"))
    })?;
    if let Some(token) = payload.get("access_token").and_then(Value::as_str) {
        return Ok(Polled::Authorized(token.to_string()));
    }
    Ok(match payload.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => Polled::Pending,
        Some("slow_down") => Polled::SlowDown,
        Some("expired_token") => Polled::Expired,
        Some("access_denied") => Polled::Denied,
        Some(other) => Polled::Failed(format!("GitHub a refusé la connexion : {other}")),
        None => Polled::Failed(format!(
            "GitHub a refusé la connexion (code {}).",
            status.as_u16()
        )),
    })
}

async fn fetch_copilot_token(
    settings: &Settings,
    github_token: &str,
) -> Result<(String, i64), ApiError> {
    let response = http_client(REQUEST_TIMEOUT)?
        .get(format!("{}/copilot_internal/v2/token", settings.api))
        .header(header::ACCEPT, "application/json")
        .header(header::AUTHORIZATION, format!("token {github_token}"))
        .header("Editor-Version", EDITOR_VERSION)
        .header("Copilot-Integration-Id", INTEGRATION_ID)
        .send()
        .await
        .map_err(|error| {
            ApiError::transport("copilot", format!("GitHub Copilot injoignable : {error}"))
        })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(refusal(status, &body));
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| {
        ApiError::gateway(
            "copilot",
            format!("réponse de GitHub Copilot illisible : {error}"),
        )
    })?;
    let token = payload
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            ApiError::gateway(
                "copilot",
                "GitHub Copilot n'a pas renvoyé de jeton : vérifie ton abonnement.",
            )
        })?;
    let expires_at = payload
        .get("expires_at")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            ApiError::gateway(
                "copilot",
                "GitHub Copilot n'a pas renvoyé la validité de son jeton : reconnecte-toi.",
            )
        })?;
    Ok((token.to_string(), expires_at))
}

async fn fetch_login(settings: &Settings, github_token: &str) -> Result<String, ApiError> {
    let response = http_client(REQUEST_TIMEOUT)?
        .get(format!("{}/user", settings.api))
        .header(header::ACCEPT, "application/json")
        .header(header::AUTHORIZATION, format!("token {github_token}"))
        .send()
        .await
        .map_err(|error| ApiError::transport("copilot", format!("GitHub injoignable : {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ApiError::gateway(
            "copilot",
            format!(
                "GitHub a refusé de donner le nom du compte (code {}).",
                status.as_u16()
            ),
        ));
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| {
        ApiError::gateway("copilot", format!("réponse de GitHub illisible : {error}"))
    })?;
    payload
        .get("login")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError::gateway("copilot", "GitHub n'a pas renvoyé de nom de compte."))
}

fn report(state: &AppState, id: &str) -> Result<StatusResponse, ApiError> {
    state
        .copilot_sessions()
        .with(id, |session| Some(session.report()))
        .ok_or_else(|| ApiError::not_found(UNKNOWN_SESSION))
}

fn refusal(status: reqwest::StatusCode, body: &str) -> ApiError {
    let suffix = refusal_reason(body)
        .map(|reason| format!(" — {reason}"))
        .unwrap_or_default();
    match status.as_u16() {
        401 => ApiError::gateway(
            "copilot",
            format!("GitHub a refusé le jeton Copilot (401){suffix} : reconnecte ton compte dans les réglages IA."),
        ),
        403 => ApiError::gateway(
            "copilot",
            format!(
                "GitHub a refusé l'accès Copilot (403){suffix} : vérifie l'abonnement Copilot du compte autorisé, ou reconnecte-toi avec le bon compte."
            ),
        ),
        other => ApiError::gateway(
            "copilot",
            format!(
                "GitHub Copilot a refusé la demande (code {other}){suffix}. Réessaie dans un instant."
            ),
        ),
    }
}

fn refusal_reason(body: &str) -> Option<String> {
    if let Some(reason) = reason_of(body) {
        return Some(reason);
    }
    let payload: Value = serde_json::from_str(body).ok()?;
    let reason = payload
        .get("error")
        .and_then(|error| error.get("message"))
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())?;
    Some(reason.to_string())
}

fn reason_of(body: &str) -> Option<String> {
    let payload: Value = serde_json::from_str(body).ok()?;
    let error = payload.get("error")?.as_str()?;
    let description = payload
        .get("error_description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    Some(if description.is_empty() {
        error.to_string()
    } else {
        format!("{error} : {description}")
    })
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| ApiError::internal("copilot", format!("client HTTP : {error}")))
}
