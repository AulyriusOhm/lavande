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
const ABONNEMENT: CalendarDef = {
  id: "abonnement",
  name: "Abonnement",
  tone: 1,
  source: { kind: "ics", url: "https://exemple.tld/calendrier.ics" },
};
const AGENDA: CalendarDef = {
  id: "agenda",
  name: "Agenda",
  tone: 2,
  source: { kind: "google", accountId: "gmail", calendarId: "primary" },
};
const TRAVAIL: CalendarDef = {
  id: "travail",
  name: "Travail",
  tone: 3,
  source: { kind: "caldav", sourceId: "travail" },
};

const googleEvent = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "google:agenda:g-1",
  date: TODAY_ISO,
  start: "11:00",
  end: "12:00",
  title: "Point Google",
  calendar: "Agenda",
  external: true,
  ...over,
});

const googlePayload = [
  {
    uid: "g-1",
    title: "Point Google",
    date: TODAY_ISO,
    start: "11:00",
    end: "12:00",
    all_day: false,
    timezone: "Europe/Paris",
    location: null,
    description: null,
    recurring: false,
    source: "primary",
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
    google?: CalendarEvent[];
    synced?: Record<string, number>;
  } = {},
) {
  window.localStorage.setItem(CALENDARS_KEY, JSON.stringify(options.calendars ?? [PRO, ABONNEMENT, AGENDA, TRAVAIL]));
  const now = Date.now();
  window.localStorage.setItem(
    ICS_KEY,
    JSON.stringify({
      events: { agenda: options.google ?? [googleEvent()] },
      synced: options.synced ?? { agenda: now, abonnement: now, travail: now },
    }),
  );
}

function stubFetch(payload: unknown = googlePayload, status = 200) {
  const fetchMock = vi.fn(async () =>
    ({
      ok: status < 400,
      status,
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

const storedIcs = () =>
  JSON.parse(window.localStorage.getItem(ICS_KEY) ?? "null") as {
    events: Record<string, CalendarEvent[]>;
    synced: Record<string, number>;
  };

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
});

describe("Agenda · événements d'un calendrier Google", () => {
  it("fusionne Google, ICS, CalDAV et calendriers locaux", () => {
    seed();
    mount();

    expect(within(dayPanel()).getByText("Point Google")).toBeTruthy();
    expect(within(dayPanel()).getByText("Google")).toBeTruthy();
    expect(within(dayPanel()).getByText("Point maquettes v3")).toBeTruthy();
    expect(within(header()).getByText(new RegExp(`sur ${EVENTS.length + 1} événements?`))).toBeTruthy();
    expect(screen.getByText("Agendas Google · 1 événement")).toBeTruthy();
  });

  it("marque le détail comme lecture seule, sans édition ni suppression", () => {
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Point Google"));

    const detail = screen.getByTestId("event-detail");
    expect(within(detail).getByText("Google · lecture seule")).toBeTruthy();
    expect(within(detail).getByText("Agenda")).toBeTruthy();
    expect(within(detail).getByText(/Calendrier Google : lecture seule, modifiable à la source/)).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: "Modifier" })).toBeNull();
    expect(within(detail).queryByRole("button", { name: "Supprimer" })).toBeNull();
  });

  it("relit l'agenda au chargement, une seule fois et sans identifiant", async () => {
    const fetchMock = stubFetch();
    const now = Date.now();
    seed({ google: [], synced: { abonnement: now, travail: now } });
    mount();

    await waitFor(() => expect(within(dayPanel()).getByText("Point Google")).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/google/gmail/events");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    const body = JSON.parse(String(init.body)) as { calendar_id: string; time_min: string; time_max: string };
    expect(Object.keys(body).sort()).toEqual(["calendar_id", "time_max", "time_min"]);
    expect(body.calendar_id).toBe("primary");
    expect(Date.parse(body.time_min)).toBeLessThan(Date.now());
    expect(Date.parse(body.time_max)).toBeGreaterThan(Date.now());
    expect(storedIcs().events.agenda).toEqual([
      {
        id: "google:agenda:g-1",
        date: TODAY_ISO,
        start: "11:00",
        end: "12:00",
        title: "Point Google",
        calendar: "Agenda",
        external: true,
      },
    ]);
    expect(storedIcs().synced.agenda).toBeGreaterThan(0);
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
    seed({ google: [googleEvent({ title: "Ancien titre" })] });
    mount();

    expect(within(dayPanel()).getByText("Ancien titre")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actualiser les agendas Google" }));

    await waitFor(() => expect(within(dayPanel()).getByText("Point Google")).toBeTruthy());
    expect(within(dayPanel()).queryByText("Ancien titre")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/calendars/google/gmail/events");
  });

  it("garde le cache et signale l'échec quand le démon refuse", async () => {
    const fetchMock = stubFetch({ error: "scope manquant", kind: "auth" }, 403);
    const now = Date.now();
    seed({ google: [googleEvent({ title: "Dernier état connu" })], synced: { abonnement: now, travail: now } });
    mount();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(within(dayPanel()).getByText("Dernier état connu")).toBeTruthy();
    expect(storedIcs().events.agenda).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("laisse les calendriers locaux éditables à côté du Google", () => {
    seed({ calendars: [PRO, AGENDA], google: [] });
    const { onEditEvent } = mount();

    expect(screen.getByRole("button", { name: "Actualiser les agendas Google" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actualiser les abonnements ICS" })).toBeNull();

    fireEvent.click(within(dayPanel()).getByText("Point maquettes v3"));
    fireEvent.click(within(screen.getByTestId("event-detail")).getByRole("button", { name: "Modifier" }));

    expect(onEditEvent).toHaveBeenCalledTimes(1);
  });

  it("ignore les événements d'un calendrier Google retiré", () => {
    seed({ calendars: [PRO], google: [googleEvent()] });
    mount();

    expect(within(dayPanel()).queryByText("Point Google")).toBeNull();
    expect(within(header()).getByText(new RegExp(`sur ${EVENTS.length} événements?`))).toBeTruthy();
  });
});
