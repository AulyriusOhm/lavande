import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopCalendar, NewEventDialog } from "@/desktop/calendar";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { EVENTS, TODAY_ISO } from "@/lib/calendar";
import type { CalendarDef } from "@/lib/calendars";
import type { CalendarEvent } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";

const ORIGINAL_MATCH_MEDIA = window.matchMedia;

const PRO: CalendarDef = { id: "pro", name: "Pro", tone: 0 };
const TRAVAIL: CalendarDef = { id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } };
const GOOGLE: CalendarDef = {
  id: "google",
  name: "Google",
  tone: 2,
  source: { kind: "ics", url: "https://exemple.tld/calendrier.ics" },
};

const caldavEvent = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "caldav:travail:abc-123",
  date: TODAY_ISO,
  start: "14:00",
  end: "15:00",
  title: "Réunion CalDAV",
  location: "Bureau",
  calendar: "Travail",
  external: true,
  caldav: { sourceId: "travail", uid: "abc-123", etag: '"v1"' },
  ...over,
});

const icsEvent = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "ics:google:g-1",
  date: TODAY_ISO,
  start: "16:00",
  end: "17:00",
  title: "Réunion ICS",
  calendar: "Google",
  external: true,
  ...over,
});

const caldavPayload = [
  {
    uid: "abc-123",
    title: "Réunion CalDAV",
    date: TODAY_ISO,
    start: "14:00",
    end: "15:00",
    all_day: false,
    timezone: "UTC",
    location: "Bureau",
    description: null,
    recurring: false,
    source: "Travail",
  },
];

/** L'événement que le démon renvoie après une écriture, avec le nouvel etag. */
const writtenPayload = {
  uid: "abc-123",
  title: "Revue serveur",
  date: TODAY_ISO,
  start: "14:00",
  end: "15:00",
  all_day: false,
  timezone: "UTC",
  location: null,
  description: null,
  recurring: false,
  source: "Travail",
  etag: '"v2"',
};

function installViewport(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: /max-width:\s*(\d+)px/.exec(media) ? width <= Number(/max-width:\s*(\d+)px/.exec(media)![1]) : false,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
}

function seed(
  options: {
    calendars?: CalendarDef[];
    caldav?: CalendarEvent[];
    ics?: CalendarEvent[];
    synced?: Record<string, number>;
  } = {},
) {
  window.localStorage.setItem(CALENDARS_KEY, JSON.stringify(options.calendars ?? [PRO, TRAVAIL, GOOGLE]));
  window.localStorage.setItem(
    ICS_KEY,
    JSON.stringify({
      events: {
        travail: options.caldav ?? [caldavEvent()],
        google: options.ics ?? [icsEvent()],
      },
      synced: options.synced ?? { travail: Date.now(), google: Date.now() },
    }),
  );
}

