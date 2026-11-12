import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopCalendar } from "@/desktop/calendar";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { EVENTS, TODAY_ISO, isoInDays } from "@/lib/calendar";
import type { CalendarDef } from "@/lib/calendars";
import type { CalendarEvent } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";
const URL_ICS = "https://exemple.tld/calendrier.ics";

const ORIGINAL_MATCH_MEDIA = window.matchMedia;

const GOOGLE: CalendarDef = { id: "google", name: "Google", tone: 1, source: { kind: "ics", url: URL_ICS } };

const icsEvent = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "ics:google:abc-123",
  date: TODAY_ISO,
  start: "14:00",
  end: "15:00",
  title: "Réunion ICS",
  location: "Bureau",
  calendar: "Google",
  external: true,
  ...over,
});

const externalPayload = (over: Record<string, unknown> = {}) => [
  {
    uid: "abc-123",
    title: "Réunion ICS",
    date: TODAY_ISO,
    start: "14:00",
    end: "15:00",
    all_day: false,
    timezone: "UTC",
    location: "Bureau",
    description: null,
    recurring: false,
    source: "Google",
    ...over,
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

function seed(options: { calendars?: CalendarDef[]; events?: CalendarEvent[]; synced?: boolean } = {}) {
  window.localStorage.setItem(
    CALENDARS_KEY,
    JSON.stringify(options.calendars ?? [{ id: "pro", name: "Pro", tone: 0 }, GOOGLE]),
  );
  window.localStorage.setItem(
    ICS_KEY,
    JSON.stringify({
      events: { google: options.events ?? [icsEvent()] },
      synced: options.synced === false ? {} : { google: Date.now() },
    }),
  );
}

function stubFetch(payload: unknown = externalPayload()) {
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

describe("Agenda · événements d'un calendrier ICS", () => {
  it("fusionne les événements ICS avec les locaux", () => {
    seed();
    mount();

    expect(within(dayPanel()).getByText("Réunion ICS")).toBeTruthy();
    expect(within(dayPanel()).getByText("Point maquettes v3")).toBeTruthy();
    expect(
      within(header()).getByText(new RegExp(`sur ${EVENTS.length + 1} événements?`)),
    ).toBeTruthy();
    expect(within(dayPanel()).getByText("ICS")).toBeTruthy();
    expect(within(dayPanel()).getByText("14:00 → 15:00")).toBeTruthy();
  });

  it("affiche une journée entière sans heures", () => {
    seed({ events: [icsEvent({ start: "", end: "", title: "Journée off" })] });
    mount();

    expect(within(dayPanel()).getByText("Journée off")).toBeTruthy();
    expect(within(dayPanel()).getByText("Journée entière")).toBeTruthy();
  });

  it("marque le détail comme lecture seule, sans édition ni suppression", () => {
    seed();
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion ICS"));

    const detail = screen.getByTestId("event-detail");
    expect(within(detail).getByText("ICS · lecture seule")).toBeTruthy();
    expect(within(detail).getByText("Google")).toBeTruthy();
    expect(within(detail).getByText(/lecture seule, modifiable à la source/)).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: "Modifier" })).toBeNull();
    expect(within(detail).queryByRole("button", { name: "Supprimer" })).toBeNull();
  });

  it("laisse les événements locaux éditables", () => {
    seed();
    const { onEditEvent } = mount();

    fireEvent.click(within(dayPanel()).getByText("Point maquettes v3"));
    fireEvent.click(within(screen.getByTestId("event-detail")).getByRole("button", { name: "Modifier" }));

    expect(onEditEvent).toHaveBeenCalledTimes(1);
    expect(onEditEvent.mock.calls[0][0].external).toBeUndefined();
  });

  it("signale une récurrence sans la développer", () => {
    seed({ events: [icsEvent({ recurring: true })] });
    mount();

    fireEvent.click(within(dayPanel()).getByText("Réunion ICS"));

    expect(within(screen.getByTestId("event-detail")).getByText("récurrent")).toBeTruthy();
  });

  it("ignore les événements d'une source supprimée", () => {
    seed({ calendars: [{ id: "pro", name: "Pro", tone: 0 }] });
    mount();

    expect(within(dayPanel()).queryByText("Réunion ICS")).toBeNull();
    expect(
      within(header()).getByText(new RegExp(`sur ${EVENTS.length} événements?`)),
    ).toBeTruthy();
  });

  it("suit le renommage du calendrier source", () => {
    seed({ calendars: [{ id: "pro", name: "Pro", tone: 0 }, { ...GOOGLE, name: "Travail" }] });
    mount();

    expect(within(dayPanel()).getByText("Travail")).toBeTruthy();
    expect(within(screen.getByTestId("calendar-filters")).getByText("Travail")).toBeTruthy();
  });
});

