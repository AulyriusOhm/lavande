//! `/api/calendars`: import en lecture seule d'un calendrier iCalendar, collé
//! dans le corps de la requête ou téléchargé par le démon depuis une URL, accès
//! CalDAV en lecture et en écriture et lecture des calendriers Google d'un
//! compte OAuth2.
//!
//! Une source CalDAV persistée garde son URL et son nom dans `calendars.json`
//! et ses identifiants dans le coffre de secrets : ils ne repassent jamais par
//! une réponse ni par une ligne de journal. Une écriture vise la collection
//! nommée par la source, ou son unique calendrier découvert. Une source liée à
//! un compte mail (`/sources/from-account`) n'a pas de secret propre : elle
//! emprunte le mot de passe du compte, celui que Zimbra demande en Basic.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use lavande_mail::caldav::{CaldavClient, CalendarCollection};
use lavande_mail::config::AuthConfig;
use lavande_mail::error::MailError;
use lavande_mail::gcal::{GcalClient, GoogleCalendar};
use lavande_mail::ics::{address_of, event_uid, parse_events, ExternalEvent, MAX_ICS_BYTES};
use serde::{Deserialize, Serialize};

use crate::calendar_sources::CalendarSource;
use crate::dto::ApiJson;
use crate::error::ApiError;
use crate::secrets::AccountSecrets;
use crate::state::AppState;

/// A calendar server that never answers must not hold a request open.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/calendars/ics", post(import))
        .route("/api/calendars/caldav/discover", post(caldav_discover))
        .route("/api/calendars/caldav/events", post(caldav_events))
        .route(
            "/api/calendars/caldav/sources",
            get(list_sources).post(add_source),
        )
        .route(
            "/api/calendars/caldav/sources/from-account",
            post(add_source_from_account),
        )
        .route("/api/calendars/caldav/sources/{id}", delete(remove_source))
        .route(
            "/api/calendars/caldav/sources/{id}/events",
            post(source_events),
        )
        .route(
            "/api/calendars/caldav/sources/{id}/events/create",
            post(source_event_create),
        )
        .route(
            "/api/calendars/caldav/sources/{id}/events/{uid}",
            put(source_event_update).delete(source_event_delete),
        )
        .route(
            "/api/calendars/google/{account_id}/calendars",
            get(google_calendars),
        )
        .route(
            "/api/calendars/google/{account_id}/events",
            post(google_events),
        )
}

/// Credentials of a one-shot call: the stateless setup routes never store
/// them, the sources routes put them in the secret store.
#[derive(Deserialize)]
struct CaldavRequest {
    url: String,
    username: String,
    password: String,
    /// Collection to read; every discovered calendar when absent.
    #[serde(default)]
    calendar_href: Option<String>,
}

impl CaldavRequest {
    fn client(&self) -> Result<CaldavClient, ApiError> {
        let url = self.url.trim();
        if url.is_empty() {
            return Err(ApiError::bad_request("caldav", "il manque « url »"));
        }
        let username = self.username.trim();
        if username.is_empty() {
            return Err(ApiError::bad_request("caldav", "il manque « username »"));
        }
        if self.password.is_empty() {
            return Err(ApiError::bad_request("caldav", "il manque « password »"));
        }
        Ok(CaldavClient::new(url, username, &self.password)?)
    }
}

async fn caldav_discover(
    ApiJson(request): ApiJson<CaldavRequest>,
) -> Result<Json<Vec<CalendarCollection>>, ApiError> {
    let collections = request.client()?.discover().await?;
    tracing::debug!(
        calendars = collections.len(),
        "calendriers CalDAV découverts"
    );
    Ok(Json(collections))
}

async fn caldav_events(
    ApiJson(request): ApiJson<CaldavRequest>,
) -> Result<Json<Vec<ExternalEvent>>, ApiError> {
    let client = request.client()?;
    let events = client.events(request.calendar_href.as_deref()).await?;
    tracing::debug!(events = events.len(), "événements CalDAV récupérés");
    Ok(Json(events))
}

