import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopCalendar } from "@/desktop/calendar";
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

  it("marque le détail comme lecture seule, sans édition ni suppression", () => {
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion CalDAV"));

    const detail = screen.getByTestId("event-detail");
    expect(within(detail).getByText("CalDAV · lecture seule")).toBeTruthy();
    expect(within(detail).getByText("Travail")).toBeTruthy();
    expect(within(detail).getByText(/Calendrier CalDAV : lecture seule, modifiable à la source/)).toBeTruthy();
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
