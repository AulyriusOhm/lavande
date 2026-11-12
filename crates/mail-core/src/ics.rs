//! iCalendar import and export (RFC 5545).
//!
//! The parsed calendar is projected onto [`ExternalEvent`]: only what the
//! agenda displays leaves the daemon. `VEVENT` are read; `VTODO`, `VJOURNAL`
//! and `VTIMEZONE` are ignored. `RRULE`/`RDATE` are **not** expanded: a
//! recurring event comes out once, flagged `recurring`, and expansion is left
//! to a later pass.
//!
//! Times are the wall clock written in the file: no timezone conversion is
//! applied here, the `TZID` (or `"UTC"` for a `Z` value) travels with the
//! event so the caller can decide. [`event_ics`] writes the opposite way: one
//! `VEVENT` per resource, whole-day or floating local clock.

use std::borrow::Cow;
use std::str::FromStr;

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use icalendar::{
    Calendar, CalendarDateTime, Component, DatePerhapsTime, Event, EventLike, Property,
};
use serde::{Deserialize, Serialize};

use crate::error::MailError;

/// Largest calendar accepted, in bytes, for a payload as well as a fetch.
pub const MAX_ICS_BYTES: usize = 2 * 1024 * 1024;

/// Largest number of events read out of one calendar.
pub const MAX_ICS_EVENTS: usize = 10_000;

/// One `VEVENT` as the agenda needs it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalEvent {
    /// `UID` of the `VEVENT`; absent when the producer omitted it.
    pub uid: Option<String>,
    pub title: String,
    /// `YYYY-MM-DD`, as written by the file.
    pub date: String,
    /// `HH:MM`; `None` for an all-day event.
    pub start: Option<String>,
    /// `HH:MM`; `None` for an all-day event or a `VEVENT` without `DTEND`.
    pub end: Option<String>,
    pub all_day: bool,
    /// `TZID` of `DTSTART`, `"UTC"` for a `Z` value, `None` when floating or
    /// all-day.
    pub timezone: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    /// A recurrence rule is present; the event is one entry, not the series.
    pub recurring: bool,
    /// Calendar the event came from: the fetched URL, or the label the caller
    /// gave.
    pub source: Option<String>,
}

/// Reads every `VEVENT` of `content`. `source` is copied onto each event.
pub fn parse_events(content: &str, source: Option<&str>) -> Result<Vec<ExternalEvent>, MailError> {
    if content.trim().is_empty() {
        return Err(MailError::Calendar("calendrier vide".to_string()));
    }
    if content.len() > MAX_ICS_BYTES {
        return Err(MailError::Calendar(format!(
            "calendrier trop volumineux : {} octets (maximum {MAX_ICS_BYTES})",
            content.len()
        )));
    }
    let content = content.trim_start_matches('\u{feff}');
    let calendar = Calendar::from_str(&normalized_names(content)).map_err(reason)?;
    let mut events = Vec::new();
    for event in calendar.events() {
        if events.len() == MAX_ICS_EVENTS {
            return Err(MailError::Calendar(format!(
                "calendrier trop volumineux : plus de {MAX_ICS_EVENTS} événements"
            )));
        }
        if let Some(projected) = project(event, source) {
            events.push(projected);
        }
    }
    Ok(events)
}

/// `UID` of an event about to be written: the one it already carries, or a
/// fresh one. Keeping the `UID` of an event is what turns a write into an
/// update of the same resource.
pub fn event_uid(existing: Option<&str>) -> String {
    match existing.map(str::trim).filter(|uid| !uid.is_empty()) {
        Some(uid) => uid.to_string(),
        None => format!(
            "{:016x}{:016x}@lavande",
            rand::random::<u64>(),
            rand::random::<u64>()
        ),
    }
}

