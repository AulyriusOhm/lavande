import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDARS,
  TONE_DOT,
  TONE_PILL,
  calendarsInUse,
  googleRefOf,
  isExternalCalendar,
  isGoogleCalendar,
  loadCalendars,
  saveCalendars,
  toneOfEvent,
  type CalendarDef,
} from "@/lib/calendars";
import type { CalendarEvent } from "@/lib/calendar";

const KEY = "lavande.calendars.v1";

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e0",
  date: "2026-11-12",
  start: "09:00",
  end: "10:00",
  title: "Rendez-vous",
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("calendars · tons", () => {
  it("expose un ton par index de palette", () => {
    expect(TONE_PILL).toHaveLength(5);
    expect(TONE_DOT).toHaveLength(5);
  });

  it("donne la priorité au ton libre de l'événement", () => {
    expect(toneOfEvent({ tone: 4, calendar: "Pro" }, DEFAULT_CALENDARS)).toBe(4);
  });

  it("retombe sur le ton du calendrier référencé", () => {
    expect(toneOfEvent({ calendar: "Perso" }, DEFAULT_CALENDARS)).toBe(2);
    expect(toneOfEvent({ calendar: "Clients" }, DEFAULT_CALENDARS)).toBe(3);
  });

  it("retombe sur le ton 0 sans calendrier connu", () => {
    expect(toneOfEvent({}, DEFAULT_CALENDARS)).toBe(0);
    expect(toneOfEvent({ calendar: "Inconnu" }, DEFAULT_CALENDARS)).toBe(0);
  });

  it("ramène un ton hors palette dans la palette", () => {
    expect(toneOfEvent({ tone: 7 }, DEFAULT_CALENDARS)).toBe(2);
  });
});

describe("calendars · persistance", () => {
  it("retombe sur les calendriers par défaut sans donnée", () => {
    expect(loadCalendars()).toEqual(DEFAULT_CALENDARS);
  });

  it("fait un aller-retour complet", () => {
    const saved: CalendarDef[] = [
      { id: "pro", name: "Pro", tone: 1 },
      { id: "famille", name: "Famille", tone: 4 },
    ];

    saveCalendars(saved);

    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(saved));
    expect(loadCalendars()).toEqual(saved);
  });

  it("ignore une valeur corrompue", () => {
    window.localStorage.setItem(KEY, "{pas du json");
    expect(loadCalendars()).toEqual(DEFAULT_CALENDARS);

    window.localStorage.setItem(KEY, JSON.stringify([{ id: 3 }]));
    expect(loadCalendars()).toEqual(DEFAULT_CALENDARS);
  });
});

describe("calendars · calendriers utilisés", () => {
  it("ajoute les calendriers référencés absents de la liste", () => {
    const list = calendarsInUse(
      [event({ calendar: "Pro" }), event({ id: "e1", calendar: "Clients" }), event({ id: "e2", calendar: "Famille" })],
      [DEFAULT_CALENDARS[0]],
    );

    expect(list.map((entry) => entry.name)).toEqual(["Pro", "Clients", "Famille"]);
    expect(list[2]).toEqual({ id: "famille", name: "Famille", tone: 0 });
  });

  it("reste stable et dédoublonne les noms", () => {
    const events = [event({ calendar: "Perso" }), event({ id: "e1", calendar: "Perso" })];

    expect(calendarsInUse(events, DEFAULT_CALENDARS)).toEqual(DEFAULT_CALENDARS);
    expect(calendarsInUse(events, DEFAULT_CALENDARS)).toEqual(calendarsInUse(events, DEFAULT_CALENDARS));
  });
});

describe("calendars · sources Google", () => {
  const agenda: CalendarDef = {
    id: "agenda",
    name: "Agenda",
    tone: 2,
    source: { kind: "google", accountId: "gmail", calendarId: "primary" },
  };

  it("expose le compte et le calendrier visés, sans jeton", () => {
    expect(isGoogleCalendar(agenda)).toBe(true);
    expect(googleRefOf(agenda)).toEqual({ accountId: "gmail", calendarId: "primary" });
    expect(isExternalCalendar(agenda)).toBe(true);
  });

  it("laisse les autres sources intactes", () => {
    expect(isGoogleCalendar(DEFAULT_CALENDARS[0])).toBe(false);
    expect(googleRefOf(DEFAULT_CALENDARS[0])).toBeUndefined();
    expect(isExternalCalendar(DEFAULT_CALENDARS[0])).toBe(false);
    expect(googleRefOf({ id: "t", name: "T", tone: 1, source: { kind: "ics", url: "https://x.tld/c.ics" } })).toBeUndefined();
  });

  it("fait un aller-retour sur une source Google", () => {
    const list: CalendarDef[] = [...DEFAULT_CALENDARS, agenda];

    saveCalendars(list);

    expect(loadCalendars()).toEqual(list);
  });

  it("retombe sur un calendrier local quand la source Google est incomplète", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "agenda", name: "Agenda", tone: 2, source: { kind: "google", accountId: "" } }]),
    );

    expect(loadCalendars()).toEqual([{ id: "agenda", name: "Agenda", tone: 2 }]);
  });
});
