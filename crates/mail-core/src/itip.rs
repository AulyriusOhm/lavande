//! iTIP invitations (RFC 5546): the `text/calendar` part of a message, the
//! answer a reader gives it, and the reply that carries that answer.
//!
//! The part is read on request only: a message is never parsed for it during a
//! sync. [`parse`] projects the `VEVENT` onto [`Invitation`], [`set_partstat`]
//! rewrites one `ATTENDEE` line of the resource a CalDAV server holds, and
//! [`reply_ics`] builds the `METHOD:REPLY` sent when the account has no calendar
//! to write the answer into.

use icalendar::{Calendar, Component, Property};
use serde::{Deserialize, Serialize};

use crate::error::MailError;
use crate::ics::{
    address_of, attendee_property, calendar_of, repeated, vevent, written, ExternalEvent,
};
use crate::model::Address;

/// Answers a reader can give, as `PARTSTAT` writes them.
pub const PARTSTATS: [&str; 3] = ["ACCEPTED", "TENTATIVE", "DECLINED"];

/// Who convenes an event: the `ORGANIZER` of the part.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Party {
    pub name: Option<String>,
    pub email: String,
}

/// One guest of an event, with the answer it gave.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guest {
    pub email: String,
    pub name: Option<String>,
    /// `NEEDS-ACTION` when the part carries none.
    pub partstat: String,
    pub role: Option<String>,
}

/// One `text/calendar` part of a message, as the two readers show it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invitation {
    /// `METHOD` of the part, uppercased: `REQUEST` when the producer omitted it
    /// but named an organizer, `None` when the part is not an invitation.
    pub method: Option<String>,
    pub uid: Option<String>,
    pub summary: String,
    pub date: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub all_day: bool,
    pub timezone: Option<String>,
    pub organizer: Option<Party>,
    pub attendees: Vec<Guest>,
    /// `SEQUENCE` of the event: a reply carries it back.
    pub sequence: Option<i64>,
}

impl Invitation {
    /// `CANCEL`: the organizer dropped the event, the reader has nothing left to
    /// answer.
    pub fn cancelled(&self) -> bool {
        self.method.as_deref() == Some("CANCEL")
    }
}

/// Reads the `VEVENT` of a `text/calendar` part. `None` when the part carries
/// nothing to answer: no `METHOD`, no `ORGANIZER`, or no readable `DTSTART`.
pub fn parse(content: &str) -> Result<Option<Invitation>, MailError> {
    let calendar = calendar_of(content)?;
    let Some(event) = calendar.events().next() else {
        return Ok(None);
    };
    let method = calendar
        .property_value("METHOD")
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .map(str::to_ascii_uppercase);
    let organizer = party(event, "ORGANIZER");
    if method.is_none() && organizer.is_none() {
        return Ok(None);
    }
    let Some(at) = written(event) else {
        return Ok(None);
    };
    Ok(Some(Invitation {
        method: method.or_else(|| Some("REQUEST".to_string())),
        uid: event.get_uid().map(str::to_string),
        summary: at.title,
        date: at.date,
        start: at.start,
        end: at.end,
        all_day: at.all_day,
        timezone: at.timezone,
        organizer,
        attendees: guests(event),
        sequence: event
            .property_value("SEQUENCE")
            .and_then(|value| value.trim().parse().ok()),
    }))
}

/// Same invitation with the answer of one guest: the caller reflects its own
/// reply without re-reading the mail.
pub fn answered(invitation: &Invitation, email: &str, status: &str) -> Invitation {
    let status = status.trim().to_ascii_uppercase();
    let mut answered = invitation.clone();
    for guest in &mut answered.attendees {
        if guest.email.eq_ignore_ascii_case(email.trim()) {
            guest.partstat = status.clone();
        }
    }
    answered
}

/// Sets `PARTSTAT=<status>` on the `ATTENDEE` of `email` and hands back the whole
/// resource, folding rewritten. `None` when no `ATTENDEE` names that address.
///
/// Every other byte the server wrote — `RRULE`, `VALARM`, `X-` properties, the
/// other guests — is kept as is: rewriting through the agenda contract would drop
/// what the daemon does not model, and a CalDAV reply must carry the resource the
/// organizer's server expects.
pub fn set_partstat(content: &str, email: &str, status: &str) -> Result<Option<String>, MailError> {
    let status = status.trim().to_ascii_uppercase();
    if !PARTSTATS.contains(&status.as_str()) {
        return Err(MailError::Calendar(format!(
            "réponse « {status} » inconnue : ACCEPTED, TENTATIVE ou DECLINED"
        )));
    }
    let wanted = email.trim().to_ascii_lowercase();
    if wanted.is_empty() {
        return Err(MailError::Calendar(
            "réponse sans adresse : le compte n'a pas d'e-mail".to_string(),
        ));
    }
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut found = false;
    let mut out = String::with_capacity(content.len() + 64);
    for line in logical_lines(content) {
        if line.trim().is_empty() {
            continue;
        }
        let rewritten = match content_line(&line) {
            Some(parsed)
                if parsed.name.eq_ignore_ascii_case("ATTENDEE")
                    && address_matches(parsed.value, &wanted) =>
            {
                found = true;
                attendee_line(&parsed.params, parsed.value, &status)
            }
            _ => line,
        };
        for physical in folded(&rewritten) {
            out.push_str(&physical);
            out.push_str(eol);
        }
    }
    Ok(found.then_some(out))
}

