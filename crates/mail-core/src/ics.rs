//! iCalendar import and export (RFC 5545).
//!
//! The parsed calendar is projected onto [`ExternalEvent`]: only what the
//! agenda displays leaves the daemon. `VEVENT` are read; `VTODO` and `VJOURNAL`
//! are ignored, `VTIMEZONE` is kept as the fallback for a `TZID` chrono-tz does
//! not know.
//!
//! A recurring event (`RRULE`, `RDATE`, `EXDATE`) comes out as one
//! [`ExternalEvent`] per occurrence inside a bounded window — one month back, a
//! year ahead — sharing the `UID` of the series and carrying a
//! `recurrence_id`. `RECURRENCE-ID` replaces the occurrence it names. A rule the
//! daemon cannot read leaves the series as one entry, flagged `recurring`.
//!
//! Times are the wall clock of the event's zone: a `TZID` chrono-tz knows (IANA
//! names and a short table of Windows aliases) expands the series across DST;
//! otherwise the `VTIMEZONE` offset, then the wall clock as written, keeps the
//! visibility right. The `TZID` (or `"UTC"` for a `Z` value) travels with the
//! event so the caller can decide. [`event_ics`] writes the opposite way: one
//! `VEVENT` per resource, whole-day or floating local clock, never a
//! `recurrence_id`.

use std::borrow::Cow;
use std::str::FromStr;

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use icalendar::{
    Calendar, CalendarComponent, CalendarDateTime, Component, DatePerhapsTime, Event, EventLike,
    Property, RRuleSet, Tz,
};
use serde::{Deserialize, Serialize};

use crate::error::MailError;

/// Largest calendar accepted, in bytes, for a payload as well as a fetch.
pub const MAX_ICS_BYTES: usize = 2 * 1024 * 1024;

/// Largest number of events read out of one calendar.
pub const MAX_ICS_EVENTS: usize = 10_000;

/// Days a recurring series is expanded before today.
const RECURRENCE_PAST_DAYS: i64 = 31;

/// Days a recurring series is expanded after today.
const RECURRENCE_FUTURE_DAYS: i64 = 366;

/// Largest number of occurrences read out of one series.
const MAX_SERIES_OCCURRENCES: u16 = 500;