/// iCalendar resource of one event: a `VCALENDAR` holding a single `VEVENT`.
///
/// `event.uid` must be set, the caller writes the same `UID` into the resource
/// URL. An event without `start` is written whole-day (`VALUE=DATE`, `DTEND`
/// on the next day); a timed event is written as a floating local clock, the
/// daemon having no timezone of its own. A timed event without `end` lasts one
/// hour.
pub fn event_ics(event: &ExternalEvent) -> Result<String, MailError> {
    let uid = event
        .uid
        .as_deref()
        .map(str::trim)
        .filter(|uid| !uid.is_empty())
        .ok_or_else(|| MailError::Calendar("événement sans UID".to_string()))?;
    let title = event.title.trim();
    if title.is_empty() {
        return Err(MailError::Calendar("événement sans titre".to_string()));
    }
    let date = iso_date(&event.date)?;
    let mut entry = Event::new();
    entry.uid(uid).summary(title).timestamp(Utc::now());
    match date_time(&event.start)? {
        Some(start) => {
            let start = NaiveDateTime::new(date, start);
            let end = match date_time(&event.end)? {
                Some(end) => NaiveDateTime::new(date, end),
                None => start + Duration::hours(1),
            };
            if end <= start {
                return Err(MailError::Calendar(format!(
                    "fin ({}) avant le début ({}) le {}",
                    clock(end.time()),
                    clock(start.time()),
                    event.date.trim()
                )));
            }
            entry.starts(start).ends(end);
        }
        None => {
            let next = date.succ_opt().ok_or_else(|| {
                MailError::Calendar(format!("date hors limites : {}", event.date.trim()))
            })?;
            entry.starts(date).ends(next);
        }
    }
    if let Some(location) = text(event.location.as_deref()) {
        entry.location(&location);
    }
    if let Some(description) = text(event.description.as_deref()) {
        entry.description(&description);
    }
    let mut calendar = Calendar::empty();
    calendar
        .append_property(Property::new("VERSION", "2.0"))
        .append_property(Property::new("PRODID", "-//Lavande//Agenda//FR"));
    calendar.push(entry);
    let ics = calendar.to_string();
    if ics.len() > MAX_ICS_BYTES {
        return Err(MailError::Calendar(format!(
            "événement trop volumineux : {} octets (maximum {MAX_ICS_BYTES})",
            ics.len()
        )));
    }
    Ok(ics)
}

/// A `VEVENT` without a usable `DTSTART` cannot be placed on a calendar and is
/// dropped instead of failing the whole import.
fn project(event: &icalendar::Event, source: Option<&str>) -> Option<ExternalEvent> {
    let start = stamp(&event.get_start()?)?;
    let all_day = start.time.is_none();
    let end = if all_day {
        None
    } else {
        event
            .get_end()
            .as_ref()
            .and_then(stamp)
            .and_then(|end| end.time)
            .map(clock)
    };
    let timezone = if all_day { None } else { start.timezone };
    Some(ExternalEvent {
        uid: event.get_uid().map(str::to_string),
        title: event
            .get_summary()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or("(sans titre)")
            .to_string(),
        date: iso_day(start.date),
        start: start.time.map(clock),
        end,
        all_day,
        timezone,
        location: text(event.get_location()),
        description: text(event.get_description()),
        recurring: event.property_value("RRULE").is_some()
            || event.property_value("RDATE").is_some(),
        source: source.map(str::to_string),
    })
}

struct Stamp {
    date: NaiveDate,
    time: Option<NaiveTime>,
    timezone: Option<String>,
}

/// Property and component names are case-insensitive (RFC 5545, 3.1) but the
/// parser compares them verbatim: names are uppercased before parsing, values
/// stay untouched — except the name carried by `BEGIN`/`END`, which is a
/// component name. A folded value continues on a line starting with a space or
/// a tab and is left alone.
fn normalized_names(content: &str) -> Cow<'_, str> {
    let mut changed = false;
    let mut normalized = String::with_capacity(content.len());
    for line in content.split_inclusive('\n') {
        let Some((name, rest)) = split_name(line) else {
            normalized.push_str(line);
            continue;
        };
        let uppercase = name.to_ascii_uppercase();
        changed |= uppercase != name;
        normalized.push_str(&uppercase);
        let component = rest.starts_with(':') && (uppercase == "BEGIN" || uppercase == "END");
        if !component {
            normalized.push_str(rest);
            continue;
        }
        let value = rest[1..].trim_end_matches(['\r', '\n']);
        let uppercase_value = value.to_ascii_uppercase();
        changed |= uppercase_value != value;
        normalized.push(':');
        normalized.push_str(&uppercase_value);
        normalized.push_str(&rest[1 + value.len()..]);
    }
    if changed {
        Cow::Owned(normalized)
    } else {
        Cow::Borrowed(content)
    }
}