/// `METHOD:REPLY` answering `invitation` with `status`, for an account whose
/// calendar is unknown to the daemon: the organizer gets the answer by mail.
pub fn reply_ics(
    invitation: &Invitation,
    attendee: &Address,
    status: &str,
) -> Result<String, MailError> {
    let status = status.trim().to_ascii_uppercase();
    if !PARTSTATS.contains(&status.as_str()) {
        return Err(MailError::Calendar(format!(
            "réponse « {status} » inconnue : ACCEPTED, TENTATIVE ou DECLINED"
        )));
    }
    let organizer = invitation
        .organizer
        .as_ref()
        .ok_or_else(|| MailError::Calendar("invitation sans organisateur".to_string()))?;
    let uid = invitation
        .uid
        .as_deref()
        .map(str::trim)
        .filter(|uid| !uid.is_empty())
        .ok_or_else(|| MailError::Calendar("invitation sans UID".to_string()))?;
    let draft = ExternalEvent {
        uid: Some(uid.to_string()),
        title: invitation.summary.clone(),
        date: invitation.date.clone(),
        start: invitation.start.clone(),
        end: invitation.end.clone(),
        ..ExternalEvent::default()
    };
    let mut event = vevent(&draft)?;
    event.append_property(Property::new(
        "ORGANIZER",
        format!("mailto:{}", organizer.email),
    ));
    let mut mine = attendee_property(&attendee.email, &status, false);
    if let Some(name) = attendee
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        mine.add_parameter("CN", name);
    }
    event.append_property(mine);
    if let Some(sequence) = invitation.sequence {
        event.append_property(Property::new("SEQUENCE", sequence.to_string()));
    }
    let mut calendar = Calendar::empty();
    calendar
        .append_property(Property::new("VERSION", "2.0"))
        .append_property(Property::new("PRODID", "-//Lavande//Agenda//FR"))
        .append_property(Property::new("METHOD", "REPLY"));
    calendar.push(event);
    Ok(calendar.to_string())
}

/// One party of an event: address and the `CN` that names it.
fn party(event: &icalendar::Event, key: &str) -> Option<Party> {
    let property = event.properties().get(key)?;
    Some(Party {
        email: address_of(property.value())?,
        name: parameter(property, "CN"),
    })
}

/// Guests of an event, in the order the part lists them.
fn guests(event: &icalendar::Event) -> Vec<Guest> {
    repeated(event, "ATTENDEE")
        .into_iter()
        .filter_map(|property| {
            Some(Guest {
                email: address_of(property.value())?,
                name: parameter(property, "CN"),
                partstat: parameter(property, "PARTSTAT")
                    .unwrap_or_else(|| "NEEDS-ACTION".to_string())
                    .to_ascii_uppercase(),
                role: parameter(property, "ROLE").map(|role| role.to_ascii_uppercase()),
            })
        })
        .collect()
}

/// Value of one parameter, unquoted, `None` when blank.
fn parameter(property: &Property, key: &str) -> Option<String> {
    let value = property.params().get(key)?.value().trim();
    let value = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(value)
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// One content line of a resource, unfolded (RFC 5545, 3.1).
struct ContentLine<'a> {
    name: &'a str,
    /// Parameters as written, quotes included.
    params: Vec<(&'a str, &'a str)>,
    value: &'a str,
}

/// Splits a content line at its first unquoted `:`; a quoted parameter value may
/// carry `:` or `;` of its own.
fn content_line(line: &str) -> Option<ContentLine<'_>> {
    let mut quoted = false;
    let mut separators = Vec::new();
    let mut colon = None;
    for (index, character) in line.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ';' if !quoted => separators.push(index),
            ':' if !quoted => {
                colon = Some(index);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let head = line.get(..colon)?;
    let mut bounds = separators;
    bounds.push(head.len());
    let name = head.get(..*bounds.first()?)?.trim();
    let mut params = Vec::new();
    for pair in bounds.windows(2) {
        let (key, value) = head.get(pair[0] + 1..pair[1])?.split_once('=')?;
        params.push((key.trim(), value.trim()));
    }
    Some(ContentLine {
        name,
        params,
        value: line.get(colon + 1..)?,
    })
}