describe("Agenda · abonnement ICS par URL", () => {
  it("relit l'abonnement au chargement, une seule fois", async () => {
    const fetchMock = stubFetch();
    seed({ events: [], synced: false });
    mount();

    await waitFor(() => expect(within(dayPanel()).getByText("Réunion ICS")).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/ics");
    expect(init.body).toBe(JSON.stringify({ url: URL_ICS, source: "Google" }));

    const stored = JSON.parse(window.localStorage.getItem(ICS_KEY) ?? "null") as {
      events: Record<string, CalendarEvent[]>;
      synced: Record<string, number>;
    };
    expect(stored.events.google).toEqual([
      {
        id: "ics:google:abc-123",
        date: TODAY_ISO,
        start: "14:00",
        end: "15:00",
        title: "Réunion ICS",
        location: "Bureau",
        calendar: "Google",
        external: true,
      },
    ]);
    expect(stored.synced.google).toBeGreaterThan(0);
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
    seed({ events: [icsEvent({ title: "Ancien titre" })] });
    mount();

    expect(within(dayPanel()).getByText("Ancien titre")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actualiser les abonnements ICS" }));

    await waitFor(() => expect(within(dayPanel()).getByText("Réunion ICS")).toBeTruthy());
    expect(within(dayPanel()).queryByText("Ancien titre")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("garde le cache et signale l'échec quand le démon refuse", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "calendrier vide", kind: "calendar" }),
      text: async () => "",
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    seed({ events: [icsEvent({ title: "Dernier état connu" })], synced: false });
    mount();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actualiser les abonnements ICS" })).toBeTruthy(),
    );

    expect(within(dayPanel()).getByText("Dernier état connu")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ne rafraîchit jamais un calendrier importé depuis un fichier", async () => {
    const fetchMock = stubFetch();
    seed({
      calendars: [{ id: "pro", name: "Pro", tone: 0 }, { id: "vacances", name: "Vacances", tone: 2, source: { kind: "ics" } }],
      events: [],
      synced: false,
    });
    mount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Actualiser les abonnements ICS" })).toBeNull();
  });

  it("affiche les événements ICS d'un autre jour du mois", () => {
    seed({ events: [icsEvent({ id: "ics:google:j2", date: isoInDays(1), title: "Lendemain ICS" })] });
    mount();

    const cell = screen.getByTestId("month-grid").querySelector(`[data-date="${isoInDays(1)}"]`);
    expect(cell?.textContent).toContain("Lendemain ICS");
  });
});

describe("Agenda · compatibilité des calendriers locaux", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reste utilisable sans aucune source ICS", () => {
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([{ id: "pro", name: "Pro", tone: 0 }, { id: "perso", name: "Perso", tone: 2 }]),
    );
    mount();

    expect(within(dayPanel()).getByText("Point maquettes v3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actualiser les abonnements ICS" })).toBeNull();
    expect(within(screen.getByTestId("calendar-filters")).getByText("Perso")).toBeTruthy();
  });
});
