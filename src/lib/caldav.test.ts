import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, mailApi, type CaldavSource, type ExternalEvent } from "@/lib/api";
import {
  CALDAV_CONFLICT_MESSAGE,
  CALDAV_REFRESH_MS,
  EMPTY_ICS_STATE,
  ICS_REFRESH_MS,
  caldavWriteFailure,
  createCaldavEvent,
  deleteCaldavEvent,
  dropIcsCalendar,
  dueExternalSubscriptions,
  externalCalendarEvents,
  externalEventId,
  externalEventKind,
  fetchCaldavCalendar,
  fetchExternalCalendar,
  isCaldavConflict,
  loadIcsState,
  saveIcsState,
  setIcsCalendarEvents,
  toCalendarEvents,
  updateCaldavEvent,
} from "@/lib/ics";
import {
  DEFAULT_CALENDARS,
  caldavSourceIdOf,
  isCaldavCalendar,
  isExternalCalendar,
  loadCalendars,
  saveCalendars,
  type CalendarDef,
} from "@/lib/calendars";

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
  source: "Travail",
  ...over,
});

const travail: CalendarDef = { id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } };
const google: CalendarDef = {
  id: "google",
  name: "Google",
  tone: 2,
  source: { kind: "ics", url: "https://exemple.tld/c.ics" },
};
const file: CalendarDef = { id: "vacances", name: "Vacances", tone: 3, source: { kind: "ics" } };

