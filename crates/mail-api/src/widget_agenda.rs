//! Résumé agenda pour le widget Android d'écran d'accueil. Pur : ne lit aucun
//! store — les événements viennent du front (CalDAV / Google / ICS déjà relus)
//! ou du worker de fond. `summarize_agenda` calcule la journée, le prochain
//! rendez-vous et l'état « journée libre » (cas fréquent), testable hors Android.

use chrono::Utc;
use serde::{Deserialize, Serialize};

/// Sous-ensemble de `CalendarEvent` (front) utile au widget. `start` / `end` en
/// secondes UTC ; `tone` = index de couleur calendrier (0 = accent, comme TONE_DOT).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetEvent {
    pub id: String,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub calendar: String,
    pub tone: usize,
    pub location: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetAgendaSummary {
    /// Événements du jour courant, triés par heure de début.
    pub today: Vec<WidgetEvent>,
    /// Rendez-vous en cours ou à venir le plus proche (`end > now`).
    pub next: Option<WidgetEvent>,
    /// Aucun événement aujourd'hui : le widget affiche la date + le prochain.
    pub free_today: bool,
    pub updated_at: i64,
}

/// `now`, `day_start`, `day_end` en secondes UTC. `day_start` / `day_end` sont les
/// bornes du jour local courant, fournies par l'appelant qui connaît le fuseau.
pub fn summarize_agenda(
    events: &[WidgetEvent],
    now: i64,
    day_start: i64,
    day_end: i64,
) -> WidgetAgendaSummary {
    let mut today: Vec<WidgetEvent> = events
        .iter()
        .filter(|event| event.start >= day_start && event.start < day_end)
        .cloned()
        .collect();
    today.sort_by(|left, right| left.start.cmp(&right.start).then(left.id.cmp(&right.id)));

    let mut upcoming: Vec<&WidgetEvent> = events.iter().filter(|event| event.end > now).collect();
    upcoming.sort_by(|left, right| left.start.cmp(&right.start).then(left.id.cmp(&right.id)));
    let next = upcoming.first().map(|event| (*event).clone());

    WidgetAgendaSummary {
        free_today: today.is_empty(),
        today,
        next,
        updated_at: Utc::now().timestamp(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 1_731_000_000;
    const DAY_END: i64 = DAY + 86_400;
    const NOW: i64 = DAY + 52_320; // 14:32

    fn event(
        id: &str,
        title: &str,
        start: i64,
        end: i64,
        calendar: &str,
        tone: usize,
    ) -> WidgetEvent {
        WidgetEvent {
            id: id.to_string(),
            title: title.to_string(),
            start,
            end,
            calendar: calendar.to_string(),
            tone,
            location: None,
        }
    }

    fn today_events() -> Vec<WidgetEvent> {
        vec![
            event("e3", "Revue PR", DAY + 57_600, DAY + 61_200, "Pro", 0), // 16:00–17:00
            event(
                "e1",
                "Point maquettes",
                DAY + 36_000,
                DAY + 37_800,
                "Pro",
                0,
            ), // 10:00–10:30
            event("e2", "Déjeuner", DAY + 45_000, DAY + 50_400, "Perso", 2), // 12:30–14:00
        ]
    }

    #[test]
    fn today_is_sorted_and_next_is_the_soonest_upcoming() {
        let summary = summarize_agenda(&today_events(), NOW, DAY, DAY_END);
        let titles: Vec<&str> = summary.today.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["Point maquettes", "Déjeuner", "Revue PR"]);
        assert!(!summary.free_today);
        // 14:32 : le déjeuner (fini à 14:00) est passé, le prochain est la revue de 16:00.
        assert_eq!(summary.next.expect("prochain").id, "e3");
    }

    #[test]
    fn free_day_keeps_the_next_upcoming_event() {
        let tomorrow = event(
            "e4",
            "Daily équipe",
            DAY_END + 33_300,
            DAY_END + 35_100,
            "Pro",
            0,
        );
        let summary = summarize_agenda(std::slice::from_ref(&tomorrow), NOW, DAY, DAY_END);
        assert!(summary.free_today);
        assert!(summary.today.is_empty());
        assert_eq!(summary.next.expect("prochain lointain"), tomorrow);
    }

    #[test]
    fn ongoing_event_is_the_next_one() {
        let ongoing = event("e5", "Atelier", DAY + 50_400, DAY + 54_000, "Pro", 0); // 14:00–15:00
        let summary = summarize_agenda(std::slice::from_ref(&ongoing), NOW, DAY, DAY_END);
        assert!(!summary.free_today);
        assert_eq!(summary.next.expect("en cours"), ongoing);
    }

    #[test]
    fn empty_agenda_is_free_with_no_next() {
        let summary = summarize_agenda(&[], NOW, DAY, DAY_END);
        assert!(summary.free_today);
        assert!(summary.today.is_empty());
        assert!(summary.next.is_none());
    }

    #[test]
    fn json_shape_matches_the_widget_contract() {
        let summary = summarize_agenda(&today_events(), NOW, DAY, DAY_END);
        let value = serde_json::to_value(&summary).expect("json");
        assert_eq!(value["free_today"], false);
        assert_eq!(value["today"].as_array().expect("today").len(), 3);
        assert_eq!(value["next"]["id"], "e3");
        assert_eq!(value["next"]["tone"], 0);
        assert!(value["updated_at"].as_i64().expect("horodatage") > 0);
    }
}