function stubFetch(payload: unknown = caldavPayload) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Le démon répond route par route : écriture puis relecture de la source. */
function stubRoutes(routes: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => routes(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const noContent = (): Response => ({ ok: true, status: 204, json: async () => ({}), text: async () => "" }) as unknown as Response;

const storedEvents = (): Record<string, CalendarEvent[]> =>
  (JSON.parse(window.localStorage.getItem(ICS_KEY) ?? "null") as { events: Record<string, CalendarEvent[]> } | null)
    ?.events ?? {};

function mount() {
  installViewport(1440);
  const onNewEvent = vi.fn();
  const onEditEvent = vi.fn();
  render(<DesktopCalendar onNewEvent={onNewEvent} onEditEvent={onEditEvent} />, { wrapper: Providers });
  return { onNewEvent, onEditEvent };
}

const dayPanel = () => screen.getByTestId("day-panel");
const header = () => screen.getByTestId("calendar-header");

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
  window.localStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("Agenda · événements d'une source CalDAV", () => {
  it("fusionne CalDAV, ICS et calendriers locaux", () => {
    seed();
    mount();

    expect(within(dayPanel()).getByText("Réunion CalDAV")).toBeTruthy();
    expect(within(dayPanel()).getByText("Réunion ICS")).toBeTruthy();
    expect(within(dayPanel()).getByText("Point maquettes v3")).toBeTruthy();
    expect(within(header()).getByText(new RegExp(`sur ${EVENTS.length + 2} événements?`))).toBeTruthy();
    expect(within(dayPanel()).getByText("CalDAV")).toBeTruthy();
    expect(within(dayPanel()).getByText("ICS")).toBeTruthy();
    expect(within(dayPanel()).getByText("14:00 → 15:00")).toBeTruthy();
  });

  it("propose Modifier et Supprimer pour un événement CalDAV", () => {
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion CalDAV"));

    const detail = screen.getByTestId("event-detail");
    expect(within(detail).getByText("CalDAV")).toBeTruthy();
    expect(within(detail).getByText("Travail")).toBeTruthy();
    expect(within(detail).queryByText("CalDAV · lecture seule")).toBeNull();
    expect(within(detail).queryByText(/lecture seule, modifiable à la source/)).toBeNull();
    expect(within(detail).getByRole("button", { name: "Modifier" })).toBeTruthy();
    expect(within(detail).getByRole("button", { name: "Supprimer" })).toBeTruthy();
  });

  it("garde en lecture seule un événement CalDAV sans uid serveur", () => {
    seed({ caldav: [caldavEvent({ caldav: undefined })] });
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion CalDAV"));

    const detail = screen.getByTestId("event-detail");
    expect(within(detail).getByText("CalDAV · lecture seule")).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: "Modifier" })).toBeNull();
    expect(within(detail).queryByRole("button", { name: "Supprimer" })).toBeNull();
  });

  it("laisse un événement ICS en lecture seule", () => {
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion ICS"));

    const detail = screen.getByTestId("event-detail");
    expect(within(detail).getByText("ICS · lecture seule")).toBeTruthy();
    expect(within(detail).getByText(/Calendrier ICS : lecture seule, modifiable à la source/)).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: "Modifier" })).toBeNull();
    expect(within(detail).queryByRole("button", { name: "Supprimer" })).toBeNull();
  });

  it("compte les sources CalDAV à part des abonnements ICS", () => {
    seed();
    mount();

    expect(screen.getByText("Sources CalDAV · 1 événement")).toBeTruthy();
    expect(screen.getByText("Abonnements ICS · 1 événement")).toBeTruthy();
  });

  it("suit le renommage du calendrier source", () => {
    seed({ calendars: [PRO, { ...TRAVAIL, name: "Boulot" }, GOOGLE] });
    mount();

    expect(within(dayPanel()).getByText("Boulot")).toBeTruthy();
    expect(within(screen.getByTestId("calendar-filters")).getByText("Boulot")).toBeTruthy();
  });
});

