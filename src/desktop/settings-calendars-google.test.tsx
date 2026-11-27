import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, GoogleCalendar } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";
import type { CalendarEvent } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "local");

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";

const GMAIL: ApiAccount = {
  id: "gmail",
  label: "Gmail",
  email: "roman.lanro@gmail.com",
  username: "roman.lanro@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
  smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
  folders: 2,
};

const OVH: ApiAccount = {
  id: "ovh",
  label: "Studio",
  email: "roman@studio-lilas.fr",
  username: "roman",
  imap: { host: "ssl0.ovh.net", port: 993, encryption: "tls" },
  smtp: { host: "ssl0.ovh.net", port: 465, encryption: "tls" },
  folders: 1,
};

const GOOGLE_CALENDARS: GoogleCalendar[] = [
  { id: "primary", summary: "Agenda perso", description: null },
  { id: "equipe@group.calendar.google.com", summary: "Équipe" },
];

const EXTERNAL_EVENTS = [
  {
    uid: "g-1",
    title: "Point équipe",
    date: "2026-03-15",
    start: "09:00",
    end: "10:00",
    all_day: false,
    timezone: "Europe/Paris",
    location: null,
    description: null,
    recurring: false,
    source: "Agenda perso",
  },
];

const storedCalendars = (): CalendarDef[] =>
  JSON.parse(window.localStorage.getItem(CALENDARS_KEY) ?? "null") as CalendarDef[];
const storedIcs = () =>
  JSON.parse(window.localStorage.getItem(ICS_KEY) ?? "null") as {
    events: Record<string, CalendarEvent[]>;
    synced: Record<string, number>;
  };

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon(
  options: {
    accounts?: ApiAccount[];
    calendars?: GoogleCalendar[];
    calendarsStatus?: number;
    calendarsError?: string;
    events?: unknown;
    eventsStatus?: number;
  } = {},
) {
  const accounts = options.accounts ?? [GMAIL, OVH];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/accounts") return reply(accounts);
    if (/\/accounts\/[^/]+\/folders$/.test(url)) return reply([]);
    if (/\/accounts\/[^/]+\/folder-counts$/.test(url)) return reply([]);
    if (url.endsWith("/calendars/caldav/sources")) return reply([]);
    if (/\/calendars\/google\/[^/]+\/calendars$/.test(url)) {
      return reply(
        options.calendarsStatus !== undefined && options.calendarsStatus >= 400
          ? {
              error:
                options.calendarsError ??
                "Google a refusé le jeton d'accès (403) : reconnectez le compte",
              kind: "auth",
            }
          : (options.calendars ?? GOOGLE_CALENDARS),
        options.calendarsStatus ?? 200,
      );
    }
    if (/\/calendars\/google\/[^/]+\/events$/.test(url)) {
      return reply(options.events ?? EXTERNAL_EVENTS, options.eventsStatus ?? 200);
    }
    return reply({}, 204);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, suffix: RegExp | string) =>
  fetchMock.mock.calls.filter(([input]) =>
    typeof suffix === "string" ? String(input).endsWith(suffix) : suffix.test(String(input)),
  );

const renderSettings = () =>
  render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <DesktopSettings />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );

const section = () => document.getElementById("reglages-calendriers") as HTMLElement;