const source: CaldavSource = { id: "travail", name: "Travail", url: "https://caldav.exemple.tld/" };

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const fetchMock = (payload: unknown = [external()], status = 200) => {
  const mock = vi.fn(async () => response(payload, status));
  vi.stubGlobal("fetch", mock);
  return mock;
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("caldav · modèle de calendrier", () => {
  it("reconnaît une source CalDAV et garde l'identifiant du démon", () => {
    expect(isCaldavCalendar(travail)).toBe(true);
    expect(caldavSourceIdOf(travail)).toBe("travail");
    expect(isExternalCalendar(travail)).toBe(true);
  });

  it("laisse les calendriers locaux et ICS inchangés", () => {
    expect(isCaldavCalendar(DEFAULT_CALENDARS[0])).toBe(false);
    expect(caldavSourceIdOf(DEFAULT_CALENDARS[0])).toBeUndefined();
    expect(isExternalCalendar(DEFAULT_CALENDARS[0])).toBe(false);
    expect(isCaldavCalendar(google)).toBe(false);
    expect(isExternalCalendar(google)).toBe(true);
    expect(isExternalCalendar(file)).toBe(true);
  });

  it("fait un aller-retour sur une source CalDAV sans rien d'autre que son id", () => {
    const list: CalendarDef[] = [...DEFAULT_CALENDARS, travail, google, file];

    saveCalendars(list);

    expect(loadCalendars()).toEqual(list);
    expect(JSON.parse(window.localStorage.getItem("lavande.calendars.v1") ?? "[]")[3].source).toEqual({
      kind: "caldav",
      sourceId: "travail",
    });
  });

  it("retombe sur un calendrier local quand l'identifiant de source manque", () => {
    window.localStorage.setItem(
      "lavande.calendars.v1",
      JSON.stringify([{ id: "travail", name: "Travail", tone: 1, source: { kind: "caldav" } }]),
    );

    expect(loadCalendars()).toEqual([{ id: "travail", name: "Travail", tone: 1 }]);
  });
});

describe("caldav · mapping ExternalEvent → CalendarEvent", () => {
  it("préfixe les identifiants par caldav pour ne pas heurter l'ICS", () => {
    expect(externalEventId("caldav", "travail", external(), 0)).toBe("caldav:travail:abc-123");

    const [event] = toCalendarEvents([external()], travail, "caldav");

    expect(event).toEqual({
      id: "caldav:travail:abc-123",
      date: "2026-03-15",
      start: "09:00",
      end: "10:00",
      title: "Réunion équipe",
      location: "Bureau",
      description: "Point hebdo",
      calendar: "Travail",
      external: true,
      caldav: { sourceId: "travail", uid: "abc-123" },
    });
  });

  it("garde uid, etag et source pour réécrire l'événement chez le démon", () => {
    const [written] = toCalendarEvents([{ ...external(), etag: '"v1"' }], travail, "caldav");

    expect(written?.caldav).toEqual({ sourceId: "travail", uid: "abc-123", etag: '"v1"' });
  });

  it("laisse ICS et Google sans identifiant d'écriture", () => {
    expect(toCalendarEvents([external()], google)[0]?.caldav).toBeUndefined();
    expect(toCalendarEvents([external()], google, "google")[0]?.caldav).toBeUndefined();
  });

  it("reste en lecture seule quand le démon ne donne pas d'uid", () => {
    const [event] = toCalendarEvents([external({ uid: null })], travail, "caldav");

    expect(event?.caldav).toBeUndefined();
  });


  it("distingue les deux familles par l'identifiant", () => {
    expect(externalEventKind({ id: "caldav:travail:abc" })).toBe("caldav");
    expect(externalEventKind({ id: "ics:google:abc" })).toBe("ics");
  });

  it("fusionne les événements CalDAV et ICS sous le nom courant du calendrier", () => {
    const state = setIcsCalendarEvents(
      setIcsCalendarEvents(
        EMPTY_ICS_STATE,
        "travail",
        toCalendarEvents([external()], travail, "caldav"),
      ),
      "google",
      toCalendarEvents([external({ uid: "g1", title: "Réunion Google" })], google),
    );

    const events = externalCalendarEvents(state, [
      { ...travail, name: "Boulot" },
      google,
      DEFAULT_CALENDARS[0],
    ]);

    expect(events.map((event) => event.calendar)).toEqual(["Boulot", "Google"]);
    expect(events.map((event) => event.id)).toEqual(["caldav:travail:abc-123", "ics:google:g1"]);
  });
});

describe("caldav · lecture des sources", () => {
  it("lit les événements d'une source par son identifiant, sans identifiants de connexion", async () => {
    const mock = fetchMock();

    const events = await fetchCaldavCalendar(travail);

    expect(events[0].id).toBe("caldav:travail:abc-123");
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources/travail/events");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("refuse une source CalDAV sans identifiant", async () => {
    await expect(fetchCaldavCalendar({ id: "x", name: "X", tone: 0, source: { kind: "caldav", sourceId: "" } })).rejects.toThrow(
      "source CalDAV sans identifiant",
    );
  });

  it("choisit la route selon la famille du calendrier", async () => {
    const mock = fetchMock();

    await fetchExternalCalendar(google);
    await fetchExternalCalendar(travail);

    const urls = mock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(["/api/calendars/ics", "/api/calendars/caldav/sources/travail/events"]);
  });

  it("remonte l'erreur du démon", async () => {
    fetchMock({ error: "identifiants refusés", kind: "caldav" }, 502);

    await expect(fetchCaldavCalendar(travail)).rejects.toThrow("identifiants refusés");
  });
});

describe("caldav · fraîcheur du cache", () => {
  it("relit une source CalDAV plus tôt qu'un abonnement ICS", () => {
    const now = 1_700_000_000_000;

    expect(dueExternalSubscriptions([travail], { travail: now - CALDAV_REFRESH_MS }, now)).toEqual([travail]);
    expect(dueExternalSubscriptions([travail], { travail: now - 1000 }, now)).toEqual([]);
    expect(dueExternalSubscriptions([travail], {}, now)).toEqual([travail]);
    expect(dueExternalSubscriptions([google], { google: now - CALDAV_REFRESH_MS }, now)).toEqual([]);
    expect(dueExternalSubscriptions([google], { google: now - ICS_REFRESH_MS }, now)).toEqual([google]);
  });

  it("ne relit jamais un calendrier local ni un fichier importé", () => {
    expect(dueExternalSubscriptions([...DEFAULT_CALENDARS, file], {}, 1_700_000_000_000)).toEqual([]);
  });

  it("oublie les événements cachés d'une source supprimée", () => {
    const state = setIcsCalendarEvents(
      EMPTY_ICS_STATE,
      "travail",
      toCalendarEvents([external()], travail, "caldav"),
    );

    const dropped = dropIcsCalendar(state, "travail");

    expect(dropped.events.travail).toBeUndefined();
    expect(dropped.synced.travail).toBeUndefined();
    expect(externalCalendarEvents(dropped, [travail])).toEqual([]);
  });
});

describe("caldav · routes du démon", () => {
  it("liste les sources sans aucun identifiant de connexion", async () => {
    const mock = fetchMock([source]);

    await expect(mailApi.caldavSources()).resolves.toEqual([source]);

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources");
    expect(init.method).toBe("GET");
  });

  it("crée une source avec les identifiants une seule fois, dans le corps", async () => {
    const mock = fetchMock(source, 201);

    await mailApi.addCaldavSource({
      url: "https://caldav.exemple.tld/",
      username: "romain",
      password: "secret",
      name: "Travail",
    });

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ url: "https://caldav.exemple.tld/", username: "romain", password: "secret", name: "Travail" }),
    );
  });

  it("supprime une source par son identifiant", async () => {
    const mock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}), text: async () => "" }) as unknown as Response);
    vi.stubGlobal("fetch", mock);

    await expect(mailApi.removeCaldavSource("travail")).resolves.toBeUndefined();

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources/travail");
    expect(init.method).toBe("DELETE");
  });

  it("échappe l'identifiant dans le chemin", async () => {
    const mock = fetchMock([]);

    await mailApi.caldavSourceEvents("tra/vail");

    expect(String(mock.mock.calls[0][0])).toBe("/api/calendars/caldav/sources/tra%2Fvail/events");
  });
});

