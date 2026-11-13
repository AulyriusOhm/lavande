import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalEvent } from "@/lib/api";
import { DEFAULT_CALENDARS, icsUrlOf, isIcsCalendar, loadCalendars, saveCalendars, type CalendarDef } from "@/lib/calendars";
import { GOOGLE_REFRESH_MS } from "@/lib/gcal";
import {
  EMPTY_ICS_STATE,
  ICS_MAX_EVENTS,
  ICS_REFRESH_MS,
  ICS_STORAGE_KEY,
  calendarUrlError,
  dropIcsCalendar,
  dueExternalSubscriptions,
  externalCalendarEvents,
  externalEventKind,
  fetchIcsCalendar,
  icsEventId,
  icsNameFromFile,
  icsNameFromUrl,
  importIcsContent,
  loadIcsState,
  markIcsSynced,
  parseIcsState,
  saveIcsState,
  setIcsCalendarEvents,
  toCalendarEvents,
} from "@/lib/ics";

const external = (over: Partial<ExternalEvent> = {}): ExternalEvent => ({
  uid: "abc-123",
  title: "Réunion équipe",
  date: "2026-03-15",
  start: "09:00",
  end: "10:00",
  all_day: false,
  timezone: "UTC",
  location: "Bureau",
  description: "Point hebdo",
  recurring: false,
  source: "Google",
  ...over,
});

const google: CalendarDef = { id: "google", name: "Google", tone: 1, source: { kind: "ics", url: "https://exemple.tld/c.ics" } };
const file: CalendarDef = { id: "vacances", name: "Vacances", tone: 2, source: { kind: "ics" } };

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

beforeEach(() => {
  window.localStorage.clear();
});

describe("ics · mapping ExternalEvent → CalendarEvent", () => {
  it("préfixe l'identifiant par la source pour éviter les collisions", () => {
    const [event] = toCalendarEvents([external()], google);

    expect(event).toEqual({
      id: "ics:google:abc-123",
      date: "2026-03-15",
      start: "09:00",
      end: "10:00",
      title: "Réunion équipe",
      location: "Bureau",
      description: "Point hebdo",
      calendar: "Google",
      external: true,
    });
  });

  it("retombe sur l'index quand le VEVENT n'a pas d'UID", () => {
    expect(icsEventId("google", external({ uid: null }), 3)).toBe("ics:google:#3");
  });

  it("laisse les heures vides pour une journée entière", () => {
    const [event] = toCalendarEvents([external({ start: null, end: null, all_day: true })], file);

    expect(event.start).toBe("");
    expect(event.end).toBe("");
    expect(event.location).toBe("Bureau");
  });

  it("signale une récurrence sans la développer", () => {
    const events = toCalendarEvents([external({ recurring: true }), external({ uid: "x" })], google);

    expect(events).toHaveLength(2);
    expect(events[0].recurring).toBe(true);
    expect(events[1].recurring).toBeUndefined();
  });

  it("n'invente ni lieu ni description absents", () => {
    const [event] = toCalendarEvents([external({ location: null, description: null })], google);

    expect("location" in event).toBe(false);
    expect("description" in event).toBe(false);
  });

  it("préfixe deux sources différentes sans collision d'UID", () => {
    const a = toCalendarEvents([external()], google);
    const b = toCalendarEvents([external()], file);

    expect(a[0].id).not.toBe(b[0].id);
  });
});