/// Windows zone names Outlook and Exchange write instead of an IANA one.
const WINDOWS_ZONES: [(&str, &str); 6] = [
    ("Romance Standard Time", "Europe/Paris"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("GMT Standard Time", "Europe/London"),
    ("Eastern Standard Time", "America/New_York"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("Central European Standard Time", "Europe/Warsaw"),
];

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
    /// A recurrence rule is present; the event is one entry of a series.
    pub recurring: bool,
    /// Identity of this occurrence inside its series: the UTC instant of the
    /// slot, `YYYYMMDDTHHMMSSZ`. Absent on a series the daemon could not expand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,
    /// Address that convenes the event, `mailto:` removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organizer: Option<String>,
    /// Guest addresses, `mailto:` removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attendees: Option<Vec<String>>,
    /// Calendar the event came from: the fetched URL, or the label the caller
    /// gave.
    pub source: Option<String>,
}

/// Parses a calendar resource, with the guards every caller shares: an empty
/// payload, one past [`MAX_ICS_BYTES`], a byte-order mark and names written in
/// any case.
pub(crate) fn calendar_of(content: &str) -> Result<Calendar, MailError> {
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
    Calendar::from_str(&normalized_names(content)).map_err(reason)
}

/// One `VEVENT` as written, the series entry and not its occurrences.
pub(crate) fn written(event: &Event) -> Option<ExternalEvent> {
    Some(project(event, slot(event)?, None, None))
}

/// Reads every `VEVENT` of `content`. `source` is copied onto each event.
///
/// A recurring series is expanded over the window around today; each occurrence
/// comes out as its own [`ExternalEvent`], carrying the `UID` of the series.
pub fn parse_events(content: &str, source: Option<&str>) -> Result<Vec<ExternalEvent>, MailError> {
    parse_events_within(content, source, Window::around(Utc::now().date_naive()))
}

/// Days a series is expanded over, both ends included.
#[derive(Clone, Copy, Debug)]
struct Window {
    from: NaiveDate,
    to: NaiveDate,
}

impl Window {
    fn around(day: NaiveDate) -> Self {
        Self {
            from: day - Duration::days(RECURRENCE_PAST_DAYS),
            to: day + Duration::days(RECURRENCE_FUTURE_DAYS),
        }
    }
}

fn parse_events_within(
    content: &str,
    source: Option<&str>,
    window: Window,
) -> Result<Vec<ExternalEvent>, MailError> {
    let calendar = calendar_of(content)?;
    let entries: Vec<&Event> = calendar.events().collect();
    if entries.len() > MAX_ICS_EVENTS {
        return Err(MailError::Calendar(format!(
            "calendrier trop volumineux : plus de {MAX_ICS_EVENTS} événements"
        )));
    }
    let timezones = Timezones::new(&calendar);
    let mut events = Vec::new();
    for group in series(entries.into_iter()) {
        events.extend(group.project(&timezones, window, source));
    }
    // L'expansion d'une série ne fait pas déborder la mémoire : le surplus des
    // dernières occurrences est coupé, comme une source qui en écrirait trop.
    events.truncate(MAX_ICS_EVENTS);
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
/// hour. `attendees` turns the resource into an invitation: the `ORGANIZER` and
/// the guests are written, and the CalDAV server schedules the mail itself
/// (RFC 6638).
pub fn event_ics(event: &ExternalEvent) -> Result<String, MailError> {
    let mut entry = vevent(event)?;
    if let Some(attendees) = guests(event) {
        let organizer = event
            .organizer
            .as_deref()
            .map(str::trim)
            .filter(|organizer| !organizer.is_empty())
            .ok_or_else(|| {
                MailError::Calendar(
                    "invitation sans organisateur : l'adresse du compte est inconnue".to_string(),
                )
            })?;
        entry.append_property(Property::new("ORGANIZER", format!("mailto:{organizer}")));
        for attendee in attendees {
            entry.append_multi_property(attendee_property(&attendee, "NEEDS-ACTION", true));
        }
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

/// Guest addresses of an event, `None` when it convenes nobody: the entries that
/// are not addresses are dropped.
fn guests(event: &ExternalEvent) -> Option<Vec<String>> {
    let attendees: Vec<String> = event
        .attendees
        .iter()
        .flatten()
        .filter_map(|attendee| address_of(attendee))
        .collect();
    (!attendees.is_empty()).then_some(attendees)
}

/// One `ATTENDEE` of a written invitation, `PARTSTAT` answering for the reader.
pub(crate) fn attendee_property(email: &str, partstat: &str, rsvp: bool) -> Property {
    let mut property = Property::new("ATTENDEE", format!("mailto:{email}"));
    property
        .add_parameter("CUTYPE", "INDIVIDUAL")
        .add_parameter("ROLE", "REQ-PARTICIPANT")
        .add_parameter("PARTSTAT", partstat)
        .add_parameter("RSVP", if rsvp { "TRUE" } else { "FALSE" });
    property
}

/// The `VEVENT` of one event: `UID`, summary, `DTSTAMP`, dates, location and
/// description. Recurrence and parties are the caller's business.
pub(crate) fn vevent(event: &ExternalEvent) -> Result<Event, MailError> {
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
    Ok(entry)
}

/// One `UID` of the calendar: the entry of the series, and the occurrences a
/// producer changed into their own `VEVENT` (`RECURRENCE-ID`).
struct Series<'a> {
    master: Option<&'a Event>,
    overrides: Vec<&'a Event>,
}

impl<'a> Series<'a> {
    fn new() -> Self {
        Self {
            master: None,
            overrides: Vec::new(),
        }
    }

    fn push(&mut self, event: &'a Event) {
        if carries(event, "RECURRENCE-ID") {
            self.overrides.push(event);
        } else if self.master.is_none() {
            self.master = Some(event);
        }
    }

    /// Everything the agenda shows for this `UID`: the occurrences inside the
    /// window, or the single entry of an event that does not recur.
    fn project(
        &self,
        timezones: &Timezones,
        window: Window,
        source: Option<&str>,
    ) -> Vec<ExternalEvent> {
        let Some(master) = self.master else {
            return self
                .overrides
                .iter()
                .filter_map(|event| {
                    let at = slot(event)?;
                    Some(project(event, at, changed_key(event, timezones), source))
                })
                .collect();
        };
        if recurring(master) {
            if let Some(occurrences) = expand(self, master, timezones, window, source) {
                return occurrences;
            }
        }
        let mut events = Vec::new();
        if let Some(at) = slot(master) {
            events.push(project(master, at, None, source));
        }
        for event in &self.overrides {
            if let Some(at) = slot(event) {
                events.push(project(event, at, changed_key(event, timezones), source));
            }
        }
        events
    }
}

/// Groups the `VEVENT` of a calendar by `UID`, keeping their order. An event
/// without `UID`, or a second entry for the same `UID`, stands on its own.
fn series<'a>(events: impl Iterator<Item = &'a Event>) -> Vec<Series<'a>> {
    let mut groups: Vec<(Option<String>, Series<'a>)> = Vec::new();
    for event in events {
        let uid = event.get_uid().map(str::to_string);
        let instance = carries(event, "RECURRENCE-ID");
        let known = uid.as_ref().and_then(|uid| {
            groups.iter_mut().find(|(key, series)| {
                key.as_deref() == Some(uid.as_str()) && (instance || series.master.is_none())
            })
        });
        match known {
            Some((_, series)) => series.push(event),
            None => {
                let mut series = Series::new();
                series.push(event);
                groups.push((uid, series));
            }
        }
    }
    groups.into_iter().map(|(_, series)| series).collect()
}

/// Property of a component, whether the file wrote it once or several times.
fn carries(event: &Event, key: &str) -> bool {
    event.properties().contains_key(key) || event.multi_properties().contains_key(key)
}

/// Every occurrence of a property, written once or repeated.
pub(crate) fn repeated<'a>(event: &'a Event, key: &str) -> Vec<&'a Property> {
    event
        .properties()
        .get(key)
        .into_iter()
        .chain(event.multi_properties().get(key).into_iter().flatten())
        .collect()
}

/// Address of an `ORGANIZER` or `ATTENDEE` value: `mailto:` and the surrounding
/// blanks removed, `None` when it is not an address.
pub fn address_of(value: &str) -> Option<String> {
    let value = value.trim();
    let address = match value.to_ascii_lowercase().strip_prefix("mailto:").is_some() {
        true => value[7..].trim(),
        false => value,
    };
    // `mailto:a@b?subject=x` carries parameters past the address.
    let address = address.split('?').next().unwrap_or_default().trim();
    (address.contains('@') && !address.contains(char::is_whitespace)).then(|| address.to_string())
}