describe("caldav · écriture des événements", () => {
  const written = { ...external({ title: "Réunion écrite" }), etag: '"v2"' };

  it("crée l'événement par la route dédiée et garde l'etag renvoyé", async () => {
    const mock = fetchMock(written, 201);

    const state = await createCaldavEvent(travail, {
      title: "Réunion écrite",
      date: "2026-03-15",
      start: "09:00",
      end: "10:00",
    });

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources/travail/events/create");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ title: "Réunion écrite", date: "2026-03-15", start: "09:00", end: "10:00" }),
    );
    expect(state.events.travail).toEqual([
      {
        id: "caldav:travail:abc-123",
        date: "2026-03-15",
        start: "09:00",
        end: "10:00",
        title: "Réunion écrite",
        location: "Bureau",
        description: "Point hebdo",
        calendar: "Travail",
        external: true,
        caldav: { sourceId: "travail", uid: "abc-123", etag: '"v2"' },
      },
    ]);
  });

  it("met à jour par uid avec l'etag détenu", async () => {
    const mock = fetchMock(written);
    const cached = toCalendarEvents([{ ...external(), etag: '"v1"' }], travail, "caldav")[0]!;

    const state = await updateCaldavEvent(travail, cached, { title: "Réunion écrite", date: "2026-03-15" });

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources/travail/events/abc-123");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Réunion écrite",
      date: "2026-03-15",
      etag: '"v1"',
    });
    expect(state.events.travail?.[0]?.caldav?.etag).toBe('"v2"');
  });

  it("supprime l'événement avec son etag, puis le retire du cache", async () => {
    const mock = vi.fn(
      async () => ({ ok: true, status: 204, json: async () => ({}), text: async () => "" }) as unknown as Response,
    );
    vi.stubGlobal("fetch", mock);
    const cached = toCalendarEvents([{ ...external(), etag: '"v1"' }], travail, "caldav")[0]!;
    saveIcsState(setIcsCalendarEvents(EMPTY_ICS_STATE, "travail", [cached]));

    const state = await deleteCaldavEvent(travail, cached);

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources/travail/events/abc-123?etag=%22v1%22");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(state.events.travail).toEqual([]);
    expect(loadIcsState().events.travail).toEqual([cached]);
  });

  it("reconnaît un conflit de version et relit la source", async () => {
    const conflict = response({ error: "ETag périmé", kind: "caldav" }, 412);
    const mock = vi.fn(async () => conflict);
    vi.stubGlobal("fetch", mock);

    expect(isCaldavConflict(new ApiError("ETag périmé", "caldav", 412))).toBe(true);
    expect(isCaldavConflict(new ApiError("ETag périmé", "caldav", 409))).toBe(true);
    expect(isCaldavConflict(new ApiError("erreur", "caldav", 500))).toBe(false);

    let failure: unknown = null;
    try {
      await updateCaldavEvent(travail, toCalendarEvents([external()], travail, "caldav")[0]!, { title: "x", date: "2026-03-15" });
    } catch (error) {
      failure = error;
    }

    expect(isCaldavConflict(failure)).toBe(true);
  });

  it("explique un conflit et remplace le cache par la relecture", async () => {
    const sources = vi.fn(async () => response([external({ title: "Version serveur" })]));
    vi.stubGlobal("fetch", sources);

    const message = await caldavWriteFailure(travail, new ApiError("ETag périmé", "caldav", 412));

    expect(message).toBe(CALDAV_CONFLICT_MESSAGE);
    expect(String(sources.mock.calls[0][0])).toBe("/api/calendars/caldav/sources/travail/events");
    expect(loadIcsState().events.travail?.[0]?.title).toBe("Version serveur");
  });

  it("remonte l'erreur du démon sans relire la source", async () => {
    const sources = fetchMock([external()]);

    const message = await caldavWriteFailure(travail, new ApiError("identifiants refusés", "caldav", 502));

    expect(message).toBe("Calendrier CalDAV · caldav · identifiants refusés");
    expect(sources).not.toHaveBeenCalled();
  });
});