describe("ics · appels au démon", () => {
  it("importe une URL avec le nom de la source", async () => {
    const fetchMock = vi.fn(async () => response([external()]));
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchIcsCalendar(google);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/ics");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ url: "https://exemple.tld/c.ics", source: "Google" }));
    expect(events.map((entry) => entry.id)).toEqual(["ics:google:abc-123"]);
  });

  it("importe un contenu de fichier", async () => {
    const fetchMock = vi.fn(async () => response([external({ uid: "f1", start: null, end: null })]));
    vi.stubGlobal("fetch", fetchMock);

    const events = await importIcsContent(file, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(
      JSON.stringify({ content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", source: "Vacances" }),
    );
    expect(events[0].calendar).toBe("Vacances");
  });

  it("refuse un calendrier sans URL", async () => {
    await expect(fetchIcsCalendar(file)).rejects.toThrow("abonnement ICS sans URL");
  });

  it("remonte l'erreur du démon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "calendrier vide", kind: "calendar" }, 400)),
    );

    await expect(importIcsContent(file, " ")).rejects.toThrow("calendrier vide");
  });
});

describe("ics · stockage local", () => {
  it("part d'un état vide", () => {
    expect(loadIcsState()).toEqual(EMPTY_ICS_STATE);
  });

  it("fait un aller-retour complet", () => {
    const events = toCalendarEvents([external()], google);
    const state = setIcsCalendarEvents(EMPTY_ICS_STATE, "google", events, 1_700_000_000_000);

    saveIcsState(state);

    expect(window.localStorage.getItem(ICS_STORAGE_KEY)).toBe(JSON.stringify(state));
    expect(loadIcsState()).toEqual(state);
  });

  it("ignore une valeur corrompue", () => {
    window.localStorage.setItem(ICS_STORAGE_KEY, "{pas du json");
    expect(loadIcsState()).toEqual(EMPTY_ICS_STATE);

    window.localStorage.setItem(ICS_STORAGE_KEY, JSON.stringify({ events: "nope", synced: 3 }));
    expect(loadIcsState()).toEqual(EMPTY_ICS_STATE);
  });

  it("jette les entrées invalides", () => {
    const parsed = parseIcsState({
      events: { google: [{ id: "a", date: "2026-03-15", title: "ok" }, { id: 2 }, null] },
      synced: { google: 12, autre: "hier" },
    });

    expect(parsed.events.google).toHaveLength(1);
    expect(parsed.synced).toEqual({ google: 12 });
  });

  it("borne le nombre d'événements gardés par calendrier", () => {
    const many = toCalendarEvents(
      Array.from({ length: ICS_MAX_EVENTS + 5 }, (_, index) => external({ uid: `u${index}` })),
      google,
    );

    const state = setIcsCalendarEvents(EMPTY_ICS_STATE, "google", many);

    expect(state.events.google).toHaveLength(ICS_MAX_EVENTS);
    expect(state.synced.google).toBeGreaterThan(0);
  });

  it("oublie une source supprimée", () => {
    const state = setIcsCalendarEvents(
      setIcsCalendarEvents(EMPTY_ICS_STATE, "google", toCalendarEvents([external()], google)),
      "vacances",
      toCalendarEvents([external({ uid: "v1" })], file),
    );

    const pruned = dropIcsCalendar(state, "google");

    expect(Object.keys(pruned.events)).toEqual(["vacances"]);
    expect(Object.keys(pruned.synced)).toEqual(["vacances"]);
  });

  it("marque une tentative ratée sans toucher aux événements en cache", () => {
    const state = setIcsCalendarEvents(EMPTY_ICS_STATE, "google", toCalendarEvents([external()], google), 10);
    const retried = markIcsSynced(state, "google", 99);

    expect(retried.synced.google).toBe(99);
    expect(retried.events).toEqual(state.events);
  });
});

describe("ics · fusion dans l'agenda", () => {
  it("n'expose que les calendriers ICS existants", () => {
    const state = setIcsCalendarEvents(EMPTY_ICS_STATE, "google", toCalendarEvents([external()], google));
    const calendars: CalendarDef[] = [...DEFAULT_CALENDARS, google];

    expect(externalCalendarEvents(state, calendars).map((event) => event.calendar)).toEqual(["Google"]);
    expect(externalCalendarEvents(state, DEFAULT_CALENDARS)).toEqual([]);
  });

  it("suit le renommage du calendrier", () => {
    const state = setIcsCalendarEvents(EMPTY_ICS_STATE, "google", toCalendarEvents([external()], google));
    const renamed: CalendarDef = { ...google, name: "Travail" };

    expect(externalCalendarEvents(state, [renamed])[0].calendar).toBe("Travail");
  });

  it("retire les événements d'une source supprimée", () => {
    const state = setIcsCalendarEvents(EMPTY_ICS_STATE, "google", toCalendarEvents([external()], google));

    expect(externalCalendarEvents(state, [google])).toHaveLength(1);
    expect(externalCalendarEvents(dropIcsCalendar(state, "google"), [google])).toEqual([]);
  });
});

describe("ics · abonnements à rafraîchir", () => {
  it("relit un abonnement jamais synchronisé", () => {
    expect(dueExternalSubscriptions([google, file], {})).toEqual([google]);
  });

  it("laisse tranquille un cache encore frais", () => {
    const now = 1_700_000_000_000;

    expect(dueExternalSubscriptions([google], { google: now - 1000 }, now)).toEqual([]);
  });

  it("relit un cache expiré", () => {
    const now = 1_700_000_000_000;

    expect(dueExternalSubscriptions([google], { google: now - ICS_REFRESH_MS }, now)).toEqual([google]);
  });

  it("ignore les calendriers locaux et les fichiers importés", () => {
    expect(dueExternalSubscriptions([...DEFAULT_CALENDARS, file], {})).toEqual([]);
  });
});

describe("ics · sources de calendrier", () => {
  it("traite un calendrier sans source comme local", () => {
    expect(isIcsCalendar(DEFAULT_CALENDARS[0])).toBe(false);
    expect(icsUrlOf(DEFAULT_CALENDARS[0])).toBeUndefined();
  });

  it("distingue abonnement et fichier", () => {
    expect(isIcsCalendar(google)).toBe(true);
    expect(icsUrlOf(google)).toBe("https://exemple.tld/c.ics");
    expect(icsUrlOf(file)).toBeUndefined();
  });

  it("relit les anciens calendriers locaux sans source", () => {
    window.localStorage.setItem(
      "lavande.calendars.v1",
      JSON.stringify([{ id: "pro", name: "Pro", tone: 0 }]),
    );

    expect(loadCalendars()).toEqual([{ id: "pro", name: "Pro", tone: 0 }]);
  });

  it("fait un aller-retour sur une source ICS", () => {
    const list: CalendarDef[] = [...DEFAULT_CALENDARS, google, file];

    saveCalendars(list);

    expect(loadCalendars()).toEqual(list);
  });

  it("ignore une source inconnue sans perdre le calendrier", () => {
    window.localStorage.setItem(
      "lavande.calendars.v1",
      JSON.stringify([{ id: "pro", name: "Pro", tone: 0, source: { kind: "exchange" } }]),
    );

    expect(loadCalendars()).toEqual([{ id: "pro", name: "Pro", tone: 0 }]);
  });
});

describe("ics · validation des entrées", () => {
  it("accepte http et https", () => {
    expect(calendarUrlError("https://exemple.tld/c.ics")).toBeNull();
    expect(calendarUrlError("http://exemple.tld/c.ics")).toBeNull();
  });

  it("refuse une URL vide, relative ou hors http", () => {
    expect(calendarUrlError("  ")).toBe("URL du calendrier requise");
    expect(calendarUrlError("pas une url")).toBe("URL invalide");
    expect(calendarUrlError("file:///etc/passwd")).toBe("L'URL doit commencer par http:// ou https://");
  });

  it("déduit un nom de l'URL ou du fichier", () => {
    expect(icsNameFromUrl("https://www.exemple.tld/cal.ics")).toBe("exemple.tld");
    expect(icsNameFromUrl("pas une url")).toBe("Calendrier ICS");
    expect(icsNameFromFile("vacances.ics")).toBe("vacances");
    expect(icsNameFromFile(".ics")).toBe("Calendrier ICS");
  });
});

describe("ics · sources Google", () => {
  const agenda: CalendarDef = {
    id: "agenda",
    name: "Agenda",
    tone: 2,
    source: { kind: "google", accountId: "gmail", calendarId: "primary" },
  };

  it("préfixe les identifiants par google et ne les confond pas avec les autres familles", () => {
    expect(toCalendarEvents([external()], agenda, "google")[0].id).toBe("google:agenda:abc-123");
    expect(externalEventKind({ id: "google:agenda:abc" })).toBe("google");
    expect(externalEventKind({ id: "caldav:agenda:abc" })).toBe("caldav");
    expect(externalEventKind({ id: "ics:agenda:abc" })).toBe("ics");
  });

  it("relit un agenda Google à l'âge d'un calendrier distant", () => {
    const now = 1_700_000_000_000;

    expect(dueExternalSubscriptions([agenda], {}, now)).toEqual([agenda]);
    expect(dueExternalSubscriptions([agenda], { agenda: now - GOOGLE_REFRESH_MS + 1000 }, now)).toEqual([]);
    expect(dueExternalSubscriptions([agenda], { agenda: now - GOOGLE_REFRESH_MS }, now)).toEqual([agenda]);
  });

  it("garde les événements Google dans les sources externes", () => {
    const state = setIcsCalendarEvents(EMPTY_ICS_STATE, "agenda", toCalendarEvents([external()], agenda, "google"));

    expect(externalCalendarEvents(state, [agenda])).toHaveLength(1);
    expect(externalCalendarEvents(state, [...DEFAULT_CALENDARS, agenda]).map((event) => event.calendar)).toEqual([
      "Agenda",
    ]);
  });
});

describe("ics · périmètre de l'agenda par compte", () => {
  const google: CalendarDef = {
    id: "gmail-prive",
    name: "Privé",
    tone: 1,
    source: { kind: "google", accountId: "gmail", calendarId: "primary" },
  };

  const state = setIcsCalendarEvents(
    EMPTY_ICS_STATE,
    "gmail-prive",
    toCalendarEvents([external({ uid: "g1" })], google, "google"),
  );

  it("n'affiche pas les événements d'un agenda Google coupé", () => {
    expect(externalCalendarEvents(state, [google]).map((event) => event.id)).toEqual(["google:gmail-prive:g1"]);

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ perimeters: { gmail: { calendar: false } } }));

    expect(externalCalendarEvents(state, [google])).toEqual([]);
    expect(externalCalendarEvents(state, DEFAULT_CALENDARS)).toEqual([]);
  });

  it("cesse de relire une source Google dont l'agenda est coupé", () => {
    const now = 1_700_000_000_000;
    expect(dueExternalSubscriptions([google], {}, now)).toEqual([google]);

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ perimeters: { gmail: { calendar: false } } }));

    expect(dueExternalSubscriptions([google], {}, now)).toEqual([]);
  });
});