fn organizer_of(event: &Event) -> Option<String> {
    event.property_value("ORGANIZER").and_then(address_of)
}

fn attendees_of(event: &Event) -> Option<Vec<String>> {
    let attendees: Vec<String> = repeated(event, "ATTENDEE")
        .into_iter()
        .filter_map(|property| address_of(property.value()))
        .collect();
    (!attendees.is_empty()).then_some(attendees)
}

/// Rule or irregular dates: the series is written once for several occurrences.
fn recurring(event: &Event) -> bool {
    carries(event, "RRULE") || carries(event, "RDATE")
}

/// Instant a `RECURRENCE-ID` names: the UTC instant of a `Z` value, the wall
/// clock read in `clock` otherwise — the identifier is written in the zone of
/// the series it belongs to (RFC 5545, 3.8.4.4).
fn recurrence_key(clock: &Clock, tz: Tz, property: &Property) -> Option<String> {
    let (zone, wall) = moment_property(property)?;
    Some(match zone.as_deref() {
        Some("UTC") => utc_text(wall),
        _ => clock.key(clock.at(tz, wall)),
    })
}

/// `UID` of the occurrence a `RECURRENCE-ID` names, read in the clock of the
/// event that carries it; the value as written when that clock is unreadable,
/// two occurrences still needing distinct identities.
fn changed_key(event: &Event, timezones: &Timezones) -> Option<String> {
    let property = event.properties().get("RECURRENCE-ID")?;
    if let Some((clock, set)) = rule_of(event, timezones) {
        if let Some(key) = recurrence_key(&clock, set.get_dt_start().timezone(), property) {
            return Some(key);
        }
    }
    Some(property.value().trim().to_string())
}

/// Occurrences of a recurring series inside the window, the changed ones in
/// place of the occurrence they replace. `None` when the rule cannot be read:
/// the caller then keeps the series as one entry.
fn expand(
    series: &Series,
    master: &Event,
    timezones: &Timezones,
    window: Window,
    source: Option<&str>,
) -> Option<Vec<ExternalEvent>> {
    let (clock, set) = rule_of(master, timezones)?;
    let base = slot(master)?;
    let tz = set.get_dt_start().timezone();
    let from = clock.at(tz, window.from.and_time(NaiveTime::MIN));
    let to = clock.at(tz, window.to.and_time(NaiveTime::from_hms_opt(23, 59, 59)?));
    let dates = set.after(from).before(to).all(MAX_SERIES_OCCURRENCES).dates;
    let changed: Vec<(&Event, String)> = series
        .overrides
        .iter()
        .filter_map(|event| {
            let property = event.properties().get("RECURRENCE-ID")?;
            Some((*event, recurrence_key(&clock, tz, property)?))
        })
        .collect();
    let mut replaced = vec![false; changed.len()];
    let mut events = Vec::with_capacity(dates.len());
    for at in dates {
        let wall = clock.wall(at);
        let key = clock.key(at);
        match changed.iter().position(|(_, known)| *known == key) {
            Some(index) => {
                replaced[index] = true;
                let (event, key) = &changed[index];
                if let Some(at) = slot(event) {
                    if inside(window, at.date) {
                        events.push(project(event, at, Some(key.clone()), source));
                    }
                }
            }
            None => {
                let start = wall.time();
                let at = Slot {
                    date: wall.date(),
                    start: base.start.map(|_| start),
                    end: base.span().map(|span| start + span),
                    timezone: base.timezone.clone(),
                };
                events.push(project(master, at, Some(key), source));
            }
        }
    }
    for (index, (event, key)) in changed.iter().enumerate() {
        let Some(at) = slot(event) else { continue };
        if replaced[index] || !inside(window, at.date) {
            continue;
        }
        events.push(project(event, at, Some(key.clone()), source));
    }
    Some(events)
}

fn inside(window: Window, day: NaiveDate) -> bool {
    day >= window.from && day <= window.to
}

/// Wall clock of one `VEVENT` as the agenda shows it.
struct Slot {
    date: NaiveDate,
    start: Option<NaiveTime>,
    end: Option<NaiveTime>,
    /// `TZID` of `DTSTART`; absent for a whole-day or floating event.
    timezone: Option<String>,
}

impl Slot {
    /// Duration of the event, when `DTSTART` and `DTEND` carry a clock.
    fn span(&self) -> Option<Duration> {
        Some(self.end? - self.start?)
    }
}

/// Wall clock of a `VEVENT`; `None` without a usable `DTSTART`, the event then
/// being dropped instead of failing the whole import.
fn slot(event: &Event) -> Option<Slot> {
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
    };
    Some(Slot {
        date: start.date,
        start: start.time,
        end,
        timezone: if all_day { None } else { start.timezone },
    })
}

fn project(
    event: &Event,
    at: Slot,
    recurrence_id: Option<String>,
    source: Option<&str>,
) -> ExternalEvent {
    ExternalEvent {
        uid: event.get_uid().map(str::to_string),
        title: event
            .get_summary()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or("(sans titre)")
            .to_string(),
        date: iso_day(at.date),
        start: at.start.map(clock),
        end: at.end.map(clock),
        all_day: at.start.is_none(),
        timezone: at.timezone,
        location: text(event.get_location()),
        description: text(event.get_description()),
        recurring: recurring(event) || carries(event, "RECURRENCE-ID"),
        recurrence_id,
        organizer: organizer_of(event),
        attendees: attendees_of(event),
        source: source.map(str::to_string),
    }
}