/// Calendars of a Google account already connected: the refresh token of the
/// account is the only credential, none travels in the request.
async fn google_calendars(
    Path(account_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<GoogleCalendar>>, ApiError> {
    let account = state.account(&account_id).await?;
    let mut client = GcalClient::new(&account)?;
    let calendars = client.calendars().await?;
    tracing::debug!(
        account = %account_id,
        calendars = calendars.len(),
        "calendriers Google listés"
    );
    Ok(Json(calendars))
}

#[derive(Deserialize)]
struct GoogleEventsRequest {
    calendar_id: String,
    /// RFC 3339 bounds of the window; Google defaults them when absent.
    #[serde(default)]
    time_min: Option<String>,
    #[serde(default)]
    time_max: Option<String>,
}

async fn google_events(
    Path(account_id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<GoogleEventsRequest>,
) -> Result<Json<Vec<ExternalEvent>>, ApiError> {
    let calendar_id = request.calendar_id.trim();
    if calendar_id.is_empty() {
        return Err(ApiError::bad_request("gcal", "il manque « calendar_id »"));
    }
    let time_min = trimmed(request.time_min);
    let time_max = trimmed(request.time_max);
    let account = state.account(&account_id).await?;
    let mut client = GcalClient::new(&account)?;
    let events = client
        .events(calendar_id, time_min.as_deref(), time_max.as_deref())
        .await?;
    tracing::debug!(
        account = %account_id,
        events = events.len(),
        "événements Google récupérés"
    );
    Ok(Json(events))
}

/// Credentials travel once, in the body: they end up in the secret store.
#[derive(Deserialize)]
struct SourceRequest {
    #[serde(flatten)]
    credentials: CaldavRequest,
    /// Label of the source; defaults to the host of the URL.
    #[serde(default)]
    name: Option<String>,
}

async fn list_sources(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<CalendarSource>>, ApiError> {
    Ok(Json(state.calendar_sources()?))
}

/// Nothing is stored unless the server answers: the collection named by
/// `calendar_href` is read, every discovered calendar otherwise.
async fn add_source(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<SourceRequest>,
) -> Result<(StatusCode, Json<CalendarSource>), ApiError> {
    let client = request.credentials.client()?;
    let calendar_href = trimmed(request.credentials.calendar_href);
    match calendar_href.as_deref() {
        Some(href) => {
            let events = client.events(Some(href)).await?;
            tracing::debug!(events = events.len(), "calendrier CalDAV lu à l'ajout");
        }
        None => {
            let calendars = client.discover().await?;
            tracing::debug!(calendars = calendars.len(), "source CalDAV découverte");
        }
    }
    let url = request.credentials.url.trim().to_string();
    let name = match trimmed(request.name) {
        Some(name) => name,
        None => host(&url)?,
    };
    let credentials = AccountSecrets::Caldav {
        username: request.credentials.username.trim().to_string(),
        password: request.credentials.password,
    };
    let source = state
        .add_calendar_source(&name, &url, calendar_href, credentials)
        .await?;
    tracing::info!(source = %source.id, "source CalDAV ajoutée");
    Ok((StatusCode::CREATED, Json(source)))
}

/// Agenda CalDAV d'un compte mail déjà connecté : le mot de passe du compte
/// sert d'authentification Basic, aucun identifiant ne passe par la requête.
#[derive(Deserialize)]
struct AccountSourceRequest {
    account_id: String,
    /// Serveur CalDAV du compte ; par défaut `https://<hôte IMAP>/dav/`.
    #[serde(default)]
    url: Option<String>,
}

/// Rien n'est rangé tant que le serveur n'a pas répondu ; la source emprunte
/// ensuite les identifiants du compte, sans copie dans le coffre.
async fn add_source_from_account(
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<AccountSourceRequest>,
) -> Result<(StatusCode, Json<CalendarSource>), ApiError> {
    let account_id = request.account_id.trim();
    if account_id.is_empty() {
        return Err(ApiError::bad_request("caldav", "il manque « account_id »"));
    }
    let account = state.account(account_id).await?;
    let password = match &account.auth {
        AuthConfig::Password { password } => password.clone(),
        AuthConfig::OAuth2 { .. } => {
            return Err(ApiError::bad_request(
                "caldav",
                "ce compte utilise OAuth ; ajoutez son agenda via Google",
            ))
        }
    };
    let username = account.username.trim();
    let username = if username.is_empty() {
        account.email.trim()
    } else {
        username
    };
    let base = match trimmed(request.url) {
        Some(url) => url,
        None => format!("https://{}/dav/", account.imap.host.trim()),
    };
    let base = reqwest::Url::parse(&base).map_err(|error| {
        ApiError::bad_request("caldav", format!("URL CalDAV invalide : {error}"))
    })?;
    // Le mot de passe du compte ne part que vers son propre serveur mail.
    let url_host = base.host_str().unwrap_or_default();
    if !url_host.eq_ignore_ascii_case(account.imap.host.trim()) {
        return Err(ApiError::bad_request(
            "caldav",
            "l'URL doit viser le serveur mail du compte",
        ));
    }
    let loopback = matches!(url_host, "127.0.0.1" | "::1" | "localhost");
    if base.scheme() != "https" && !(loopback && base.scheme() == "http") {
        return Err(ApiError::bad_request(
            "caldav",
            "HTTPS requis pour l'agenda du compte",
        ));
    }
    let client = CaldavClient::new(base.as_str(), username, &password)?;
    let calendar_href = match client.discover().await {
        Ok(collections) => {
            tracing::debug!(
                account = %account_id,
                calendars = collections.len(),
                "agenda du compte découvert"
            );
            None
        }
        Err(error @ MailError::Auth(_)) => return Err(error.into()),
        Err(error) => {
            let href = zimbra_calendar(&base, &account.email)?;
            tracing::debug!(
                %error,
                account = %account_id,
                "découverte impossible, calendrier Zimbra essayé"
            );
            client.events(Some(href.as_str())).await?;
            Some(href.to_string())
        }
    };
    let name = host(base.as_str())?;
    let source =
        state.add_account_calendar_source(&name, base.as_str(), calendar_href, account_id)?;
    tracing::info!(source = %source.id, account = %account_id, "agenda du compte lié");
    Ok((StatusCode::CREATED, Json(source)))
}

/// `<base>/<email>/Calendar`, le calendrier que Zimbra expose pour le compte.
fn zimbra_calendar(base: &reqwest::Url, email: &str) -> Result<reqwest::Url, ApiError> {
    let email = email.trim();
    if email.is_empty() {
        return Err(ApiError::bad_request(
            "caldav",
            "le compte n'a pas d'adresse pour dériver son calendrier",
        ));
    }
    let mut root = base.clone();
    if !root.path().ends_with('/') {
        let path = format!("{}/", root.path());
        root.set_path(&path);
    }
    root.join(&format!("{email}/Calendar")).map_err(|error| {
        ApiError::bad_request("caldav", format!("URL de calendrier invalide : {error}"))
    })
}

async fn remove_source(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    if !state.remove_calendar_source(&id).await? {
        return Err(ApiError::not_found(format!(
            "source CalDAV « {id} » inconnue"
        )));
    }
    tracing::info!(source = %id, "source CalDAV supprimée");
    Ok(StatusCode::NO_CONTENT)
}

/// Reads a stored source with its own credentials: none travels in the request.
async fn source_events(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ExternalEvent>>, ApiError> {
    let source = state.calendar_source(&id)?;
    let (username, password) = state.calendar_credentials(&id).await?;
    let client = CaldavClient::new(&source.url, &username, &password)?;
    let events = client.events(source.calendar_href.as_deref()).await?;
    tracing::debug!(source = %id, events = events.len(), "événements CalDAV récupérés");
    Ok(Json(events))
}

/// One event written to a stored source: every field of [`ExternalEvent`]
/// (its `uid` included) plus the `etag` the server answered.
#[derive(Serialize)]
struct WrittenEvent {
    #[serde(flatten)]
    event: ExternalEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
}

#[derive(Deserialize)]
struct EventRequest {
    #[serde(default)]
    title: String,
    /// `YYYY-MM-DD` of the event.
    #[serde(default)]
    date: String,
    /// `HH:MM`; absent, the event lasts the whole day.
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// ETag the caller holds: a stale one is refused by the server (412).
    #[serde(default)]
    etag: Option<String>,
    /// Guest addresses; with at least one, the write is an invitation the
    /// CalDAV server schedules itself (RFC 6638).
    #[serde(default)]
    attendees: Vec<String>,
}

impl EventRequest {
    /// The event as it is written, `uid` being the one of the resource.
    fn event(&self, uid: String) -> Result<ExternalEvent, ApiError> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err(ApiError::bad_request("calendar", "il manque « title »"));
        }
        let date = self.date.trim();
        if date.is_empty() {
            return Err(ApiError::bad_request("calendar", "il manque « date »"));
        }
        let start = trimmed(self.start.clone());
        let attendees: Vec<String> = self
            .attendees
            .iter()
            .filter_map(|attendee| address_of(attendee))
            .collect();
        Ok(ExternalEvent {
            uid: Some(uid),
            title: title.to_string(),
            date: date.to_string(),
            all_day: start.is_none(),
            start,
            end: trimmed(self.end.clone()),
            timezone: None,
            location: trimmed(self.location.clone()),
            description: trimmed(self.description.clone()),
            recurring: false,
            recurrence_id: None,
            organizer: None,
            attendees: (!attendees.is_empty()).then_some(attendees),
            source: None,
        })
    }
}

#[derive(Deserialize, Default)]
struct DeleteQuery {
    #[serde(default)]
    etag: Option<String>,
}

async fn source_event_create(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<EventRequest>,
) -> Result<(StatusCode, Json<WrittenEvent>), ApiError> {
    let (source, client, collection) = source_collection(&state, &id).await?;
    let mut event = request.event(event_uid(None))?;
    event.organizer = organizer(&state, &source, &client).await;
    event.source = Some(source.name.clone());
    let etag = client.put_event(&collection, &event, None).await?;
    tracing::debug!(source = %id, uid = event.uid.as_deref().unwrap_or_default(), "événement CalDAV créé");
    Ok((StatusCode::CREATED, Json(WrittenEvent { event, etag })))
}

/// The ETag of the caller wins; without one the current ETag is read first so
/// the write stays conditional.
async fn source_event_update(
    Path((id, uid)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<EventRequest>,
) -> Result<Json<WrittenEvent>, ApiError> {
    let (source, client, collection) = source_collection(&state, &id).await?;
    let etag = match trimmed(request.etag.clone()) {
        Some(etag) => etag,
        None => client.get_etag(&collection, &uid).await?.ok_or_else(|| {
            ApiError::gateway(
                "caldav",
                format!("le serveur ne donne pas d'ETag pour « {uid} » : mise à jour conditionnelle impossible"),
            )
        })?,
    };
    let mut event = request.event(uid)?;
    event.organizer = organizer(&state, &source, &client).await;
    event.source = Some(source.name.clone());
    let etag = client.put_event(&collection, &event, Some(&etag)).await?;
    tracing::debug!(source = %id, uid = event.uid.as_deref().unwrap_or_default(), "événement CalDAV mis à jour");
    Ok(Json(WrittenEvent { event, etag }))
}

async fn source_event_delete(
    Path((id, uid)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<DeleteQuery>,
) -> Result<StatusCode, ApiError> {
    let (_, client, collection) = source_collection(&state, &id).await?;
    client
        .delete_event(&collection, &uid, trimmed(query.etag).as_deref())
        .await?;
    tracing::debug!(source = %id, uid = %uid, "événement CalDAV supprimé");
    Ok(StatusCode::NO_CONTENT)
}

/// Address that signs the invitations of a source: the one of the mail account
/// it borrows its credentials from, else the CalDAV user when that is an address.
/// `None` for a standalone source naming a plain login: the write then carries
/// no `ORGANIZER`, and the server schedules nothing.
async fn organizer(
    state: &AppState,
    source: &CalendarSource,
    client: &CaldavClient,
) -> Option<String> {
    if let Some(account_id) = source.account_id.as_deref() {
        if let Ok(account) = state.account(account_id).await {
            return address_of(&account.email);
        }
    }
    address_of(client.username())
}

/// Source, client and collection a write goes to.
pub(crate) async fn source_collection(
    state: &AppState,
    id: &str,
) -> Result<(CalendarSource, CaldavClient, String), ApiError> {
    let source = state.calendar_source(id)?;
    let (username, password) = state.calendar_credentials(id).await?;
    let client = CaldavClient::new(&source.url, &username, &password)?;
    let collection = match source
        .calendar_href
        .as_deref()
        .map(str::trim)
        .filter(|href| !href.is_empty())
    {
        Some(href) => href.to_string(),
        None => match client.discover().await?.as_slice() {
            [only] => only.href.clone(),
            [] => {
                return Err(ApiError::bad_request(
                    "caldav",
                    format!("la source « {id} » n'a aucun calendrier à écrire"),
                ))
            }
            _ => {
                return Err(ApiError::bad_request(
                    "caldav",
                    format!(
                        "la source « {id} » a plusieurs calendriers : précisez « calendar_href »"
                    ),
                ))
            }
        },
    };
    Ok((source, client, collection))
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

/// Default label of a source: the server it points at.
fn host(url: &str) -> Result<String, ApiError> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .ok_or_else(|| ApiError::bad_request("caldav", format!("URL sans hôte : « {url} »")))
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
