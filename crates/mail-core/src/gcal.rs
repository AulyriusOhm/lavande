//! Google Calendar REST client (API v3), read-only.
//!
//! The account refresh token is exchanged for an access token by
//! [`OAuth2Provider`]; the token only travels in the `Authorization` header of
//! the requests: no `Debug`, no token in a log line or an error message.
//!
//! Calendars come from `users/me/calendarList`, events from
//! `calendars/{id}/events` listed expanded (`singleEvents`) and ordered by
//! start, so a recurring series arrives as its occurrences, each one flagged
//! `recurring`. Every event is projected onto [`ExternalEvent`], the shape the
//! agenda already reads for iCalendar and CalDAV. Cancelled events
//! (`status=cancelled`) are dropped. Writing is out of scope.

use std::time::Duration;

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveTime};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};

use crate::config::{AccountConfig, AuthConfig};
use crate::error::MailError;
use crate::ics::{ExternalEvent, MAX_ICS_EVENTS};
use crate::oauth::{OAuth2Provider, GOOGLE_TOKEN_ENDPOINT};

const API_ROOT: &str = "https://www.googleapis.com/calendar/v3";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Largest answer read from Google, in bytes.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Pages read for one listing: a runaway `nextPageToken` cannot loop forever.
const MAX_PAGES: usize = 10;

/// Calendars kept for one account.
const MAX_CALENDARS: usize = 250;

/// `calendarList` accepts 250 entries per page.
const CALENDARS_PAGE_SIZE: &str = "250";

/// `events` accepts 2500 entries per page; [`MAX_ICS_EVENTS`] bounds the total.
const EVENTS_PAGE_SIZE: &str = "2500";

/// One calendar of the account, as the settings need it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoogleCalendar {
    pub id: String,
    pub summary: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub access_role: Option<String>,
    pub primary: bool,
    pub timezone: Option<String>,
}

/// Read-only Google Calendar client. Holds the refresh token through
/// [`OAuth2Provider`] and never prints it.
pub struct GcalClient {
    http: reqwest::Client,
    provider: OAuth2Provider,
}

impl GcalClient {
    pub fn new(account: &AccountConfig) -> Result<Self, MailError> {
        let AuthConfig::OAuth2 {
            client_id,
            client_secret,
            refresh_token,
            token_endpoint,
        } = &account.auth
        else {
            return Err(MailError::Config(format!(
                "Google Calendar : le compte « {} » n'est pas connecté en OAuth2",
                account.id
            )));
        };
        if !google_account(token_endpoint) {
            return Err(MailError::Config(format!(
                "Google Calendar : le compte « {} » n'est pas un compte Google",
                account.id
            )));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Lavande/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| MailError::Gcal(format!("client HTTP Google Calendar : {error}")))?;
        Ok(Self {
            http,
            provider: OAuth2Provider::new(
                client_id.clone(),
                client_secret.clone(),
                refresh_token.clone(),
                token_endpoint.clone(),
            ),
        })
    }