/// Zone a series is written in: how a wall clock becomes an instant, and back.
#[derive(Clone, Debug)]
enum Clock {
    /// `DTSTART;TZID=<name>` chrono-tz knows: the rule runs in that zone, so the
    /// wall clock follows the local time across DST.
    Named(String),
    /// `DTSTART` written in UTC (`Z` value).
    Utc,
    /// Offset taken from the `VTIMEZONE`: the rule runs in UTC, shifted.
    Fixed(FixedOffset),
    /// Floating clock, or `VALUE=DATE`: taken as written, expanded in UTC.
    Wall,
}

impl Clock {
    /// Parameters a date-time line carries in this clock.
    fn suffix(&self) -> String {
        match self {
            Clock::Named(name) => format!(";TZID={name}"),
            _ => String::new(),
        }
    }

    /// Wall clock seen from the zone the rule runs in: UTC everywhere but in a
    /// named zone, where the value is kept as written.
    fn shift(&self, wall: NaiveDateTime) -> NaiveDateTime {
        match self {
            Clock::Named(_) | Clock::Utc | Clock::Wall => wall,
            Clock::Fixed(offset) => wall - *offset,
        }
    }

    /// Instant of a wall clock, in the zone the rule runs in.
    fn at(&self, tz: Tz, wall: NaiveDateTime) -> DateTime<Tz> {
        let wall = self.shift(wall);
        tz.from_local_datetime(&wall)
            .earliest()
            .unwrap_or_else(|| tz.from_utc_datetime(&wall))
    }

    /// Wall clock of an occurrence, in the zone the event is written in.
    fn wall(&self, at: DateTime<Tz>) -> NaiveDateTime {
        match self {
            Clock::Named(_) => at.naive_local(),
            Clock::Utc | Clock::Wall => at.naive_utc(),
            Clock::Fixed(offset) => at.naive_utc() + *offset,
        }
    }

    fn key(&self, at: DateTime<Tz>) -> String {
        utc_text(at.with_timezone(&Utc).naive_utc())
    }

    /// Value of a date-time property rrule parses: the raw one inside a named
    /// zone, the UTC instant this clock reads everywhere else.
    fn value(&self, raw: &str, wall: NaiveDateTime) -> String {
        match self {
            Clock::Named(_) => raw.to_string(),
            _ => utc_text(self.shift(wall)),
        }
    }

    /// `RDATE`/`EXDATE` lines, values of an unknown zone read in this clock.
    fn date_lines(&self, event: &Event, key: &str) -> Vec<String> {
        let mut lines = Vec::new();
        let written = event
            .properties()
            .get(key)
            .into_iter()
            .chain(event.multi_properties().get(key).into_iter().flatten());
        for property in written {
            let own = property
                .params()
                .get("TZID")
                .and_then(|param| iana_name(param.value()));
            let mut values = Vec::new();
            for raw in property.value().split(',').map(str::trim) {
                let Some(wall) = moment(raw) else { continue };
                values.push(match &own {
                    Some(_) => raw.to_string(),
                    None => self.value(raw, wall),
                });
            }
            if values.is_empty() {
                continue;
            }
            let suffix = match &own {
                Some(name) => format!(";TZID={name}"),
                None => self.suffix(),
            };
            lines.push(format!("{key}{suffix}:{}", values.join(",")));
        }
        lines
    }

    /// `DTSTART`, `RRULE`, `RDATE` and `EXDATE` text rrule parses for this clock.
    fn rule(&self, event: &Event, wall: NaiveDateTime) -> Option<RRuleSet> {
        let start = event.property_value("DTSTART")?;
        let suffix = self.suffix();
        let value = self.value(start, wall);
        let mut body = format!("DTSTART{suffix}:{value}\n");
        match text(event.property_value("RRULE")) {
            Some(rule) => body.push_str(&format!("RRULE:{rule}\n")),
            // RFC 5545 §3.6.1: without a rule, `DTSTART` is the only instance.
            None => body.push_str(&format!("RDATE{suffix}:{value}\n")),
        }
        for key in ["RDATE", "EXDATE"] {
            for line in self.date_lines(event, key) {
                body.push_str(&line);
                body.push('\n');
            }
        }
        body.parse::<RRuleSet>().ok()
    }
}

/// Rule of an event, with the clock its occurrences are read in. `None` when
/// `DTSTART` is missing or no zone lets the rule be read.
fn rule_of(event: &Event, timezones: &Timezones) -> Option<(Clock, RRuleSet)> {
    let start = event.get_start()?;
    let wall = match &start {
        DatePerhapsTime::Date(date) => date.and_time(NaiveTime::MIN),
        DatePerhapsTime::DateTime(CalendarDateTime::Utc(at)) => at.naive_utc(),
        DatePerhapsTime::DateTime(CalendarDateTime::Floating(at)) => *at,
        DatePerhapsTime::DateTime(CalendarDateTime::WithTimezone { date_time, .. }) => *date_time,
    };
    clocks(&start, timezones, wall)
        .into_iter()
        .find_map(|clock| clock.rule(event, wall).map(|set| (clock, set)))
}

