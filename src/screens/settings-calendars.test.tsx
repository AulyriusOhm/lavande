import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, CaldavSource } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";
import type { CalendarEvent } from "@/lib/calendar";

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";
const URL_CALDAV = "https://caldav.exemple.tld/";
const PASSWORD = "mot-de-passe-cal dav";

const SOURCE: CaldavSource = { id: "travail", name: "Travail", url: URL_CALDAV };

const ACCOUNT: ApiAccount = {
  id: "perso",
  label: "Perso",
  email: "roman@exemple.tld",
  username: "roman@exemple.tld",
  imap: { host: "mail.exemple.tld", port: 993, encryption: "tls" },
  smtp: { host: "mail.exemple.tld", port: 465, encryption: "tls" },
  folders: 1,
};

type IcsState = { events: Record<string, CalendarEvent[]>; synced: Record<string, number> };

const storedCalendars = (): CalendarDef[] =>
  JSON.parse(window.localStorage.getItem(CALENDARS_KEY) ?? "null") as CalendarDef[];
const storedIcs = (): IcsState => JSON.parse(window.localStorage.getItem(ICS_KEY) ?? "null") as IcsState;

const externalEvents = [
  {
    uid: "abc-123",
    title: "Réunion équipe",
    date: "2026-03-15",
    start: "09:00",
    end: "10:00",
    all_day: false,
    timezone: "UTC",
    location: "Bureau",
    description: null,
    recurring: false,
    source: "Travail",
  },
];

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon(
  options: {
    sources?: CaldavSource[];
    events?: unknown;
    createStatus?: number;
    accounts?: ApiAccount[];
    created?: CaldavSource;
  } = {},
) {
  let sources = options.sources ?? [];
  const created = options.created ?? SOURCE;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/calendars/caldav/sources/from-account")) {
      const status = options.createStatus ?? 201;
      if (status < 400) sources = [...sources, created];
      return reply(status < 400 ? created : { error: "compte OAuth", kind: "caldav" }, status);
    }
    if (url.endsWith("/calendars/caldav/sources")) {
      if (method === "POST") {
        const status = options.createStatus ?? 201;
        if (status < 400) sources = [...sources, SOURCE];
        return reply(status < 400 ? SOURCE : { error: "identifiants refusés", kind: "caldav" }, status);
      }
      return reply(sources);
    }
    if (url.endsWith("/calendars/ics")) return reply(options.events ?? externalEvents);
    if (url.endsWith("/events")) return reply(options.events ?? externalEvents);
    if (method === "DELETE") {
      sources = sources.filter((entry) => !url.endsWith(`/${entry.id}`));
      return reply({}, 204);
    }
    if (url.endsWith("/accounts")) return reply(options.accounts ?? []);
    return reply([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string, method?: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const request = init as RequestInit | undefined;
    return String(input).endsWith(suffix) && (method === undefined || (request?.method ?? "GET") === method);
  });

const storedText = () =>
  Object.keys(window.localStorage)
    .map((key) => window.localStorage.getItem(key) ?? "")
    .join("\n");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
});

function mount() {
  const view = render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <SettingsScreen
              mails={[]}
              account="all"
              onOpenAccounts={() => {}}
              onOpenPgp={() => {}}
              onOpenMcp={() => {}}
            />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Synchronisation/ }));
  return view;
}

const source = (id: string) => screen.getByTestId(`calendar-source-${id}`);

const addCaldav = async (input: { url?: string; username?: string; password?: string; name?: string } = {}) => {
  fireEvent.click(screen.getByRole("button", { name: "CalDAV" }));
  if (input.name) fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: input.name } });
  fireEvent.change(screen.getByLabelText("URL du serveur CalDAV"), {
    target: { value: input.url ?? URL_CALDAV },
  });
  fireEvent.change(screen.getByLabelText("Identifiant CalDAV"), { target: { value: input.username ?? "romain" } });
  fireEvent.change(screen.getByLabelText("Mot de passe CalDAV"), {
    target: { value: input.password ?? PASSWORD },
  });
  fireEvent.click(screen.getByRole("button", { name: /Connecter/ }));
};