    /// Calendars of the account, the primary one included.
    pub async fn calendars(&mut self) -> Result<Vec<GoogleCalendar>, MailError> {
        let mut calendars = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut query = vec![("maxResults", CALENDARS_PAGE_SIZE)];
            if let Some(token) = page_token.as_deref() {
                query.push(("pageToken", token));
            }
            let body = self.fetch(&["users", "me", "calendarList"], &query).await?;
            let listing = parse_calendar_list(&body)?;
            calendars.extend(listing.items.into_iter().filter_map(calendar));
            if calendars.len() >= MAX_CALENDARS {
                break;
            }
            page_token = page_token_of(listing.next_page_token);
            if page_token.is_none() {
                break;
            }
        }
        calendars.truncate(MAX_CALENDARS);
        Ok(calendars)
    }

    /// Events of `calendar_id`, `time_min` and `time_max` bounding the window
    /// when given (RFC 3339, as Google expects them).
    pub async fn events(
        &mut self,
        calendar_id: &str,
        time_min: Option<&str>,
        time_max: Option<&str>,
    ) -> Result<Vec<ExternalEvent>, MailError> {
        let calendar_id = calendar_id.trim();
        if calendar_id.is_empty() {
            return Err(MailError::Config(
                "Google Calendar : identifiant de calendrier vide".to_string(),
            ));
        }
        let mut events = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut query = vec![
                ("singleEvents", "true"),
                ("orderBy", "startTime"),
                ("maxResults", EVENTS_PAGE_SIZE),
            ];
            if let Some(min) = time_min.map(str::trim).filter(|min| !min.is_empty()) {
                query.push(("timeMin", min));
            }
            if let Some(max) = time_max.map(str::trim).filter(|max| !max.is_empty()) {
                query.push(("timeMax", max));
            }
            if let Some(token) = page_token.as_deref() {
                query.push(("pageToken", token));
            }
            let body = self
                .fetch(&["calendars", calendar_id, "events"], &query)
                .await?;
            let listing = parse_event_list(&body)?;
            for item in listing.items {
                if events.len() == MAX_ICS_EVENTS {
                    break;
                }
                if let Some(event) = project(&item, calendar_id) {
                    events.push(event);
                }
            }
            if events.len() >= MAX_ICS_EVENTS {
                break;
            }
            page_token = page_token_of(listing.next_page_token);
            if page_token.is_none() {
                break;
            }
        }
        Ok(events)
    }

    async fn fetch(
        &mut self,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<String, MailError> {
        let token = self.provider.access_token().await?;
        let mut url = endpoint(segments)?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let response = self
            .http
            .get(url.clone())
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|error| MailError::Gcal(format!("{} injoignable : {error}", address(&url))))?;
        let status = response.status();
        let body = answer_body(response, MAX_RESPONSE_BYTES).await?;
        match status {
            StatusCode::OK => Ok(body),
            StatusCode::UNAUTHORIZED => Err(MailError::Auth(format!(
                "Google a refusé le jeton d'accès (401) sur {} : reconnectez le compte",
                address(&url)
            ))),
            StatusCode::FORBIDDEN => Err(MailError::Auth(denied(&body))),
            StatusCode::NOT_FOUND => Err(MailError::InvalidData(format!(
                "calendrier Google introuvable : {} répond 404{}",
                address(&url),
                reported(&body)
            ))),
            other => Err(MailError::Gcal(format!(
                "{} répond {}{}",
                address(&url),
                other.as_u16(),
                reported(&body)
            ))),
        }
    }
}

#[derive(Deserialize, Default)]
struct CalendarList {
    #[serde(default)]
    items: Vec<CalendarItem>,
    #[serde(default, rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
struct CalendarItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "backgroundColor")]
    background_color: Option<String>,
    #[serde(default, rename = "accessRole")]
    access_role: Option<String>,
    #[serde(default)]
    primary: bool,
    #[serde(default, rename = "timeZone")]
    time_zone: Option<String>,
}

#[derive(Deserialize, Default)]
struct EventList {
    #[serde(default)]
    items: Vec<GoogleEvent>,
    #[serde(default, rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
struct GoogleEvent {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    start: Option<EventDate>,
    #[serde(default)]
    end: Option<EventDate>,
    #[serde(default)]
    recurrence: Option<Vec<String>>,
    #[serde(default, rename = "recurringEventId")]
    recurring_event_id: Option<String>,
}

/// `start`/`end` of an event: `date` for an all-day one, `dateTime` otherwise.
#[derive(Deserialize, Default)]
struct EventDate {
    #[serde(default, rename = "dateTime")]
    date_time: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default, rename = "timeZone")]
    time_zone: Option<String>,
}

#[derive(Deserialize, Default)]
struct ApiFailure {
    #[serde(default)]
    error: ApiFailureBody,
}

#[derive(Deserialize, Default)]
struct ApiFailureBody {
    #[serde(default)]
    message: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    errors: Vec<ApiFailureDetail>,
}

#[derive(Deserialize, Default)]
struct ApiFailureDetail {
    #[serde(default)]
    reason: String,
}

fn parse_calendar_list(body: &str) -> Result<CalendarList, MailError> {
    serde_json::from_str(body).map_err(|error| {
        MailError::Gcal(format!("liste des calendriers Google illisible : {error}"))
    })
}