describe("Agenda · rafraîchissement des sources CalDAV", () => {
  it("relit la source au chargement, une seule fois et sans identifiants", async () => {
    const fetchMock = stubFetch();
    seed({ caldav: [], synced: { google: Date.now() } });
    mount();

    await waitFor(() => expect(within(dayPanel()).getByText("Réunion CalDAV")).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources/travail/events");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();

    const stored = JSON.parse(window.localStorage.getItem(ICS_KEY) ?? "null") as {
      events: Record<string, CalendarEvent[]>;
      synced: Record<string, number>;
    };
    expect(stored.events.travail).toEqual([
      {
        id: "caldav:travail:abc-123",
        date: TODAY_ISO,
        start: "14:00",
        end: "15:00",
        title: "Réunion CalDAV",
        location: "Bureau",
        calendar: "Travail",
        external: true,
        caldav: { sourceId: "travail", uid: "abc-123" },
      },
    ]);
    expect(stored.synced.travail).toBeGreaterThan(0);
  });

  it("ne relit pas un cache encore frais", async () => {
    const fetchMock = stubFetch();
    seed();
    mount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("actualise à la demande sans boucle", async () => {
    const fetchMock = stubFetch();
    seed({ caldav: [caldavEvent({ title: "Ancien titre" })] });
    mount();

    expect(within(dayPanel()).getByText("Ancien titre")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actualiser les sources CalDAV" }));

    await waitFor(() => expect(within(dayPanel()).getByText("Réunion CalDAV")).toBeTruthy());
    expect(within(dayPanel()).queryByText("Ancien titre")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/calendars/caldav/sources/travail/events");
  });

  it("garde le cache et signale l'échec quand le démon refuse", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "identifiants refusés", kind: "caldav" }),
      text: async () => "",
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    seed({ caldav: [caldavEvent({ title: "Dernier état connu" })], synced: { google: Date.now() } });
    mount();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actualiser les sources CalDAV" })).toBeTruthy(),
    );

    expect(within(dayPanel()).getByText("Dernier état connu")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ne rafraîchit pas les abonnements ICS quand seule une source CalDAV est demandée", async () => {
    const fetchMock = stubFetch();
    seed({ synced: { google: Date.now(), travail: Date.now() } });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Actualiser les sources CalDAV" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/calendars/caldav/sources/travail/events");
  });
});

describe("Agenda · compatibilité des sources existantes", () => {
  it("laisse les calendriers locaux éditables et l'ICS en lecture seule", () => {
    seed({ calendars: [PRO, GOOGLE], caldav: [] });
    const { onEditEvent } = mount();

    expect(screen.queryByRole("button", { name: "Actualiser les sources CalDAV" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actualiser les abonnements ICS" })).toBeTruthy();
    expect(within(dayPanel()).getByText("ICS")).toBeTruthy();

    fireEvent.click(within(dayPanel()).getByText("Point maquettes v3"));
    fireEvent.click(within(screen.getByTestId("event-detail")).getByRole("button", { name: "Modifier" }));

    expect(onEditEvent).toHaveBeenCalledTimes(1);
  });

  it("ignore les événements d'une source CalDAV retirée des calendriers", () => {
    seed({ calendars: [PRO, GOOGLE], caldav: [caldavEvent()] });
    mount();

    expect(within(dayPanel()).queryByText("Réunion CalDAV")).toBeNull();
    expect(within(header()).getByText(new RegExp(`sur ${EVENTS.length + 1} événements?`))).toBeTruthy();
  });
});

function mountDialog(event: CalendarEvent | null) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <NewEventDialog
      open
      event={event}
      initialDate={`${TODAY_ISO}T14:00`}
      onCreated={onCreated}
      onClose={onClose}
    />,
    { wrapper: Providers },
  );
  return { onClose, onCreated };
}

const seedCalendars = () =>
  window.localStorage.setItem(CALENDARS_KEY, JSON.stringify([PRO, TRAVAIL, GOOGLE]));

const seedCaldavCache = () =>
  window.localStorage.setItem(
    ICS_KEY,
    JSON.stringify({ events: { travail: [caldavEvent()] }, synced: { travail: Date.now() } }),
  );

const requestOf = (fetchMock: ReturnType<typeof stubRoutes>, index = 0) => {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return { url, init, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
};

/** La source CalDAV telle que le démon la rend : sans `calendar_href` choisi. */
const CALDAV_SOURCE = { id: "travail", name: "Travail", url: "https://dav.exemple.tld/" };

/** La source telle qu'elle est rangée quand son calendrier d'écriture est déjà choisi. */
const CALDAV_SOURCE_BOUND = { ...CALDAV_SOURCE, calendar_href: "/dav/travail/Agenda/" };

const CALDAV_COLLECTIONS = [
  { href: "/dav/travail/Agenda/", name: "Agenda" },
  { href: "/dav/travail/Projets/", name: "Projets" },
];

/** L'écriture de l'événement, après les lectures que le formulaire a pu faire avant. */
const writeCallOf = (fetchMock: ReturnType<typeof stubRoutes>) =>
  requestOf(
    fetchMock,
    fetchMock.mock.calls.findIndex(([url]) => String(url).includes("/events")),
  );

const eventPosts = (fetchMock: ReturnType<typeof stubRoutes>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/events"));

describe("Agenda · écriture d'une source CalDAV", () => {
  it("crée l'événement par le démon quand la cible est CalDAV", async () => {
    seedCalendars();
    const fetchMock = stubRoutes((url) =>
      url === "/api/calendars/caldav/sources" ? jsonResponse([CALDAV_SOURCE_BOUND]) : jsonResponse(writtenPayload, 201),
    );
    const { onClose, onCreated } = mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.change(screen.getByTestId("event-calendar-input"), { target: { value: "Travail" } });
    expect(screen.getByTestId("event-caldav-hint")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const { url, init, body } = writeCallOf(fetchMock);
    expect(url).toBe("/api/calendars/caldav/sources/travail/events/create");
    expect(init.method).toBe("POST");
    expect(body).toEqual({ title: "Revue serveur", date: TODAY_ISO, start: "14:00", end: "15:00" });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(storedEvents().travail).toEqual([
      {
        id: "caldav:travail:abc-123",
        date: TODAY_ISO,
        start: "14:00",
        end: "15:00",
        title: "Revue serveur",
        calendar: "Travail",
        external: true,
        caldav: { sourceId: "travail", uid: "abc-123", etag: '"v2"' },
      },
    ]);
  });

  it("envoie les invités saisis avec l'événement CalDAV", async () => {
    seedCalendars();
    const fetchMock = stubRoutes((url) =>
      url === "/api/calendars/caldav/sources" ? jsonResponse([CALDAV_SOURCE_BOUND]) : jsonResponse(writtenPayload, 201),
    );
    const { onClose } = mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.change(screen.getByTestId("event-calendar-input"), { target: { value: "Travail" } });
    fireEvent.change(screen.getByTestId("event-attendees-input"), {
      target: { value: "camille@studio-lilas.fr, Marc <marc@mail.fr>, camille@studio-lilas.fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const { body } = writeCallOf(fetchMock);
    expect(body.attendees).toEqual(["camille@studio-lilas.fr", "marc@mail.fr"]);
  });

  it("n'envoie pas d'invités quand le champ est vide", async () => {
    seedCalendars();
    const fetchMock = stubRoutes((url) =>
      url === "/api/calendars/caldav/sources" ? jsonResponse([CALDAV_SOURCE_BOUND]) : jsonResponse(writtenPayload, 201),
    );
    const { onClose } = mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.change(screen.getByTestId("event-calendar-input"), { target: { value: "Travail" } });
    fireEvent.change(screen.getByTestId("event-attendees-input"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const { body } = writeCallOf(fetchMock);
    expect("attendees" in body).toBe(false);
  });

  it("demande le calendrier de destination quand la source en annonce plusieurs", async () => {
    seedCalendars();
    const fetchMock = stubRoutes((url) => {
      if (url === "/api/calendars/caldav/sources") return jsonResponse([CALDAV_SOURCE]);
      if (url === "/api/calendars/caldav/sources/travail/collections") return jsonResponse(CALDAV_COLLECTIONS);
      if (url === "/api/calendars/caldav/sources/travail/events") return jsonResponse([writtenPayload]);
      if (url === "/api/calendars/caldav/sources/travail") return jsonResponse(CALDAV_SOURCE_BOUND);
      return jsonResponse(writtenPayload, 201);
    });
    const { onClose, onCreated } = mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.change(screen.getByTestId("event-calendar-input"), { target: { value: "Travail" } });

    const selector = (await screen.findByTestId("event-caldav-href-input")) as HTMLSelectElement;
    expect(selector.value).toBe("");
    expect(within(selector).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Choisir un calendrier",
      "Agenda",
      "Projets",
    ]);
    expect(screen.getByTestId("event-caldav-href-hint")).toBeTruthy();

    const blocked = screen.getByRole("button", { name: "Créer le rendez-vous" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    fireEvent.click(blocked);
    expect(eventPosts(fetchMock)).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(selector, { target: { value: "/dav/travail/Projets/" } });
    expect(screen.queryByTestId("event-caldav-href-hint")).toBeNull();
    expect((screen.getByRole("button", { name: "Créer le rendez-vous" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const patchIndex = urls.indexOf("/api/calendars/caldav/sources/travail");
    const createIndex = urls.indexOf("/api/calendars/caldav/sources/travail/events/create");
    expect(patchIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(patchIndex);
    const chosen = requestOf(fetchMock, patchIndex);
    expect(chosen.init.method).toBe("PATCH");
    expect(chosen.body).toEqual({ calendar_href: "/dav/travail/Projets/" });
    const created = requestOf(fetchMock, createIndex);
    expect(created.init.method).toBe("POST");
    expect(created.body).toEqual({ title: "Revue serveur", date: TODAY_ISO, start: "14:00", end: "15:00" });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("crée directement quand la source a déjà son calendrier d'écriture", async () => {
    seedCalendars();
    const fetchMock = stubRoutes((url) =>
      url === "/api/calendars/caldav/sources" ? jsonResponse([CALDAV_SOURCE_BOUND]) : jsonResponse(writtenPayload, 201),
    );
    const { onClose } = mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.change(screen.getByTestId("event-calendar-input"), { target: { value: "Travail" } });

    await waitFor(() => expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/calendars/caldav/sources"));
    await act(async () => {});
    expect(screen.queryByTestId("event-caldav-href-input")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith("/collections"))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
    expect(urls).toContain("/api/calendars/caldav/sources/travail/events/create");
  });

  it("met à jour l'événement avec l'etag détenu", async () => {
    seedCalendars();
    seedCaldavCache();
    const fetchMock = stubRoutes(() => jsonResponse(writtenPayload));
    const { onClose } = mountDialog(caldavEvent());

    expect((screen.getByTestId("event-calendar-input") as HTMLSelectElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const { url, init, body } = requestOf(fetchMock);
    expect(url).toBe("/api/calendars/caldav/sources/travail/events/abc-123");
    expect(init.method).toBe("PUT");
    expect(body).toEqual({
      title: "Revue serveur",
      date: TODAY_ISO,
      start: "14:00",
      end: "15:00",
      location: "Bureau",
      etag: '"v1"',
    });
    expect(storedEvents().travail?.[0]?.title).toBe("Revue serveur");
    expect(storedEvents().travail?.[0]?.caldav?.etag).toBe('"v2"');
  });

  it("explique un conflit de version et relit la source", async () => {
    seedCalendars();
    seedCaldavCache();
    const fetchMock = stubRoutes((url) =>
      url.endsWith("/events")
        ? jsonResponse([{ ...writtenPayload, title: "Version serveur" }])
        : jsonResponse({ error: "ETag périmé", kind: "caldav" }, 412),
    );
    const { onClose } = mountDialog(caldavEvent());

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(screen.getByTestId("event-error")).toBeTruthy());
    expect(screen.getByTestId("event-error").textContent).toContain("modifié sur le serveur entre-temps");
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("/api/calendars/caldav/sources/travail/events");
    expect(storedEvents().travail?.[0]?.title).toBe("Version serveur");
  });

  it("signale une écriture refusée sans relire la source", async () => {
    seedCalendars();
    const fetchMock = stubRoutes((url) =>
      url === "/api/calendars/caldav/sources"
        ? jsonResponse([CALDAV_SOURCE_BOUND])
        : jsonResponse({ error: "source inconnue", kind: "caldav" }, 404),
    );
    const { onClose } = mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Revue serveur" } });
    fireEvent.change(screen.getByTestId("event-calendar-input"), { target: { value: "Travail" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(screen.getByTestId("event-error")).toBeTruthy());
    expect(screen.getByTestId("event-error").textContent).toContain("source inconnue");
    expect(onClose).not.toHaveBeenCalled();
    expect(eventPosts(fetchMock)).toHaveLength(1);
  });

  it("supprime l'événement du serveur après confirmation", async () => {
    const fetchMock = stubRoutes(() => noContent());
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion CalDAV"));
    fireEvent.click(within(screen.getByTestId("event-detail")).getByRole("button", { name: "Supprimer" }));

    const confirm = screen.getByTestId("event-delete-confirm");
    expect(within(confirm).getByText("Supprimer ?")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(screen.queryByTestId("event-detail")).toBeNull());
    const { url, init } = requestOf(fetchMock);
    expect(url).toBe("/api/calendars/caldav/sources/travail/events/abc-123?etag=%22v1%22");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(storedEvents().travail).toEqual([]);
    expect(within(dayPanel()).queryByText("Réunion CalDAV")).toBeNull();
  });

  it("annule la suppression sans toucher au serveur", () => {
    const fetchMock = stubRoutes(() => noContent());
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion CalDAV"));
    fireEvent.click(within(screen.getByTestId("event-detail")).getByRole("button", { name: "Supprimer" }));
    fireEvent.click(within(screen.getByTestId("event-delete-confirm")).getByRole("button", { name: "Annuler" }));

    expect(screen.queryByTestId("event-delete-confirm")).toBeNull();
    expect(within(screen.getByTestId("event-detail")).getByText("Réunion CalDAV")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedEvents().travail).toHaveLength(1);
  });

  it("garde l'événement quand le démon refuse la suppression", async () => {
    const fetchMock = stubRoutes(() => jsonResponse({ error: "serveur en panne", kind: "caldav" }, 502));
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion CalDAV"));
    fireEvent.click(within(screen.getByTestId("event-detail")).getByRole("button", { name: "Supprimer" }));
    fireEvent.click(within(screen.getByTestId("event-delete-confirm")).getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("event-delete-confirm")).toBeNull());
    expect(within(screen.getByTestId("event-detail")).getByText("Réunion CalDAV")).toBeTruthy();
    expect(storedEvents().travail).toHaveLength(1);
  });

  it("délivre le cache à l'agenda sans relecture après une écriture", async () => {
    const fetchMock = stubFetch([writtenPayload]);
    seed({ synced: { google: Date.now(), travail: Date.now() } });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Actualiser les sources CalDAV" }));

    await waitFor(() => expect(within(dayPanel()).getByText("Revue serveur")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storedEvents().travail?.[0]?.caldav).toEqual({ sourceId: "travail", uid: "abc-123", etag: '"v2"' });
  });

  it("garde la création locale hors du démon", async () => {
    seedCalendars();
    const fetchMock = stubRoutes(() => jsonResponse([]));
    const { onClose } = mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Déjeuner" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedEvents().travail).toBeUndefined();
  });
});
