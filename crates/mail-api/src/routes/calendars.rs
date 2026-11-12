//! `/api/calendars`: import en lecture seule d'un calendrier iCalendar, collé
//! dans le corps de la requête ou téléchargé par le démon depuis une URL.

use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use lavande_mail::ics::{parse_events, ExternalEvent, MAX_ICS_BYTES};
use serde::Deserialize;

use crate::dto::ApiJson;
use crate::error::ApiError;
use crate::state::AppState;

/// A calendar server that never answers must not hold a request open.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

pub fn router() -> Router<std::sync::Arc<AppState>> {
    Router::new().route("/api/calendars/ics", post(import))
}

#[derive(Deserialize)]
struct ImportRequest {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    url: Option<String>,
    /// Label copied onto every event; defaults to the fetched URL.
    #[serde(default)]
    source: Option<String>,
}

async fn import(
    ApiJson(request): ApiJson<ImportRequest>,
) -> Result<Json<Vec<ExternalEvent>>, ApiError> {
    let label = trimmed(request.source);
    let (content, source) = match (trimmed(request.content), trimmed(request.url)) {
        (Some(content), None) => (content, label),
        (None, Some(raw_url)) => {
            let url = calendar_url(&raw_url)?;
            let content = fetch(&url).await?;
            let source = label.or_else(|| Some(url.to_string()));
            (content, source)
        }
        (Some(_), Some(_)) => {
            return Err(ApiError::bad_request(
                "calendar",
                "fournissez « content » ou « url », pas les deux",
            ))
        }
        (None, None) => {
            return Err(ApiError::bad_request(
                "calendar",
                "il manque « content » ou « url »",
            ))
        }
    };
    let events = parse_events(&content, source.as_deref())?;
    tracing::debug!(events = events.len(), "calendrier iCalendar importé");
    Ok(Json(events))
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn calendar_url(raw: &str) -> Result<reqwest::Url, ApiError> {
    let url = reqwest::Url::parse(raw).map_err(|error| {
        ApiError::bad_request("calendar", format!("URL de calendrier invalide : {error}"))
    })?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(ApiError::bad_request(
            "calendar",
            format!("schéma d'URL refusé : « {scheme} » (http ou https)"),
        )),
    }
}

/// Reads at most [`MAX_ICS_BYTES`] of the calendar, then refuses the rest: the
/// size announced and the size actually received are both checked.
async fn fetch(url: &reqwest::Url) -> Result<String, ApiError> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("Lavande/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| ApiError::internal("calendar", format!("client HTTP : {error}")))?;
    let mut response = client.get(url.clone()).send().await.map_err(|error| {
        ApiError::gateway("calendar", format!("téléchargement impossible : {error}"))
    })?;
    if !response.status().is_success() {
        return Err(ApiError::gateway(
            "calendar",
            format!("le serveur de calendrier répond {}", response.status()),
        ));
    }
    if let Some(announced) = response.content_length() {
        if announced > MAX_ICS_BYTES as u64 {
            return Err(too_large());
        }
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        ApiError::gateway("calendar", format!("téléchargement interrompu : {error}"))
    })? {
        if buffer.len() + chunk.len() > MAX_ICS_BYTES {
            return Err(too_large());
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer).map_err(|_| {
        ApiError::bad_request("calendar", "le calendrier téléchargé n'est pas de l'UTF-8")
    })
}

fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "calendar",
        format!("calendrier trop volumineux (maximum {MAX_ICS_BYTES} octets)"),
    )
}