/// Clocks the rule of an event can be read in, most faithful first.
fn clocks(start: &DatePerhapsTime, timezones: &Timezones, wall: NaiveDateTime) -> Vec<Clock> {
    let mut clocks = Vec::new();
    match start {
        DatePerhapsTime::DateTime(CalendarDateTime::Utc(_)) => clocks.push(Clock::Utc),
        DatePerhapsTime::DateTime(CalendarDateTime::WithTimezone { tzid, .. }) => {
            if let Some(name) = iana_name(tzid) {
                clocks.push(Clock::Named(name));
            } else if let Some(offset) = timezones.offset_at(tzid, wall) {
                clocks.push(Clock::Fixed(offset));
            }
        }
        _ => {}
    }
    clocks.push(Clock::Wall);
    clocks
}

/// `TZID` rrule accepts: an IANA name, or the IANA name of a Windows alias.
fn iana_name(tzid: &str) -> Option<String> {
    let tzid = tzid.trim();
    if let Some((_, iana)) = WINDOWS_ZONES
        .iter()
        .find(|(alias, _)| alias.eq_ignore_ascii_case(tzid))
    {
        return Some((*iana).to_string());
    }
    format!("DTSTART;TZID={tzid}:19700101T000000\nRRULE:FREQ=DAILY;COUNT=1")
        .parse::<RRuleSet>()
        .is_ok()
        .then(|| tzid.to_string())
}

/// Observance of a `VTIMEZONE`: offset the file declares from `onset` on.
struct Observance {
    offset: FixedOffset,
    onset: NaiveDateTime,
}

/// `VTIMEZONE` blocks of the file, the fallback for a `TZID` chrono-tz does not
/// know.
struct Timezones {
    zones: Vec<(String, Vec<Observance>)>,
}

impl Timezones {
    fn new(calendar: &Calendar) -> Self {
        let mut zones: Vec<(String, Vec<Observance>)> = Vec::new();
        for component in &calendar.components {
            let CalendarComponent::Other(zone) = component else {
                continue;
            };
            if zone.component_kind() != "VTIMEZONE" {
                continue;
            }
            let Some(tzid) = text(zone.property_value("TZID")) else {
                continue;
            };
            let observances = zone
                .components()
                .iter()
                .filter_map(|observance| {
                    Some(Observance {
                        offset: offset_of(observance.property_value("TZOFFSETTO")?)?,
                        onset: moment(observance.property_value("DTSTART")?)?,
                    })
                })
                .collect();
            zones.push((tzid, observances));
        }
        Self { zones }
    }

    /// Offset in effect at `wall` in zone `tzid`: the observance whose onset is
    /// the closest before the clock. Year and `BYDAY` are ignored, so a day next
    /// to a change can read the offset of the other observance.
    fn offset_at(&self, tzid: &str, wall: NaiveDateTime) -> Option<FixedOffset> {
        let (_, observances) = self.zones.iter().find(|(known, _)| known == tzid.trim())?;
        let clock = (wall.ordinal(), wall.time());
        let mut before = None;
        let mut last: Option<((u32, NaiveTime), FixedOffset)> = None;
        for observance in observances {
            let onset = (observance.onset.ordinal(), observance.onset.time());
            if onset <= clock && before.is_none_or(|(best, _)| onset > best) {
                before = Some((onset, observance.offset));
            }
            if last.is_none_or(|(best, _)| onset > best) {
                last = Some((onset, observance.offset));
            }
        }
        before.or(last).map(|(_, offset)| offset)
    }
}

/// Offset of a `TZOFFSETTO` value: `+0100`, `-0430`, `+053045`.
fn offset_of(value: &str) -> Option<FixedOffset> {
    let value = value.trim();
    let sign = match value.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = &value[1..];
    if digits.len() < 4 || !digits.bytes().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    let hours: i32 = digits[..2].parse().ok()?;
    let minutes: i32 = digits[2..4].parse().ok()?;
    let seconds: i32 = match digits.len() {
        4 => 0,
        _ => digits[4..6].parse().ok()?,
    };
    FixedOffset::east_opt(sign * (hours * 3600 + minutes * 60 + seconds))
}

/// Wall clock a date-time value writes: `YYYYMMDDTHHMMSS`, `YYYYMMDDTHHMM`,
/// `YYYYMMDD`; a trailing `Z` is dropped, the caller knowing the zone.
fn moment(value: &str) -> Option<NaiveDateTime> {
    let value = value.trim().trim_end_matches('Z');
    NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M"))
        .or_else(|_| {
            NaiveDate::parse_from_str(value, "%Y%m%d").map(|date| date.and_time(NaiveTime::MIN))
        })
        .ok()
}

/// Zone a date-time property names and the wall clock it writes: `"UTC"` for a
/// `Z` value, the `TZID` parameter otherwise.
fn moment_property(property: &Property) -> Option<(Option<String>, NaiveDateTime)> {
    let raw = property.value().trim();
    let tzid = property
        .params()
        .get("TZID")
        .map(|param| param.value().to_string());
    let zone = if raw.ends_with('Z') {
        Some("UTC".to_string())
    } else {
        tzid
    };
    Some((zone, moment(raw)?))
}