fn parse_event_list(body: &str) -> Result<EventList, MailError> {
    serde_json::from_str(body)
        .map_err(|error| MailError::Gcal(format!("événements Google illisibles : {error}")))
}

fn page_token_of(token: Option<String>) -> Option<String> {
    token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

fn calendar(item: CalendarItem) -> Option<GoogleCalendar> {
    let id = text(Some(item.id.as_str()))?;
    Some(GoogleCalendar {
        summary: text(item.summary.as_deref()).unwrap_or_else(|| id.clone()),
        id,
        description: text(item.description.as_deref()),
        color: text(item.background_color.as_deref()),
        access_role: text(item.access_role.as_deref()),
        primary: item.primary,
        timezone: text(item.time_zone.as_deref()),
    })
}

/// A Google event without a usable start cannot be placed on a calendar and is
/// dropped instead of failing the whole listing.
fn project(event: &GoogleEvent, calendar_id: &str) -> Option<ExternalEvent> {
    if event.status.as_deref() == Some("cancelled") {
        return None;
    }
    let start = stamp(event.start.as_ref()?)?;
    let all_day = start.time.is_none();
    let end = if all_day {
        None
    } else {
        event
            .end
            .as_ref()
            .and_then(stamp)
            .and_then(|end| end.time)
            .map(clock)
    };
    Some(ExternalEvent {
        uid: text(event.id.as_deref()),
        title: text(event.summary.as_deref()).unwrap_or_else(|| "(sans titre)".to_string()),
        date: day(start.date),
        start: start.time.map(clock),
        end,
        all_day,
        timezone: if all_day { None } else { start.timezone },
        location: text(event.location.as_deref()),
        description: text(event.description.as_deref()),
        recurring: event.recurrence.is_some()
            || text(event.recurring_event_id.as_deref()).is_some(),
        // Google lists the occurrences itself (`singleEvents`): no expansion here,
        // and the identifier of the instance is already its own `id`.
        recurrence_id: None,
        source: Some(calendar_id.to_string()),
    })
}

struct Stamp {
    date: NaiveDate,
    time: Option<NaiveTime>,
    timezone: Option<String>,
}

fn stamp(value: &EventDate) -> Option<Stamp> {
    if let Some(raw) = value
        .date
        .as_deref()
        .map(str::trim)
        .filter(|day| !day.is_empty())
    {
        let date = NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok()?;
        return Some(Stamp {
            date,
            time: None,
            timezone: None,
        });
    }
    let moment = DateTime::parse_from_rfc3339(value.date_time.as_deref()?.trim()).ok()?;
    let local = moment.naive_local();
    Some(Stamp {
        date: local.date(),
        time: Some(local.time()),
        timezone: Some(text(value.time_zone.as_deref()).unwrap_or_else(|| offset(moment.offset()))),
    })
}

/// Name of the zone Google wrote, or the offset of the value when it named
/// none: `"UTC"` for a `Z` timestamp, `"+01:00"` otherwise.
fn offset(offset: &FixedOffset) -> String {
    let seconds = offset.local_minus_utc();
    if seconds == 0 {
        return "UTC".to_string();
    }
    let sign = if seconds < 0 { '-' } else { '+' };
    let minutes = seconds.abs() / 60;
    format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

fn day(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn clock(time: NaiveTime) -> String {
    time.format("%H:%M").to_string()
}

fn text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The token endpoint names the provider: only the Google one reaches the
/// Calendar API.
fn google_account(token_endpoint: &str) -> bool {
    token_endpoint
        .trim()
        .trim_end_matches('/')
        .eq_ignore_ascii_case(GOOGLE_TOKEN_ENDPOINT)
}

fn endpoint(segments: &[&str]) -> Result<Url, MailError> {
    let mut url = Url::parse(API_ROOT).map_err(|error| {
        MailError::Gcal(format!("URL de l'API Google Calendar invalide : {error}"))
    })?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| MailError::Gcal("URL de l'API Google Calendar invalide".to_string()))?;
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url)
}

fn address(url: &Url) -> String {
    match url.host_str() {
        Some(host) => format!("{host}{}", url.path()),
        None => url.path().to_string(),
    }
}

async fn answer_body(mut response: reqwest::Response, limit: usize) -> Result<String, MailError> {
    if let Some(announced) = response.content_length() {
        if announced > limit as u64 {
            return Err(too_large(limit));
        }
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| MailError::Gcal(format!("réponse Google interrompue : {error}")))?
    {
        if buffer.len() + chunk.len() > limit {
            return Err(too_large(limit));
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer).map_err(|_| MailError::Gcal("réponse Google non UTF-8".to_string()))
}

fn too_large(limit: usize) -> MailError {
    MailError::Gcal(format!(
        "réponse Google trop volumineuse (maximum {limit} octets)"
    ))
}

/// A 403 either means a missing scope — the account has to consent again — or
/// a refused access for another reason (quotas, a calendar not shared).
fn denied(body: &str) -> String {
    let failure = parse_failure(body);
    if insufficient_scope(&failure) {
        return format!(
            "le jeton n'a pas le droit Google Calendar{} : reconnectez le compte pour accorder \
             le scope https://www.googleapis.com/auth/calendar",
            detail(&failure.error.message)
        );
    }
    format!(
        "accès Google Calendar interdit (403){}",
        detail(&failure.error.message)
    )
}

fn parse_failure(body: &str) -> ApiFailure {
    serde_json::from_str(body).unwrap_or_default()
}

fn insufficient_scope(failure: &ApiFailure) -> bool {
    failure.error.status == "PERMISSION_DENIED"
        && (failure
            .error
            .errors
            .iter()
            .any(|detail| detail.reason == "insufficientPermissions")
            || failure.error.message.to_ascii_lowercase().contains("scope"))
}

fn reported(body: &str) -> String {
    detail(&parse_failure(body).error.message)
}

fn detail(message: &str) -> String {
    match text(Some(message)) {
        Some(message) => format!(" : {message}"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALENDAR: &str = "camille@studio-lilas.fr";

    fn event(body: &str) -> Option<ExternalEvent> {
        let event: GoogleEvent = serde_json::from_str(body).expect("événement Google");
        project(&event, CALENDAR)
    }

    #[test]
    fn a_timed_event_is_projected_onto_the_agenda() {
        let projected = event(
            r#"{
                "id": "abc123",
                "summary": "Rendez-vous chez le dentiste",
                "location": "12 rue des Lilas",
                "description": "Apporter la carte",
                "start": {"dateTime": "2024-03-15T09:30:00+01:00"},
                "end": {"dateTime": "2024-03-15T10:15:00+01:00"}
            }"#,
        )
        .expect("événement projeté");
        assert_eq!(projected.uid.as_deref(), Some("abc123"));
        assert_eq!(projected.title, "Rendez-vous chez le dentiste");
        assert_eq!(projected.date, "2024-03-15");
        assert_eq!(projected.start.as_deref(), Some("09:30"));
        assert_eq!(projected.end.as_deref(), Some("10:15"));
        assert!(!projected.all_day);
        assert_eq!(projected.timezone.as_deref(), Some("+01:00"));
        assert_eq!(projected.location.as_deref(), Some("12 rue des Lilas"));
        assert_eq!(projected.description.as_deref(), Some("Apporter la carte"));
        assert!(!projected.recurring);
        assert_eq!(projected.source.as_deref(), Some(CALENDAR));
    }

    #[test]
    fn a_named_zone_wins_over_the_offset() {
        let projected = event(
            r#"{
                "summary": "Point équipe",
                "start": {"dateTime": "2024-03-15T08:00:00Z", "timeZone": "Europe/Paris"},
                "end": {"dateTime": "2024-03-15T09:00:00Z", "timeZone": "Europe/Paris"}
            }"#,
        )
        .expect("événement projeté");
        assert_eq!(projected.start.as_deref(), Some("08:00"));
        assert_eq!(projected.timezone.as_deref(), Some("Europe/Paris"));
        assert_eq!(projected.uid, None);
    }

    #[test]
    fn a_utc_timestamp_carries_the_utc_zone() {
        let projected = event(
            r#"{
                "summary": "Réveil",
                "start": {"dateTime": "2024-03-15T07:00:00Z"},
                "end": {"dateTime": "2024-03-15T07:30:00Z"}
            }"#,
        )
        .expect("événement projeté");
        assert_eq!(projected.start.as_deref(), Some("07:00"));
        assert_eq!(projected.timezone.as_deref(), Some("UTC"));
    }

    #[test]
    fn an_all_day_event_has_no_clock() {
        let projected = event(
            r#"{
                "id": "journee",
                "summary": "Congé",
                "start": {"date": "2024-03-16"},
                "end": {"date": "2024-03-17"}
            }"#,
        )
        .expect("événement projeté");
        assert_eq!(projected.date, "2024-03-16");
        assert_eq!(projected.start, None);
        assert_eq!(projected.end, None);
        assert!(projected.all_day);
        assert_eq!(projected.timezone, None);
    }

    #[test]
    fn a_cancelled_event_is_ignored() {
        assert_eq!(
            event(
                r#"{
                    "id": "annule",
                    "status": "cancelled",
                    "summary": "Annulé",
                    "start": {"dateTime": "2024-03-15T09:30:00+01:00"},
                    "end": {"dateTime": "2024-03-15T10:15:00+01:00"}
                }"#,
            ),
            None
        );
    }

    #[test]
    fn a_recurring_event_is_flagged() {
        let series = event(
            r#"{
                "id": "serie",
                "summary": "Cours de piano",
                "start": {"dateTime": "2024-03-15T18:00:00+01:00"},
                "end": {"dateTime": "2024-03-15T19:00:00+01:00"},
                "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=FR"]
            }"#,
        )
        .expect("événement projeté");
        assert!(series.recurring);

        let occurrence = event(
            r#"{
                "id": "serie_20240322T170000Z",
                "summary": "Cours de piano",
                "start": {"dateTime": "2024-03-22T18:00:00+01:00"},
                "end": {"dateTime": "2024-03-22T19:00:00+01:00"},
                "recurringEventId": "serie"
            }"#,
        )
        .expect("occurrence projetée");
        assert!(occurrence.recurring);
        assert_eq!(occurrence.date, "2024-03-22");
        // Google liste déjà les occurrences, chacune avec son propre identifiant :
        // le démon les reprend telles quelles, sans en ajouter une seconde fois.
        assert_eq!(series.recurrence_id, None);
        assert_eq!(occurrence.recurrence_id, None);
        assert_eq!(occurrence.uid.as_deref(), Some("serie_20240322T170000Z"));
    }

    #[test]
    fn an_event_without_a_usable_start_is_dropped() {
        assert_eq!(event(r#"{"summary": "Sans date"}"#), None);
        assert_eq!(
            event(r#"{"summary": "Date illisible", "start": {"date": "16/03/2024"}}"#),
            None
        );
        assert_eq!(
            event(r#"{"summary": "Heure illisible", "start": {"dateTime": "demain"}}"#),
            None
        );
    }

    #[test]
    fn an_untitled_event_keeps_its_place() {
        let projected = event(
            r#"{
                "summary": "   ",
                "start": {"dateTime": "2024-03-15T09:30:00+01:00"}
            }"#,
        )
        .expect("événement projeté");
        assert_eq!(projected.title, "(sans titre)");
        assert_eq!(projected.end, None);
    }

    #[test]
    fn the_calendar_list_is_parsed() {
        let listing = parse_calendar_list(
            r##"{
                "kind": "calendar#calendarList",
                "nextPageToken": " page-2 ",
                "items": [
                    {
                        "id": "camille@studio-lilas.fr",
                        "summary": "Camille",
                        "description": "Agenda personnel",
                        "backgroundColor": "#9fe1e7",
                        "accessRole": "owner",
                        "primary": true,
                        "timeZone": "Europe/Paris"
                    },
                    {
                        "id": "fr.french#holiday@group.v.calendar.google.com",
                        "accessRole": "reader"
                    },
                    { "summary": "Sans identifiant" }
                ]
            }"##,
        )
        .expect("liste des calendriers");
        assert_eq!(
            page_token_of(listing.next_page_token),
            Some("page-2".to_string())
        );
        let calendars: Vec<GoogleCalendar> =
            listing.items.into_iter().filter_map(calendar).collect();
        assert_eq!(calendars.len(), 2);
        assert_eq!(
            calendars[0],
            GoogleCalendar {
                id: "camille@studio-lilas.fr".to_string(),
                summary: "Camille".to_string(),
                description: Some("Agenda personnel".to_string()),
                color: Some("#9fe1e7".to_string()),
                access_role: Some("owner".to_string()),
                primary: true,
                timezone: Some("Europe/Paris".to_string()),
            }
        );
        assert_eq!(calendars[1].summary, calendars[1].id);
        assert_eq!(calendars[1].description, None);
        assert_eq!(calendars[1].color, None);
        assert_eq!(calendars[1].access_role.as_deref(), Some("reader"));
        assert!(!calendars[1].primary);
    }

    #[test]
    fn an_event_page_carries_its_token_and_its_events() {
        let listing = parse_event_list(
            r#"{
                "kind": "calendar#events",
                "nextPageToken": "page-2",
                "items": [
                    {
                        "id": "un",
                        "summary": "Un",
                        "start": {"date": "2024-03-15"},
                        "end": {"date": "2024-03-16"}
                    },
                    {
                        "id": "deux",
                        "status": "cancelled",
                        "summary": "Deux",
                        "start": {"date": "2024-03-15"}
                    },
                    {
                        "id": "trois",
                        "summary": "Trois",
                        "start": {"dateTime": "2024-03-15T09:00:00+01:00"}
                    }
                ]
            }"#,
        )
        .expect("page d'événements");
        assert_eq!(
            page_token_of(listing.next_page_token),
            Some("page-2".to_string())
        );
        let events: Vec<ExternalEvent> = listing
            .items
            .iter()
            .filter_map(|item| project(item, CALENDAR))
            .collect();
        assert_eq!(
            events
                .iter()
                .map(|event| event.title.as_str())
                .collect::<Vec<_>>(),
            ["Un", "Trois"]
        );
    }

    #[test]
    fn an_unreadable_answer_is_reported() {
        assert!(matches!(
            parse_calendar_list("pas du JSON"),
            Err(MailError::Gcal(_))
        ));
        assert!(matches!(
            parse_event_list(r#"{"items": "pas une liste"}"#),
            Err(MailError::Gcal(_))
        ));
    }

    #[test]
    fn a_refused_token_mentions_the_consent() {
        let message = denied(
            r#"{
                "error": {
                    "code": 403,
                    "message": "Insufficient Permission: Request had insufficient authentication scopes.",
                    "status": "PERMISSION_DENIED",
                    "errors": [{"reason": "insufficientPermissions", "message": "Insufficient Permission"}]
                }
            }"#,
        );
        assert!(message.contains("reconnectez le compte"), "{message}");
        assert!(message.contains("auth/calendar"), "{message}");

        let quota = denied(
            r#"{
                "error": {
                    "code": 403,
                    "message": "Quota exceeded for quota metric",
                    "status": "PERMISSION_DENIED",
                    "errors": [{"reason": "rateLimitExceeded"}]
                }
            }"#,
        );
        assert!(!quota.contains("reconnectez le compte"), "{quota}");
        assert!(quota.contains("Quota exceeded"), "{quota}");
    }

    #[test]
    fn only_the_google_token_endpoint_is_accepted() {
        assert!(google_account("https://oauth2.googleapis.com/token"));
        assert!(google_account(" https://oauth2.googleapis.com/token/ "));
        assert!(!google_account(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token"
        ));
        assert!(!google_account(""));
    }

    #[test]
    fn the_event_url_encodes_the_calendar_id() {
        let url = endpoint(&[
            "calendars",
            "fr.french#holiday@group.v.calendar.google.com",
            "events",
        ])
        .expect("URL");
        assert_eq!(
            address(&url),
            "www.googleapis.com/calendar/v3/calendars/fr.french%23holiday@group.v.calendar.google.com/events"
        );
    }

    #[test]
    fn the_clock_is_read_as_hh_mm() {
        let daytime = chrono::NaiveTime::from_hms_opt(9, 5, 42).expect("heure");
        assert_eq!(clock(daytime), "09:05");
        let date = NaiveDate::from_ymd_opt(2024, 3, 5).expect("date");
        assert_eq!(day(date), "2024-03-05");
    }
}