describe("Réglages mobile · calendriers", () => {
  it("ajoute un calendrier CalDAV sans aucun compte mail", async () => {
    const fetchMock = stubDaemon();
    mount();

    await addCaldav({ name: "Travail" });

    await waitFor(() => expect(storedIcs().events.travail).toHaveLength(1));
    const [url, init] = calls(fetchMock, "/calendars/caldav/sources", "POST")[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/caldav/sources");
    expect(init.body).toBe(
      JSON.stringify({ url: URL_CALDAV, username: "romain", password: PASSWORD, name: "Travail" }),
    );
    expect(storedCalendars().at(-1)).toEqual({
      id: "travail",
      name: "Travail",
      tone: 0,
      source: { kind: "caldav", sourceId: "travail" },
    });
    expect(storedText()).not.toContain(PASSWORD);
    expect(within(source("travail")).getByText("CalDAV")).toBeTruthy();
    expect(within(source("travail")).getByText(/1 événement/)).toBeTruthy();
  });

  it("lie l'agenda d'un compte mail depuis l'onglet CalDAV, sans mot de passe", async () => {
    const linked: CaldavSource = {
      id: "mail-exemple-tld",
      name: "mail.exemple.tld",
      url: "https://mail.exemple.tld/dav/",
      account_id: "perso",
    };
    const fetchMock = stubDaemon({ accounts: [ACCOUNT], created: linked });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "CalDAV" }));
    fireEvent.change(await screen.findByLabelText("Compte mail pour l'agenda"), { target: { value: "perso" } });
    fireEvent.click(screen.getByRole("button", { name: "Connecter l'agenda du compte sélectionné" }));

    await waitFor(() => expect(storedIcs().events["mail-exemple-tld"]).toHaveLength(1));
    const [url, init] = calls(fetchMock, "/calendars/caldav/sources/from-account", "POST")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/calendars/caldav/sources/from-account");
    expect(init.body).toBe(JSON.stringify({ account_id: "perso" }));
    expect(storedCalendars().at(-1)).toEqual({
      id: "mail-exemple-tld",
      name: "mail.exemple.tld",
      tone: 0,
      source: { kind: "caldav", sourceId: "mail-exemple-tld", accountId: "perso" },
    });
    expect(storedText()).not.toContain(PASSWORD);
    expect(within(source("mail-exemple-tld")).getByText(/roman@exemple\.tld/)).toBeTruthy();
  });

  it("importe un fichier .ics et garde les événements analysés", async () => {
    const fetchMock = stubDaemon();
    mount();

    fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: "Vacances" } });
    const content = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    fireEvent.change(screen.getByTestId("ics-file-input"), {
      target: { files: [new File([content], "vacances.ics", { type: "text/calendar" })] },
    });

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    expect(storedCalendars().at(-1)).toEqual({ id: "vacances", name: "Vacances", tone: 0, source: { kind: "ics" } });
    const [, init] = calls(fetchMock, "/calendars/ics")[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ content, source: "Vacances" }));
    expect(storedIcs().events.vacances).toHaveLength(1);
    expect(within(source("vacances")).getByText(/fichier importé/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actualiser le calendrier Vacances" })).toBeNull();
  });

  it("abonne un calendrier par URL ICS", async () => {
    const fetchMock = stubDaemon();
    mount();

    fireEvent.change(screen.getByLabelText("URL du calendrier ICS"), {
      target: { value: "https://exemple.tld/calendrier.ics" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Abonner/ }));

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    expect(storedCalendars().at(-1)).toMatchObject({
      id: "exemple-tld",
      source: { kind: "ics", url: "https://exemple.tld/calendrier.ics" },
    });
    expect(calls(fetchMock, "/calendars/ics")).toHaveLength(1);
    expect(within(source("exemple-tld")).getByText("ICS")).toBeTruthy();
  });

  it("refuse une URL invalide sans appeler le démon", async () => {
    const fetchMock = stubDaemon();
    mount();

    fireEvent.change(screen.getByLabelText("URL du calendrier ICS"), { target: { value: "pas une url" } });
    fireEvent.click(screen.getByRole("button", { name: /Abonner/ }));

    expect(screen.getByRole("alert").textContent).toBe("URL invalide");
    expect(calls(fetchMock, "/calendars/ics")).toHaveLength(0);
    expect(window.localStorage.getItem(CALENDARS_KEY)).toBeNull();
  });

  it("renomme une source puis la supprime avec confirmation", async () => {
    stubDaemon({ sources: [SOURCE] });
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 0 },
        { id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } },
      ]),
    );
    window.localStorage.setItem(
      ICS_KEY,
      JSON.stringify({
        events: {
          travail: [
            { id: "caldav:travail:abc-123", date: "2026-03-15", start: "09:00", end: "10:00", title: "R", calendar: "Travail", external: true },
          ],
        },
        synced: { travail: Date.now() },
      }),
    );
    const fetchMock = stubDaemon({ sources: [SOURCE] });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Renommer le calendrier Travail" }));
    fireEvent.change(screen.getByLabelText("Nouveau nom pour Travail"), { target: { value: "Boulot" } });
    fireEvent.click(screen.getByRole("button", { name: "Valider" }));

    expect(storedCalendars().map((entry) => entry.name)).toEqual(["Pro", "Boulot"]);
    expect(screen.queryByTestId("calendar-source-travail")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le calendrier Boulot" }));
    expect(within(source("travail")).getByText("Supprimer ?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(storedCalendars().map((entry) => entry.name)).toEqual(["Pro"]));
    expect(calls(fetchMock, "/calendars/caldav/sources/travail", "DELETE")).toHaveLength(1);
    expect(storedIcs().events.travail).toBeUndefined();
  });

  it("relit une source à la demande", async () => {
    const fetchMock = stubDaemon();
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([{ id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } }]),
    );
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Actualiser le calendrier Travail" }));

    await waitFor(() => expect(storedIcs().events.travail).toHaveLength(1));
    expect(calls(fetchMock, "/calendars/caldav/sources/travail/events", "POST")).toHaveLength(1);
  });

  it("change le ton d'une source", () => {
    window.localStorage.setItem(CALENDARS_KEY, JSON.stringify([{ id: "pro", name: "Pro", tone: 0 }]));
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Ton de Pro · ton 3" }));

    expect(storedCalendars()).toEqual([{ id: "pro", name: "Pro", tone: 2 }]);
  });

  it("crée un calendrier local", () => {
    stubDaemon();
    mount();

    fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: "Famille" } });
    fireEvent.click(screen.getByRole("button", { name: /Créer un calendrier local/ }));

    expect(storedCalendars().at(-1)).toEqual({ id: "famille", name: "Famille", tone: 0 });
    expect(within(source("famille")).getByText("local")).toBeTruthy();
  });
});
