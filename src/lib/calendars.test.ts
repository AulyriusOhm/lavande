import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  DEFAULT_CALENDARS,
  TONE_DOT,
  TONE_PILL,
  agendaCalendars,
  calendarAccountId,
  calendarActivated,
  calendarSourceKind,
  calendarsInUse,
  googleRefOf,
  isExternalCalendar,
  isGoogleCalendar,
  loadCalendars,
  saveCalendars,
  toneOfEvent,
  useCalendarDefinitions,
  useCalendars,
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

  it("n'invente aucun calendrier pour un événement sans calendrier", () => {
    expect(calendarsInUse([event(), event({ id: "e1", calendar: "" })], DEFAULT_CALENDARS)).toEqual(
      DEFAULT_CALENDARS,
    );
    expect(calendarsInUse([event(), event({ id: "e1", calendar: "" })], [])).toEqual([]);
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

const gmail: CalendarDef = {
  id: "gmail-prive",
  name: "Privé",
  tone: 1,
  source: { kind: "google", accountId: "gmail", calendarId: "primary" },
};

describe("calendars · périmètre du compte", () => {
  it("rattache un calendrier à un compte seulement pour Google", () => {
    expect(calendarAccountId(gmail)).toBe("gmail");
    expect(calendarAccountId(DEFAULT_CALENDARS[0])).toBeUndefined();
    expect(
      calendarAccountId({ id: "t", name: "T", tone: 0, source: { kind: "caldav", sourceId: "t" } }),
    ).toBeUndefined();
    expect(calendarAccountId({ id: "i", name: "I", tone: 0, source: { kind: "ics" } })).toBeUndefined();
  });

  it("nomme le type de chaque source", () => {
    expect(calendarSourceKind(DEFAULT_CALENDARS[0])).toBe("local");
    expect(calendarSourceKind({ id: "i", name: "I", tone: 0, source: { kind: "ics" } })).toBe("ICS");
    expect(calendarSourceKind({ id: "c", name: "C", tone: 0, source: { kind: "caldav", sourceId: "c" } })).toBe(
      "CalDAV",
    );
    expect(calendarSourceKind(gmail)).toBe("Google");
  });

  it("sort de l'agenda une source Google dont le compte a coupé l'agenda", () => {
    const list = [...DEFAULT_CALENDARS, gmail];
    const off = { gmail: { mails: true, calendar: false, contacts: false } };

    expect(calendarActivated(gmail, {})).toBe(true);
    expect(calendarActivated(gmail, off)).toBe(false);
    expect(calendarActivated(DEFAULT_CALENDARS[0], off)).toBe(true);
    expect(agendaCalendars(list, off)).toEqual([...DEFAULT_CALENDARS]);
    expect(agendaCalendars(list, {})).toEqual(list);
  });

  it("garde la source en pause hors de l'agenda mais pas hors du stockage", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ perimeters: { gmail: { calendar: false } } }));
    saveCalendars([...DEFAULT_CALENDARS, gmail]);

    const { result } = renderHook(() => ({
      agenda: useCalendars(),
      all: useCalendarDefinitions(),
    }));

    expect(result.current.agenda[0].map((entry) => entry.id)).toEqual(["pro", "perso", "clients"]);
    expect(result.current.all[0].map((entry) => entry.id)).toEqual(["pro", "perso", "clients", "gmail-prive"]);

    await act(async () => {
      result.current.agenda[1]([...result.current.agenda[0], { id: "famille", name: "Famille", tone: 2 }]);
    });

    expect(loadCalendars().map((entry) => entry.id)).toEqual([
      "pro",
      "perso",
      "clients",
      "gmail-prive",
      "famille",
    ]);
  });
});