/// The `ATTENDEE` line of the reader, its `PARTSTAT` replaced or added.
fn attendee_line(params: &[(&str, &str)], value: &str, status: &str) -> String {
    let mut line = String::from("ATTENDEE");
    let mut answered = false;
    for (key, parameter) in params {
        if key.eq_ignore_ascii_case("PARTSTAT") {
            line.push_str(&format!(";PARTSTAT={status}"));
            answered = true;
        } else {
            line.push_str(&format!(";{key}={parameter}"));
        }
    }
    if !answered {
        line.push_str(&format!(";PARTSTAT={status}"));
    }
    line.push(':');
    line.push_str(value);
    line
}

fn address_matches(value: &str, wanted: &str) -> bool {
    address_of(value).is_some_and(|address| address.eq_ignore_ascii_case(wanted))
}

/// Logical lines of a resource: a continuation starts with a space or a tab.
fn logical_lines(content: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in content.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        match raw.strip_prefix([' ', '\t']) {
            Some(rest) if !lines.is_empty() => {
                lines.last_mut().expect("une ligne en cours").push_str(rest)
            }
            _ => lines.push(raw.to_string()),
        }
    }
    lines
}

/// Physical lines of one content line, folded at 75 octets (RFC 5545, 3.1): the
/// first carries the property, the next ones a leading blank.
fn folded(line: &str) -> Vec<String> {
    let mut lines: Vec<String> = vec![String::new()];
    for character in line.chars() {
        let limit = if lines.len() == 1 { 75 } else { 74 };
        let current = lines.last_mut().expect("une ligne");
        if current.len() + character.len_utf8() > limit {
            lines.push(character.to_string());
        } else {
            current.push(character);
        }
    }
    lines
        .into_iter()
        .enumerate()
        .map(|(index, line)| match index {
            0 => line,
            _ => format!(" {line}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(method: &str, body: &str) -> String {
        format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Zimbra//FR\r\n\
             {method}BEGIN:VEVENT\r\n{body}END:VEVENT\r\nEND:VCALENDAR\r\n"
        )
    }

    const METHOD: &str = "METHOD:REQUEST\r\n";

    const REQUEST: &str = concat!(
        "UID:reunion-42@zimbra\r\n",
        "SUMMARY:Revue de design\r\n",
        "DTSTART;TZID=Europe/Paris:20261125T140000\r\n",
        "DTEND;TZID=Europe/Paris:20261125T150000\r\n",
        "SEQUENCE:2\r\n",
        "ORGANIZER;CN=Camille Roy:mailto:camille@studio-lilas.fr\r\n",
        "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;",
        "RSVP=TRUE;CN=Roman:mailto:roman@lavande.mail\r\n",
        "ATTENDEE;PARTSTAT=ACCEPTED;CN=Marc Delaunay:mailto:marc@mail.fr\r\n",
    );

    fn invitation() -> Invitation {
        parse(&wrap(METHOD, REQUEST))
            .expect("part lisible")
            .expect("invitation")
    }

    #[test]
    fn a_request_is_read_with_its_parties() {
        let invitation = invitation();
        assert_eq!(invitation.method.as_deref(), Some("REQUEST"));
        assert_eq!(invitation.uid.as_deref(), Some("reunion-42@zimbra"));
        assert_eq!(invitation.summary, "Revue de design");
        assert_eq!(invitation.date, "2026-11-25");
        assert_eq!(invitation.start.as_deref(), Some("14:00"));
        assert_eq!(invitation.end.as_deref(), Some("15:00"));
        assert!(!invitation.all_day);
        assert_eq!(invitation.timezone.as_deref(), Some("Europe/Paris"));
        assert_eq!(
            invitation.organizer,
            Some(Party {
                name: Some("Camille Roy".to_string()),
                email: "camille@studio-lilas.fr".to_string(),
            })
        );
        assert_eq!(
            invitation.attendees,
            vec![
                Guest {
                    email: "roman@lavande.mail".to_string(),
                    name: Some("Roman".to_string()),
                    partstat: "NEEDS-ACTION".to_string(),
                    role: Some("REQ-PARTICIPANT".to_string()),
                },
                Guest {
                    email: "marc@mail.fr".to_string(),
                    name: Some("Marc Delaunay".to_string()),
                    partstat: "ACCEPTED".to_string(),
                    role: None,
                },
            ]
        );
        assert_eq!(invitation.sequence, Some(2));
        assert!(!invitation.cancelled());
    }

    #[test]
    fn a_method_less_part_with_an_organizer_is_a_request() {
        let invitation = parse(&wrap(
            "",
            "UID:sans-methode\r\nSUMMARY:Déjeuner\r\nDTSTART:20261125T120000Z\r\n\
             ORGANIZER:mailto:camille@studio-lilas.fr\r\n\
             ATTENDEE:mailto:roman@lavande.mail\r\n",
        ))
        .expect("part lisible")
        .expect("invitation");
        assert_eq!(invitation.method.as_deref(), Some("REQUEST"));
        assert_eq!(
            invitation.organizer.expect("organisateur").email,
            "camille@studio-lilas.fr"
        );
        assert_eq!(invitation.attendees.len(), 1);
        assert_eq!(invitation.attendees[0].partstat, "NEEDS-ACTION");
    }

    #[test]
    fn a_part_without_method_or_organizer_is_not_an_invitation() {
        let content = wrap(
            "",
            "UID:note\r\nSUMMARY:Note\r\nDTSTART:20261125T120000Z\r\n",
        );
        assert_eq!(parse(&content).expect("part lisible"), None);
    }

    #[test]
    fn an_all_day_invitation_has_no_clock() {
        let invitation = parse(&wrap(
            "METHOD:REQUEST\r\n",
            "UID:journee\r\nSUMMARY:Journée off\r\nDTSTART;VALUE=DATE:20261125\r\n\
             ORGANIZER:mailto:camille@studio-lilas.fr\r\n",
        ))
        .expect("part lisible")
        .expect("invitation");
        assert!(invitation.all_day);
        assert_eq!(invitation.date, "2026-11-25");
        assert_eq!(invitation.start, None);
        assert_eq!(invitation.timezone, None);
    }

    #[test]
    fn a_cancel_is_flagged_as_such() {
        let invitation = parse(&wrap(
            "METHOD:CANCEL\r\n",
            "UID:reunion-42@zimbra\r\nSUMMARY:Revue de design\r\n\
             DTSTART:20261125T130000Z\r\nORGANIZER:mailto:camille@studio-lilas.fr\r\n",
        ))
        .expect("part lisible")
        .expect("invitation");
        assert_eq!(invitation.method.as_deref(), Some("CANCEL"));
        assert!(invitation.cancelled());
    }

    #[test]
    fn an_invitation_without_a_readable_start_is_ignored() {
        let content = wrap(
            "METHOD:REQUEST\r\n",
            "UID:casse\r\nSUMMARY:Revue\r\nORGANIZER:mailto:camille@studio-lilas.fr\r\n",
        );
        assert_eq!(parse(&content).expect("part lisible"), None);
    }

    #[test]
    fn an_empty_part_is_refused() {
        assert!(matches!(parse(""), Err(MailError::Calendar(_))));
    }

    #[test]
    fn the_answer_of_one_guest_is_written_on_its_line() {
        let content = wrap(METHOD, REQUEST);
        let answered = set_partstat(&content, "roman@lavande.mail", "ACCEPTED")
            .expect("ressource réécrite")
            .expect("invité trouvé");
        let lines = logical_lines(&answered);
        // L'invité du lecteur répond ; l'autre garde son avis, à la lettre près.
        assert!(
            lines.contains(
                &"ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Roman:mailto:roman@lavande.mail".to_string()
            ),
            "{answered}"
        );
        assert!(
            lines.contains(
                &"ATTENDEE;PARTSTAT=ACCEPTED;CN=Marc Delaunay:mailto:marc@mail.fr".to_string()
            ),
            "{answered}"
        );
        // Le reste de la ressource est conservé au caractère près.
        for kept in [
            "METHOD:REQUEST",
            "UID:reunion-42@zimbra",
            "ORGANIZER;CN=Camille Roy:mailto:camille@studio-lilas.fr",
            "SEQUENCE:2",
            "SUMMARY:Revue de design",
            "DTSTART;TZID=Europe/Paris:20261125T140000",
        ] {
            assert!(
                lines.contains(&kept.to_string()),
                "{kept} absent de {answered}"
            );
        }
    }

    #[test]
    fn the_address_is_matched_without_case_or_scheme() {
        let content = wrap(METHOD, REQUEST);
        assert!(set_partstat(&content, "ROMAN@Lavande.Mail", "TENTATIVE")
            .expect("ressource")
            .is_some());
        assert!(set_partstat(&content, "roman@lavande.mail", "declined")
            .expect("ressource")
            .expect("invité")
            .contains("PARTSTAT=DECLINED"));
    }

    #[test]
    fn a_guest_without_an_answer_gets_one() {
        let content = wrap(
            "",
            "UID:u\r\nSUMMARY:Réunion\r\nDTSTART:20261125T120000Z\r\n\
             ORGANIZER:mailto:camille@studio-lilas.fr\r\n\
             ATTENDEE;CN=Roman:mailto:roman@lavande.mail\r\n",
        );
        let answered = set_partstat(&content, "roman@lavande.mail", "ACCEPTED")
            .expect("ressource")
            .expect("invité");
        assert!(
            answered.contains("ATTENDEE;CN=Roman;PARTSTAT=ACCEPTED:mailto:roman@lavande.mail"),
            "{answered}"
        );
    }

    #[test]
    fn a_folded_attendee_is_read_and_rewritten() {
        let content = wrap(
            METHOD,
            concat!(
                "UID:u\r\n",
                "SUMMARY:Réunion\r\n",
                "DTSTART:20261125T120000Z\r\n",
                "ORGANIZER:mailto:camille@studio-lilas.fr\r\n",
                "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Un nom bien \r\n",
                " trop long pour la ligne:mailto:roman@lavande.mail\r\n",
            ),
        );
        let answered = set_partstat(&content, "roman@lavande.mail", "ACCEPTED")
            .expect("ressource")
            .expect("invité");
        assert!(answered.lines().all(|line| line.len() <= 75), "{answered}");
        // Le nom replié redevient une seule valeur, ses espaces intacts.
        assert!(
            logical_lines(&answered).contains(
                &"ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Un nom bien trop long pour la ligne:mailto:roman@lavande.mail".to_string()
            ),
            "{answered}"
        );
    }

    #[test]
    fn an_unknown_guest_is_not_answered() {
        let content = wrap(METHOD, REQUEST);
        assert_eq!(
            set_partstat(&content, "inconnu@ailleurs.fr", "ACCEPTED").expect("ressource"),
            None
        );
    }

    #[test]
    fn an_unknown_answer_is_refused() {
        let content = wrap(METHOD, REQUEST);
        assert!(matches!(
            set_partstat(&content, "roman@lavande.mail", "PEUT-ETRE"),
            Err(MailError::Calendar(message)) if message.contains("inconnue")
        ));
    }

    #[test]
    fn a_reply_names_the_organizer_and_the_answer() {
        let invitation = invitation();
        let me = Address {
            name: Some("Roman".to_string()),
            email: "roman@lavande.mail".to_string(),
        };
        let ics = reply_ics(&invitation, &me, "ACCEPTED").expect("réponse écrite");
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\n"), "{ics}");
        assert!(ics.contains("METHOD:REPLY\r\n"), "{ics}");
        assert!(ics.contains("UID:reunion-42@zimbra\r\n"), "{ics}");
        assert!(
            ics.contains("ORGANIZER:mailto:camille@studio-lilas.fr\r\n"),
            "{ics}"
        );
        for part in [
            "ATTENDEE;",
            "CN=Roman",
            "CUTYPE=INDIVIDUAL",
            "ROLE=REQ-PARTICIPANT",
            "PARTSTAT=ACCEPTED",
            "RSVP=FALSE",
            ":mailto:roman@lavande.mail",
        ] {
            assert!(ics.contains(part), "{part} absent de {ics}");
        }
        assert!(ics.contains("SEQUENCE:2\r\n"), "{ics}");
        assert!(ics.contains("DTSTART:20261125T140000\r\n"), "{ics}");
        assert!(ics.contains("SUMMARY:Revue de design\r\n"), "{ics}");
        assert!(ics.contains("\r\nDTSTAMP:"), "{ics}");
    }

    #[test]
    fn a_reply_without_an_organizer_is_refused() {
        let mut invitation = invitation();
        invitation.organizer = None;
        let me = Address {
            name: None,
            email: "roman@lavande.mail".to_string(),
        };
        assert!(matches!(
            reply_ics(&invitation, &me, "ACCEPTED"),
            Err(MailError::Calendar(message)) if message.contains("organisateur")
        ));
    }

    #[test]
    fn the_answer_shows_in_the_contract() {
        let invitation = invitation();
        let answered = answered(&invitation, "roman@lavande.mail", "TENTATIVE");
        assert_eq!(answered.attendees[0].partstat, "TENTATIVE");
        assert_eq!(answered.attendees[1].partstat, "ACCEPTED");
        // L'original n'est pas touché.
        assert_eq!(invitation.attendees[0].partstat, "NEEDS-ACTION");
    }
}