const openSection = (label: string) => {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sections des réglages" })).getByRole("button", { name: label }),
  );
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages · calendriers Google", () => {
  it("liste les calendriers du seul compte Google et en ajoute un", async () => {
    const fetchMock = stubDaemon();
    renderSettings();
    openSection("Calendriers");

    const add = await screen.findByRole("button", { name: "Ajouter le calendrier Google Agenda perso" });
    expect(within(section()).getByText("Compte Google")).toBeTruthy();
    expect(within(section()).getByText("Gmail · roman.lanro@gmail.com")).toBeTruthy();
    expect(within(section()).getByText("Équipe")).toBeTruthy();
    expect(calls(fetchMock, /\/calendars\/google\/gmail\/calendars$/)).toHaveLength(1);
    expect(calls(fetchMock, /\/calendars\/google\/ovh\/calendars$/)).toHaveLength(0);

    fireEvent.click(add);

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    expect(storedCalendars()[3]).toEqual({
      id: "agenda-perso",
      name: "Agenda perso",
      tone: 0,
      source: { kind: "google", accountId: "gmail", calendarId: "primary" },
    });
    await waitFor(() => expect(storedIcs().events["agenda-perso"]).toHaveLength(1));
    expect(storedIcs().events["agenda-perso"][0]).toEqual({
      id: "google:agenda-perso:g-1",
      date: "2026-03-15",
      start: "09:00",
      end: "10:00",
      title: "Point équipe",
      calendar: "Agenda perso",
      external: true,
    });

    const [eventsUrl, eventsInit] = calls(fetchMock, /\/calendars\/google\/gmail\/events$/)[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(eventsUrl).toBe("/api/calendars/google/gmail/events");
    expect(eventsInit.method).toBe("POST");
    const body = JSON.parse(String(eventsInit.body)) as { calendar_id: string; time_min: string; time_max: string };
    expect(body.calendar_id).toBe("primary");
    expect(Date.parse(body.time_min)).toBeLessThan(Date.now());
    expect(Date.parse(body.time_max)).toBeGreaterThan(Date.now());

    const list = within(section());
    expect(list.getByText("Google")).toBeTruthy();
    expect(list.getByText("roman.lanro@gmail.com · primary")).toBeTruthy();
    expect(list.getByText(/· 1 événement/)).toBeTruthy();
    expect(list.getByText("Dans l'agenda")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ajouter le calendrier Google Agenda perso" })).toBeNull();
  });

  it("affiche le refus du démon quand le droit agenda manque, sans boucle", async () => {
    const fetchMock = stubDaemon({ calendarsStatus: 403 });
    renderSettings();
    openSection("Calendriers");

    await waitFor(() =>
      expect(section().textContent).toContain(
        "Google a refusé le jeton d'accès (403) : reconnectez le compte",
      ),
    );
    expect(calls(fetchMock, /\/calendars\/google\/gmail\/calendars$/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Ajouter le calendrier Google Agenda perso" })).toBeNull();
    expect(window.localStorage.getItem(CALENDARS_KEY)).toBeNull();
  });

  it("affiche la vraie raison d'un 403 qui n'est pas un défaut de consentement", async () => {
    stubDaemon({
      calendarsStatus: 403,
      calendarsError:
        "accès Google Calendar interdit (403) : Google Calendar API has not been used in project 123 before or it is disabled",
    });
    renderSettings();
    openSection("Calendriers");

    await waitFor(() =>
      expect(section().textContent).toContain("Google Calendar API has not been used in project 123"),
    );
    expect(section().textContent).not.toContain("reconnecte le compte Google pour autoriser l'agenda");
  });

  it("ne demande rien à un compte qui n'est pas Google", async () => {
    const fetchMock = stubDaemon({ accounts: [OVH] });
    renderSettings();

    await waitFor(() => expect(screen.getByLabelText("Renommer Studio")).toBeTruthy());
    openSection("Calendriers");
    expect(screen.queryByText("Compte Google")).toBeNull();
    expect(calls(fetchMock, /\/calendars\/google\//)).toHaveLength(0);
  });

  it("retire une source Google, son calendrier et son cache sans appeler le démon", async () => {
    const fetchMock = stubDaemon({ accounts: [OVH] });
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 0 },
        { id: "agenda", name: "Agenda", tone: 1, source: { kind: "google", accountId: "gmail", calendarId: "primary" } },
      ]),
    );
    window.localStorage.setItem(
      ICS_KEY,
      JSON.stringify({
        events: {
          agenda: [
            {
              id: "google:agenda:g-1",
              date: "2026-03-15",
              start: "09:00",
              end: "10:00",
              title: "Point équipe",
              calendar: "Agenda",
              external: true,
            },
          ],
        },
        synced: { agenda: Date.now() },
      }),
    );
    renderSettings();
    openSection("Calendriers");

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le calendrier Agenda" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(storedCalendars().map((entry) => entry.name)).toEqual(["Pro"]));
    expect(storedIcs().events.agenda).toBeUndefined();
    expect(storedIcs().synced.agenda).toBeUndefined();
    expect(
      (fetchMock.mock.calls as unknown[][]).filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE"),
    ).toHaveLength(0);
    expect(within(section()).queryByText("Agenda")).toBeNull();
  });

  it("garde les calendriers local, ICS et CalDAV à côté du Google", async () => {
    stubDaemon();
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 0 },
        { id: "abonnement", name: "Abonnement", tone: 1, source: { kind: "ics", url: "https://exemple.tld/c.ics" } },
        { id: "travail", name: "Travail", tone: 2, source: { kind: "caldav", sourceId: "travail" } },
      ]),
    );
    renderSettings();
    openSection("Calendriers");

    fireEvent.click(await screen.findByRole("button", { name: "Ajouter le calendrier Google Équipe" }));

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    const list = within(section());
    expect(list.getByText("local")).toBeTruthy();
    expect(list.getByText("ICS")).toBeTruthy();
    expect(list.getByText("CalDAV")).toBeTruthy();
    expect(list.getByText("Google")).toBeTruthy();
    expect(storedCalendars()[3]).toEqual({
      id: "equipe",
      name: "Équipe",
      tone: 0,
      source: { kind: "google", accountId: "gmail", calendarId: "equipe@group.calendar.google.com" },
    });
  });

  it("garde le calendrier quand les événements seuls échouent", async () => {
    stubDaemon({ eventsStatus: 502, events: { error: "serveur muet", kind: "gcal" } });
    renderSettings();
    openSection("Calendriers");

    fireEvent.click(await screen.findByRole("button", { name: "Ajouter le calendrier Google Agenda perso" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("événements non lus"));
    expect(storedCalendars()[3].source).toEqual({ kind: "google", accountId: "gmail", calendarId: "primary" });
    expect(window.localStorage.getItem(ICS_KEY)).toBeNull();
  });
});

describe("Réglages · compte Google absent", () => {
  it("propose de connecter un compte sans lancer de requête Google", async () => {
    const fetchMock = stubDaemon({ accounts: [] });
    renderSettings();
    openSection("Calendriers");

    const connect = await screen.findByRole("button", { name: "Connecter un compte Google" });
    expect(screen.getByText(/Aucun compte Google connecté/)).toBeTruthy();

    fireEvent.click(connect);

    expect(calls(fetchMock, /\/calendars\/google\//)).toHaveLength(0);
    expect(within(section()).queryByText("Compte Google")).toBeNull();
  });
});