/// Splits a line at the separator ending its name; `None` for a folded
/// continuation or a line carrying no separator.
fn split_name(line: &str) -> Option<(&str, &str)> {
    if line.starts_with([' ', '\t']) {
        return None;
    }
    Some(line.split_at(line.find([':', ';'])?))
}

fn stamp(value: &DatePerhapsTime) -> Option<Stamp> {
    match value {
        DatePerhapsTime::Date(date) => Some(Stamp {
            date: *date,
            time: None,
            timezone: None,
        }),
        DatePerhapsTime::DateTime(CalendarDateTime::Utc(date_time)) => Some(Stamp {
            date: date_time.date_naive(),
            time: Some(date_time.time()),
            timezone: Some("UTC".to_string()),
        }),
        DatePerhapsTime::DateTime(CalendarDateTime::Floating(date_time)) => Some(Stamp {
            date: date_time.date(),
            time: Some(date_time.time()),
            timezone: None,
        }),
        DatePerhapsTime::DateTime(CalendarDateTime::WithTimezone { date_time, tzid }) => {
            Some(Stamp {
                date: date_time.date(),
                time: Some(date_time.time()),
                timezone: Some(tzid.clone()),
            })
        }
    }
}

fn iso_day(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn iso_date(value: &str) -> Result<NaiveDate, MailError> {
    let value = value.trim();
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| MailError::Calendar(format!("date « {value} » invalide (AAAA-MM-JJ)")))
}

fn date_time(value: &Option<String>) -> Result<Option<NaiveTime>, MailError> {
    match value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => NaiveTime::parse_from_str(value, "%H:%M")
            .map(Some)
            .map_err(|_| MailError::Calendar(format!("heure « {value} » invalide (HH:MM)"))),
        None => Ok(None),
    }
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