fn utc_text(wall: NaiveDateTime) -> String {
    wall.format("%Y%m%dT%H%M%SZ").to_string()
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

    fn within(from: &str, to: &str) -> Window {
        Window {
            from: NaiveDate::parse_from_str(from, "%Y-%m-%d").expect("borne"),
            to: NaiveDate::parse_from_str(to, "%Y-%m-%d").expect("borne"),
        }
    }

    fn expanded(body: &str, from: &str, to: &str) -> Vec<ExternalEvent> {
        parse_events_within(&wrap(body), None, within(from, to)).expect("calendrier valide")
    }

    fn days(events: &[ExternalEvent]) -> Vec<&str> {
        events.iter().map(|event| event.date.as_str()).collect()
    }

    #[test]
    fn a_weekly_series_is_expanded_once_per_occurrence() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             SUMMARY:Point hebdo\r\n\
             DTSTART;TZID=Europe/Paris:20240320T090000\r\n\
             DTEND;TZID=Europe/Paris:20240320T093000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=4\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(
            days(&events),
            ["2024-03-20", "2024-03-27", "2024-04-03", "2024-04-10"]
        );
        for event in &events {
            assert_eq!(event.uid.as_deref(), Some("semaine"));
            assert_eq!(event.start.as_deref(), Some("09:00"));
            assert_eq!(event.end.as_deref(), Some("09:30"));
            assert_eq!(event.timezone.as_deref(), Some("Europe/Paris"));
            assert!(event.recurring);
        }
        assert_eq!(
            events
                .iter()
                .map(|event| event.recurrence_id.as_deref().unwrap_or_default())
                .collect::<Vec<_>>(),
            [
                "20240320T080000Z",
                "20240327T080000Z",
                // Passage à l'heure d'été : 09:00 à Paris devient 07:00 UTC.
                "20240403T070000Z",
                "20240410T070000Z",
            ]
        );
    }

    #[test]
    fn an_exdate_drops_the_occurrence_it_names() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             SUMMARY:Point hebdo\r\n\
             DTSTART;TZID=Europe/Paris:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=3\r\n\
             EXDATE;TZID=Europe/Paris:20240327T090000\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-04-03"]);
    }

    #[test]
    fn an_exdate_in_utc_drops_the_occurrence_too() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             SUMMARY:Point hebdo\r\n\
             DTSTART;TZID=Europe/Paris:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=3\r\n\
             EXDATE:20240327T080000Z\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-04-03"]);
    }

    #[test]
    fn an_rdate_adds_an_occurrence() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             SUMMARY:Point hebdo\r\n\
             DTSTART;TZID=Europe/Paris:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             RDATE;TZID=Europe/Paris:20240405T140000\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-27", "2024-04-05"]);
        assert_eq!(events[2].start.as_deref(), Some("14:00"));
        assert_eq!(events[2].recurrence_id.as_deref(), Some("20240405T120000Z"));
    }

    #[test]
    fn irregular_dates_without_a_rule_are_expanded() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:atelier\r\n\
             SUMMARY:Atelier\r\n\
             DTSTART:20240320T090000Z\r\n\
             RDATE:20240410T090000Z,20240411T090000Z\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-04-10", "2024-04-11"]);
        assert!(events.iter().all(|event| event.recurring));
    }

    #[test]
    fn a_changed_occurrence_replaces_the_one_it_names() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             SUMMARY:Point hebdo\r\n\
             DTSTART;TZID=Europe/Paris:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=3\r\n\
             END:VEVENT\r\n\
             BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             RECURRENCE-ID;TZID=Europe/Paris:20240327T090000\r\n\
             SUMMARY:Point déplacé\r\n\
             DTSTART;TZID=Europe/Paris:20240327T150000\r\n\
             DTEND;TZID=Europe/Paris:20240327T160000\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-27", "2024-04-03"]);
        assert_eq!(events[1].title, "Point déplacé");
        assert_eq!(events[1].start.as_deref(), Some("15:00"));
        assert_eq!(events[1].end.as_deref(), Some("16:00"));
        assert_eq!(events[1].uid.as_deref(), Some("semaine"));
        assert!(events[1].recurring);
        // L'identifiant reste celui du créneau remplacé, pas celui de la nouvelle heure.
        assert_eq!(events[1].recurrence_id.as_deref(), Some("20240327T080000Z"));
    }

    #[test]
    fn a_changed_occurrence_outside_the_window_is_dropped() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             SUMMARY:Point hebdo\r\n\
             DTSTART:20240320T090000Z\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             END:VEVENT\r\n\
             BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             RECURRENCE-ID:20240327T090000Z\r\n\
             SUMMARY:Décalé loin\r\n\
             DTSTART:20250601T090000Z\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20"]);
        assert_eq!(events[0].title, "Point hebdo");
    }

    #[test]
    fn a_changed_occurrence_moved_to_another_zone_keeps_its_slot() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             SUMMARY:Point hebdo\r\n\
             DTSTART;TZID=Europe/Paris:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             END:VEVENT\r\n\
             BEGIN:VEVENT\r\n\
             UID:semaine\r\n\
             RECURRENCE-ID;TZID=Europe/Paris:20240327T090000\r\n\
             SUMMARY:Point en visio\r\n\
             DTSTART:20240327T130000Z\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-27"]);
        assert_eq!(events[1].title, "Point en visio");
        assert_eq!(events[1].start.as_deref(), Some("13:00"));
        assert_eq!(events[1].timezone.as_deref(), Some("UTC"));
        assert_eq!(events[1].recurrence_id.as_deref(), Some("20240327T080000Z"));
    }

    #[test]
    fn an_instance_without_its_series_is_an_event_of_its_own() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:morceau\r\n\
             RECURRENCE-ID;TZID=Europe/Paris:20240327T090000\r\n\
             SUMMARY:Point déplacé\r\n\
             DTSTART;TZID=Europe/Paris:20240327T110000\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-27"]);
        assert_eq!(events[0].uid.as_deref(), Some("morceau"));
        assert!(events[0].recurring);
        assert_eq!(events[0].recurrence_id.as_deref(), Some("20240327T080000Z"));
    }

    #[test]
    fn an_all_day_series_is_expanded_by_day() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:astreinte\r\n\
             SUMMARY:Astreinte\r\n\
             DTSTART;VALUE=DATE:20240320\r\n\
             RRULE:FREQ=DAILY;COUNT=3\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-21", "2024-03-22"]);
        for event in &events {
            assert!(event.all_day);
            assert_eq!(event.start, None);
            assert_eq!(event.end, None);
            assert_eq!(event.timezone, None);
        }
        assert_eq!(
            events
                .iter()
                .map(|event| event.recurrence_id.as_deref().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["20240320T000000Z", "20240321T000000Z", "20240322T000000Z"]
        );
    }

    #[test]
    fn a_floating_series_keeps_its_wall_clock() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:flottant\r\n\
             SUMMARY:Cours\r\n\
             DTSTART:20240320T180000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-27"]);
        assert_eq!(events[1].start.as_deref(), Some("18:00"));
        assert_eq!(events[1].timezone, None);
        assert_eq!(events[1].recurrence_id.as_deref(), Some("20240327T180000Z"));
    }

    #[test]
    fn a_windows_zone_name_is_read_as_its_iana_zone() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:windows\r\n\
             SUMMARY:Réunion\r\n\
             DTSTART;TZID=Romance Standard Time:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-27"]);
        assert_eq!(events[0].recurrence_id.as_deref(), Some("20240320T080000Z"));
        assert_eq!(events[0].timezone.as_deref(), Some("Romance Standard Time"));
    }

    #[test]
    fn an_unknown_zone_falls_back_to_its_vtimezone_offset() {
        let events = expanded(
            "BEGIN:VTIMEZONE\r\n\
             TZID:Calendrier central\r\n\
             BEGIN:STANDARD\r\n\
             DTSTART:19701025T030000\r\n\
             TZOFFSETFROM:+0200\r\n\
             TZOFFSETTO:+0100\r\n\
             END:STANDARD\r\n\
             BEGIN:DAYLIGHT\r\n\
             DTSTART:19700329T020000\r\n\
             TZOFFSETFROM:+0100\r\n\
             TZOFFSETTO:+0200\r\n\
             END:DAYLIGHT\r\n\
             END:VTIMEZONE\r\n\
             BEGIN:VEVENT\r\n\
             UID:inconnu\r\n\
             SUMMARY:Réunion\r\n\
             DTSTART;TZID=Calendrier central:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-27"]);
        assert_eq!(events[0].start.as_deref(), Some("09:00"));
        assert_eq!(events[0].timezone.as_deref(), Some("Calendrier central"));
        assert_eq!(events[0].recurrence_id.as_deref(), Some("20240320T080000Z"));
    }

    #[test]
    fn an_unknown_zone_without_a_vtimezone_keeps_its_wall_clock() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:inconnu\r\n\
             SUMMARY:Réunion\r\n\
             DTSTART;TZID=Zone introuvable:20240320T090000\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-27"]);
        assert_eq!(events[0].start.as_deref(), Some("09:00"));
        assert_eq!(events[0].timezone.as_deref(), Some("Zone introuvable"));
        assert_eq!(events[0].recurrence_id.as_deref(), Some("20240320T090000Z"));
    }

    #[test]
    fn the_window_bounds_the_occurrences() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:longue\r\n\
             SUMMARY:Tous les jours\r\n\
             DTSTART;VALUE=DATE:20240101\r\n\
             RRULE:FREQ=DAILY\r\n\
             END:VEVENT\r\n",
            "2024-03-20",
            "2024-03-22",
        );
        assert_eq!(days(&events), ["2024-03-20", "2024-03-21", "2024-03-22"]);
    }

    #[test]
    fn an_event_outside_the_window_is_still_shown() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:fini\r\n\
             SUMMARY:Série finie\r\n\
             DTSTART:20200101T090000Z\r\n\
             RRULE:FREQ=WEEKLY;COUNT=2\r\n\
             END:VEVENT\r\n\
             BEGIN:VEVENT\r\n\
             UID:unique\r\n\
             SUMMARY:Unique\r\n\
             DTSTART:20200101T100000Z\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2020-01-01"]);
        assert_eq!(events[0].title, "Unique");
        assert!(!events[0].recurring);
    }

    #[test]
    fn one_series_is_capped() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:enorme\r\n\
             SUMMARY:Tous les jours\r\n\
             DTSTART;VALUE=DATE:20200101\r\n\
             RRULE:FREQ=DAILY\r\n\
             END:VEVENT\r\n",
            "2020-01-01",
            "2025-01-01",
        );
        assert_eq!(events.len(), usize::from(MAX_SERIES_OCCURRENCES));
    }

    #[test]
    fn an_expanded_calendar_is_truncated_at_the_global_cap() {
        let mut body = String::new();
        for index in 0..30 {
            body.push_str(&format!(
                "BEGIN:VEVENT\r\nUID:serie-{index}\r\nSUMMARY:Série {index}\r\n\
                 DTSTART;VALUE=DATE:20240101\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n"
            ));
        }
        let events = expanded(&body, "2024-01-01", "2024-12-31");
        assert_eq!(events.len(), MAX_ICS_EVENTS);
    }

    #[test]
    fn a_calendar_with_too_many_entries_is_refused() {
        let body =
            "BEGIN:VEVENT\r\nDTSTART:20240101T090000Z\r\nEND:VEVENT\r\n".repeat(MAX_ICS_EVENTS + 1);
        assert!(matches!(
            parse_events(&wrap(&body), None),
            Err(MailError::Calendar(message)) if message.contains("trop volumineux")
        ));
    }

    #[test]
    fn a_rule_the_daemon_cannot_read_leaves_the_series_as_one_entry() {
        let events = expanded(
            "BEGIN:VEVENT\r\n\
             UID:casse\r\n\
             SUMMARY:Point\r\n\
             DTSTART:20240320T090000Z\r\n\
             RRULE:FREQ=NIMPORTEQUOI\r\n\
             END:VEVENT\r\n",
            "2024-03-01",
            "2024-04-30",
        );
        assert_eq!(days(&events), ["2024-03-20"]);
        assert!(events[0].recurring);
        assert_eq!(events[0].recurrence_id, None);
    }

    #[test]
    fn the_default_window_covers_the_coming_year() {
        let events = parse_events(
            &wrap(
                "BEGIN:VEVENT\r\n\
                 UID:aujourdhui\r\n\
                 SUMMARY:Hebdo\r\n\
                 DTSTART;TZID=Europe/Paris:20240101T090000\r\n\
                 RRULE:FREQ=WEEKLY\r\n\
                 END:VEVENT\r\n",
            ),
            None,
        )
        .expect("calendrier valide");
        let today = Utc::now().date_naive();
        let first = NaiveDate::parse_from_str(&events[0].date, "%Y-%m-%d").expect("date");
        let last =
            NaiveDate::parse_from_str(&events[events.len() - 1].date, "%Y-%m-%d").expect("date");
        assert!(first >= today - Duration::days(RECURRENCE_PAST_DAYS));
        assert!(first < today + Duration::days(8));
        assert!(last > today + Duration::days(RECURRENCE_FUTURE_DAYS - 8));
        assert!(last <= today + Duration::days(RECURRENCE_FUTURE_DAYS));
    }

    #[test]
    fn an_invitation_lists_the_organizer_and_the_guests() {
        let mut event = draft("Revue de design", "2024-03-15");
        event.start = Some("14:00".to_string());
        event.end = Some("15:00".to_string());
        event.organizer = Some("roman@lavande.mail".to_string());
        event.attendees = Some(vec![
            "camille@studio-lilas.fr".to_string(),
            "marc@mail.fr".to_string(),
        ]);
        let (ics, reread) = written(event);
        // Une ligne longue est repliée : la valeur se lit dépliée.
        let flat = ics.replace("\r\n ", "");
        assert!(
            flat.contains("ORGANIZER:mailto:roman@lavande.mail\r\n"),
            "{ics}"
        );
        for guest in ["camille@studio-lilas.fr", "marc@mail.fr"] {
            assert!(
                flat.contains(&format!(
                    "ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:{guest}"
                )),
                "{guest} absent de {ics}"
            );
        }
        // Ce que le serveur CalDAV relaie à l'organisateur : les invités se relisent.
        assert_eq!(reread.organizer.as_deref(), Some("roman@lavande.mail"));
        assert_eq!(
            reread.attendees,
            Some(vec![
                "camille@studio-lilas.fr".to_string(),
                "marc@mail.fr".to_string()
            ])
        );
    }

    #[test]
    fn an_invitation_without_an_organizer_is_refused() {
        let mut event = draft("Revue", "2024-03-15");
        event.attendees = Some(vec!["camille@studio-lilas.fr".to_string()]);
        assert!(matches!(
            event_ics(&event),
            Err(MailError::Calendar(message)) if message.contains("organisateur")
        ));
    }

    #[test]
    fn the_occurrence_identifier_is_optional_on_the_wire() {
        let entry = ExternalEvent {
            uid: Some("serie".to_string()),
            title: "Point".to_string(),
            date: "2024-03-20".to_string(),
            recurring: true,
            ..ExternalEvent::default()
        };
        let json = serde_json::to_value(&entry).expect("json");
        assert!(json.get("recurrence_id").is_none(), "{json}");

        let mut occurrence = entry.clone();
        occurrence.recurrence_id = Some("20240320T080000Z".to_string());
        let json = serde_json::to_value(&occurrence).expect("json");
        assert_eq!(json["recurrence_id"], "20240320T080000Z");

        let without: ExternalEvent = serde_json::from_str(
            r#"{"uid":"serie","title":"Point","date":"2024-03-20","start":null,"end":null,
                "all_day":false,"timezone":null,"location":null,"description":null,
                "recurring":true,"source":null}"#,
        )
        .expect("json sans occurrence");
        assert_eq!(without.recurrence_id, None);
    }

    #[test]
    fn a_written_event_carries_no_recurrence_id() {
        let event = ExternalEvent {
            uid: Some("serie".to_string()),
            title: "Point".to_string(),
            date: "2024-03-20".to_string(),
            start: Some("09:00".to_string()),
            recurrence_id: Some("20240320T080000Z".to_string()),
            ..ExternalEvent::default()
        };
        let (ics, reread) = written(event);
        assert!(!ics.contains("RECURRENCE-ID"), "{ics}");
        assert_eq!(reread.recurrence_id, None);
        assert_eq!(reread.uid.as_deref(), Some("serie"));
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