/// The parser reports the offending lines; the API only needs the first one.
fn reason(error: String) -> MailError {
    let first = error.lines().find(|line| !line.trim().is_empty());
    let message = first.unwrap_or("format iCalendar invalide").trim();
    MailError::Calendar(message.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(body: &str) -> String {
        format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Lavande//Tests//FR\r\n{body}END:VCALENDAR\r\n"
        )
    }

    fn single(body: &str) -> ExternalEvent {
        let events = parse_events(&wrap(body), None).expect("calendrier valide");
        assert_eq!(events.len(), 1, "un seul événement attendu : {events:?}");
        events.into_iter().next().expect("événement")
    }

    #[test]
    fn a_timed_event_in_utc() {
        let event = single(
            "BEGIN:VEVENT\r\n\
             UID:abc-123\r\n\
             SUMMARY:Réunion équipe\r\n\
             DTSTART:20240315T090000Z\r\n\
             DTEND:20240315T101500Z\r\n\
             LOCATION:Bureau\r\n\
             DESCRIPTION:Point hebdomadaire\r\n\
             END:VEVENT\r\n",
        );
        assert_eq!(event.uid.as_deref(), Some("abc-123"));
        assert_eq!(event.title, "Réunion équipe");
        assert_eq!(event.date, "2024-03-15");
        assert_eq!(event.start.as_deref(), Some("09:00"));
        assert_eq!(event.end.as_deref(), Some("10:15"));
        assert!(!event.all_day);
        assert_eq!(event.timezone.as_deref(), Some("UTC"));
        assert_eq!(event.location.as_deref(), Some("Bureau"));
        assert_eq!(event.description.as_deref(), Some("Point hebdomadaire"));
        assert!(!event.recurring);
        assert_eq!(event.source, None);
    }

    #[test]
    fn an_all_day_event_has_no_time() {
        let event = single(
            "BEGIN:VEVENT\r\n\
             UID:jour\r\n\
             SUMMARY:Journée off\r\n\
             DTSTART;VALUE=DATE:20240320\r\n\
             DTEND;VALUE=DATE:20240321\r\n\
             END:VEVENT\r\n",
        );
        assert_eq!(event.date, "2024-03-20");
        assert_eq!(event.start, None);
        assert_eq!(event.end, None);
        assert!(event.all_day);
        assert_eq!(event.timezone, None);
    }

    #[test]
    fn a_tzid_event_keeps_its_zone_and_wall_clock() {
        let event = single(
            "BEGIN:VEVENT\r\n\
             SUMMARY:Dîner\r\n\
             DTSTART;TZID=Europe/Paris:20240315T200000\r\n\
             DTEND;TZID=Europe/Paris:20240315T223000\r\n\
             END:VEVENT\r\n",
        );
        assert_eq!(event.date, "2024-03-15");
        assert_eq!(event.start.as_deref(), Some("20:00"));
        assert_eq!(event.end.as_deref(), Some("22:30"));
        assert_eq!(event.timezone.as_deref(), Some("Europe/Paris"));
    }

    #[test]
    fn a_floating_event_has_no_timezone() {
        let event = single(
            "BEGIN:VEVENT\r\n\
             SUMMARY:Flottant\r\n\
             DTSTART:20240315T080000\r\n\
             DTEND:20240315T090000\r\n\
             END:VEVENT\r\n",
        );
        assert_eq!(event.start.as_deref(), Some("08:00"));
        assert_eq!(event.timezone, None);
        assert!(!event.all_day);
    }

    #[test]
    fn folded_lines_are_unfolded() {
        let event = single(concat!(
            "BEGIN:VEVENT\r\n",
            "SUMMARY:Un titre beaucoup trop long pour tenir sur \r\n",
            " une seule ligne pliée\r\n",
            "DESCRIPTION:Première ligne \r\n",
            " deuxième ligne pliée\r\n",
            "DTSTART:20240315T090000Z\r\n",
            "END:VEVENT\r\n",
        ));
        assert_eq!(
            event.title,
            "Un titre beaucoup trop long pour tenir sur une seule ligne pliée"
        );
        assert_eq!(
            event.description.as_deref(),
            Some("Première ligne deuxième ligne pliée")
        );
    }

    #[test]
    fn text_escapes_are_resolved() {
        let event = single(
            "BEGIN:VEVENT\r\n\
             SUMMARY:Point\\, puis revue\\; suite\r\n\
             DESCRIPTION:Un\\ndeux\\\\trois\r\n\
             DTSTART:20240315T090000Z\r\n\
             END:VEVENT\r\n",
        );
        assert_eq!(event.title, "Point, puis revue; suite");
        assert_eq!(event.description.as_deref(), Some("Un\ndeux\\trois"));
    }

    #[test]
    fn a_recurring_event_is_flagged_not_expanded() {
        let events = parse_events(
            &wrap(
                "BEGIN:VEVENT\r\n\
                 UID:semaine\r\n\
                 SUMMARY:Point lundi\r\n\
                 DTSTART:20240304T090000Z\r\n\
                 DTEND:20240304T093000Z\r\n\
                 RRULE:FREQ=WEEKLY;COUNT=10\r\n\
                 END:VEVENT\r\n",
            ),
            None,
        )
        .expect("calendrier valide");
        assert_eq!(events.len(), 1);
        assert!(events[0].recurring);
    }

    #[test]
    fn todos_journals_and_timezones_are_ignored() {
        let events = parse_events(
            &wrap(
                "BEGIN:VTIMEZONE\r\n\
                 TZID:Europe/Paris\r\n\
                 BEGIN:STANDARD\r\n\
                 DTSTART:19701025T030000\r\n\
                 TZOFFSETFROM:+0200\r\n\
                 TZOFFSETTO:+0100\r\n\
                 END:STANDARD\r\n\
                 END:VTIMEZONE\r\n\
                 BEGIN:VTODO\r\n\
                 UID:tache\r\n\
                 SUMMARY:Acheter du pain\r\n\
                 DTSTART:20240315T090000Z\r\n\
                 END:VTODO\r\n\
                 BEGIN:VJOURNAL\r\n\
                 UID:note\r\n\
                 SUMMARY:Journal\r\n\
                 END:VJOURNAL\r\n\
                 BEGIN:VEVENT\r\n\
                 UID:evenement\r\n\
                 SUMMARY:Vrai rendez-vous\r\n\
                 DTSTART;TZID=Europe/Paris:20240315T120000\r\n\
                 END:VEVENT\r\n",
            ),
            Some("https://exemple.tld/calendrier.ics"),
        )
        .expect("calendrier valide");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].uid.as_deref(), Some("evenement"));
        assert_eq!(events[0].timezone.as_deref(), Some("Europe/Paris"));
        assert_eq!(
            events[0].source.as_deref(),
            Some("https://exemple.tld/calendrier.ics")
        );
    }

    #[test]
    fn an_event_without_dtstart_is_dropped() {
        let events = parse_events(
            &wrap(
                "BEGIN:VEVENT\r\n\
                 UID:sans-date\r\n\
                 SUMMARY:Sans date\r\n\
                 END:VEVENT\r\n",
            ),
            None,
        )
        .expect("calendrier valide");
        assert!(events.is_empty());
    }

    #[test]
    fn an_empty_calendar_is_not_an_error() {
        let events = parse_events(&wrap(""), None).expect("calendrier valide");
        assert!(events.is_empty());
    }

    #[test]
    fn a_missing_summary_gets_a_placeholder() {
        let event = single(
            "BEGIN:VEVENT\r\n\
             DTSTART:20240315T090000Z\r\n\
             END:VEVENT\r\n",
        );
        assert_eq!(event.title, "(sans titre)");
        assert_eq!(event.uid, None);
    }

    #[test]
    fn invalid_input_is_refused_without_panicking() {
        assert!(matches!(
            parse_events("", None),
            Err(MailError::Calendar(message)) if message == "calendrier vide"
        ));
        assert!(matches!(
            parse_events("   \r\n\r\n", None),
            Err(MailError::Calendar(_))
        ));
        assert!(matches!(
            parse_events("ceci n'est pas un calendrier", None),
            Err(MailError::Calendar(_))
        ));
        assert!(matches!(
            parse_events("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n", None),
            Err(MailError::Calendar(_))
        ));
        assert!(matches!(
            parse_events("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", None),
            Ok(events) if events.is_empty()
        ));
        assert!(matches!(
            parse_events(
                &wrap("BEGIN:VEVENT\r\nDTSTART\nEND:VEVENT\r\n"),
                None
            ),
            Ok(events) if events.is_empty()
        ));
    }

    #[test]
    fn an_oversized_calendar_is_refused() {
        let content = "A".repeat(MAX_ICS_BYTES + 1);
        assert!(matches!(
            parse_events(&content, None),
            Err(MailError::Calendar(message)) if message.contains("trop volumineux")
        ));
    }

    #[test]
    fn lowercase_names_are_read_like_uppercase_ones() {
        let events = parse_events(
            "begin:vcalendar\r\nversion:2.0\r\nbegin:vevent\r\nuid:minuscule\r\nsummary:un titre en minuscules\r\ndtstart:20240315T090000Z\r\nend:vevent\r\nend:vcalendar\r\n",
            None,
        )
        .expect("calendrier valide");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].uid.as_deref(), Some("minuscule"));
        assert_eq!(events[0].title, "un titre en minuscules");
        assert_eq!(events[0].date, "2024-03-15");
        assert_eq!(events[0].start.as_deref(), Some("09:00"));
    }

    #[test]
    fn alarms_and_attendees_do_not_disturb_the_event() {
        let event = single(
            "BEGIN:VEVENT\r\n\
             UID:avec-alarme\r\n\
             SUMMARY:Rendez-vous\r\n\
             DTSTART;TZID=Europe/Paris:20240315T110000\r\n\
             ATTENDEE;CN=Camille:mailto:camille@studio-lilas.fr\r\n\
             CATEGORIES:RENDEZ-VOUS,PRO\r\n\
             CLASS:PRIVATE\r\n\
             BEGIN:VALARM\r\n\
             ACTION:DISPLAY\r\n\
             TRIGGER:-PT15M\r\n\
             DESCRIPTION:Rappel\r\n\
             END:VALARM\r\n\
             END:VEVENT\r\n",
        );
        assert_eq!(event.title, "Rendez-vous");
        assert_eq!(event.start.as_deref(), Some("11:00"));
        assert_eq!(event.timezone.as_deref(), Some("Europe/Paris"));
        assert!(!event.recurring);
    }

    #[test]
    fn a_calendar_without_wrapper_is_read() {
        let events = parse_events(
            "BEGIN:VEVENT\r\nSUMMARY:Sans enveloppe\r\nDTSTART:20240315T090000Z\r\nEND:VEVENT\r\n",
            None,
        )
        .expect("calendrier valide");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Sans enveloppe");
    }

    #[test]
    fn lf_line_endings_are_accepted() {
        let events = parse_events(
            "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:LF\nDTSTART:20240315T090000Z\nEND:VEVENT\nEND:VCALENDAR\n",
            None,
        )
        .expect("calendrier valide");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].start.as_deref(), Some("09:00"));
    }

    #[test]
    fn several_events_keep_their_order() {
        let events = parse_events(
            &wrap(
                "BEGIN:VEVENT\r\nSUMMARY:Un\r\nDTSTART:20240315T090000Z\r\nEND:VEVENT\r\n\
                 BEGIN:VEVENT\r\nSUMMARY:Deux\r\nDTSTART:20240316T090000Z\r\nEND:VEVENT\r\n",
            ),
            None,
        )
        .expect("calendrier valide");
        assert_eq!(
            events
                .iter()
                .map(|event| event.title.as_str())
                .collect::<Vec<_>>(),
            ["Un", "Deux"]
        );
        assert_eq!(events[1].date, "2024-03-16");
    }

    fn written(event: ExternalEvent) -> (String, ExternalEvent) {
        let ics = event_ics(&event).expect("iCalendar écrit");
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(ics.ends_with("END:VCALENDAR\r\n"));
        let reread = parse_events(&ics, None).expect("iCalendar relu");
        assert_eq!(reread.len(), 1, "un seul événement écrit : {ics}");
        (ics, reread.into_iter().next().expect("événement"))
    }

    fn draft(title: &str, date: &str) -> ExternalEvent {
        ExternalEvent {
            uid: Some(event_uid(None)),
            title: title.to_string(),
            date: date.to_string(),
            ..ExternalEvent::default()
        }
    }

    #[test]
    fn a_whole_day_event_is_written_with_a_date() {
        let (ics, event) = written(draft("Journée off", "2024-03-20"));
        assert!(ics.contains("DTSTART;VALUE=DATE:20240320\r\n"), "{ics}");
        assert!(ics.contains("DTEND;VALUE=DATE:20240321\r\n"), "{ics}");
        assert!(ics.contains("\r\nDTSTAMP:"), "{ics}");
        assert!(ics.contains("PRODID:-//Lavande//Agenda//FR"), "{ics}");
        assert!(ics.contains("SUMMARY:Journée off\r\n"), "{ics}");
        assert_eq!(event.title, "Journée off");
        assert_eq!(event.date, "2024-03-20");
        assert!(event.all_day);
        assert_eq!(event.start, None);
    }

    #[test]
    fn a_timed_event_is_written_with_its_hours() {
        let mut event = draft("Réunion", "2024-03-15");
        event.start = Some("14:00".to_string());
        event.end = Some("15:30".to_string());
        event.location = Some("Bureau".to_string());
        event.description = Some("Point hebdomadaire".to_string());
        let (ics, reread) = written(event);
        assert!(ics.contains("DTSTART:20240315T140000\r\n"), "{ics}");
        assert!(ics.contains("DTEND:20240315T153000\r\n"), "{ics}");
        assert!(ics.contains("LOCATION:Bureau\r\n"), "{ics}");
        assert_eq!(reread.start.as_deref(), Some("14:00"));
        assert_eq!(reread.end.as_deref(), Some("15:30"));
        assert_eq!(reread.location.as_deref(), Some("Bureau"));
        assert_eq!(reread.description.as_deref(), Some("Point hebdomadaire"));
        assert!(!reread.all_day);
        assert_eq!(reread.timezone, None);
    }

    #[test]
    fn a_timed_event_without_end_lasts_one_hour() {
        let mut event = draft("Sans fin", "2024-03-15");
        event.start = Some("23:15".to_string());
        let (ics, reread) = written(event);
        assert!(ics.contains("DTEND:20240316T001500\r\n"), "{ics}");
        assert_eq!(reread.end.as_deref(), Some("00:15"));
    }

    #[test]
    fn text_escapes_are_written() {
        let mut event = draft("Point, puis revue; suite", "2024-03-15");
        event.location = Some("Salle 1\\2".to_string());
        event.description = Some("Un\nDeux".to_string());
        let (ics, reread) = written(event);
        assert!(
            ics.contains("SUMMARY:Point\\, puis revue\\; suite\r\n"),
            "{ics}"
        );
        assert!(ics.contains("DESCRIPTION:Un\\nDeux\r\n"), "{ics}");
        assert_eq!(reread.title, "Point, puis revue; suite");
        assert_eq!(reread.location.as_deref(), Some("Salle 1\\2"));
        assert_eq!(reread.description.as_deref(), Some("Un\nDeux"));
    }

    #[test]
    fn a_long_value_is_folded() {
        let long = "Un titre vraiment très long ".repeat(10);
        let (ics, reread) = written(draft(long.trim(), "2024-03-15"));
        assert!(ics.lines().all(|line| line.len() <= 76), "{ics}");
        assert_eq!(reread.title, long.trim());
    }

    #[test]
    fn the_uid_of_an_event_is_kept_or_generated() {
        assert_eq!(event_uid(Some("abc-123")), "abc-123");
        assert_eq!(event_uid(Some("  abc-123  ")), "abc-123");
        let generated = event_uid(None);
        assert!(generated.ends_with("@lavande"), "{generated}");
        assert_eq!(generated.len(), 32 + "@lavande".len());
        assert!(generated[..32].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(generated, event_uid(None));
    }

    #[test]
    fn a_written_uid_is_the_one_of_the_resource() {
        let mut event = draft("Titre", "2024-03-15");
        event.uid = Some("reunion-caldav".to_string());
        let (ics, reread) = written(event);
        assert!(ics.contains("UID:reunion-caldav\r\n"), "{ics}");
        assert_eq!(reread.uid.as_deref(), Some("reunion-caldav"));
    }

    #[test]
    fn an_incomplete_event_is_refused() {
        let mut without_uid = draft("Titre", "2024-03-15");
        without_uid.uid = None;
        assert!(matches!(
            event_ics(&without_uid),
            Err(MailError::Calendar(_))
        ));
        let mut blank_uid = draft("Titre", "2024-03-15");
        blank_uid.uid = Some("   ".to_string());
        assert!(matches!(event_ics(&blank_uid), Err(MailError::Calendar(_))));
        let mut untitled = draft("Titre", "2024-03-15");
        untitled.title = "  ".to_string();
        assert!(matches!(event_ics(&untitled), Err(MailError::Calendar(_))));
        let mut bad_date = draft("Titre", "2024-03-15");
        bad_date.date = "15/03/2024".to_string();
        assert!(matches!(event_ics(&bad_date), Err(MailError::Calendar(_))));
        let mut bad_time = draft("Titre", "2024-03-15");
        bad_time.start = Some("9h".to_string());
        assert!(matches!(event_ics(&bad_time), Err(MailError::Calendar(_))));
        let mut backwards = draft("Titre", "2024-03-15");
        backwards.start = Some("15:00".to_string());
        backwards.end = Some("14:00".to_string());
        assert!(matches!(event_ics(&backwards), Err(MailError::Calendar(_))));
    }
}
