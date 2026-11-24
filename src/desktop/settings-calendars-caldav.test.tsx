import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
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
const PASSWORD = "s3cret-cal dav";

type IcsState = { events: Record<string, CalendarEvent[]>; synced: Record<string, number> };

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
  {
    uid: "jour-6",
    title: "Journée off",
    date: "2026-03-20",
    start: null,
    end: null,
    all_day: true,
    timezone: null,
    location: null,
    description: null,
    recurring: true,
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
    created?: CaldavSource;
    createStatus?: number;
    createPayload?: unknown;
    eventsPayload?: unknown;
    eventsStatus?: number;
    listStatus?: number;
    removeStatus?: number;
    accounts?: ApiAccount[];
  } = {},
) {
  let sources = options.sources ?? [];
  const created = options.created ?? SOURCE;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/accounts") return reply(options.accounts ?? []);
    if (url.endsWith("/calendars/caldav/sources/from-account")) {
      const status = options.createStatus ?? 201;
      if (status < 400) sources = [...sources, created];
      return reply(options.createPayload ?? created, status);
    }
    if (url.endsWith("/calendars/caldav/sources")) {
      if (method === "POST") {
        const status = options.createStatus ?? 201;
        if (status < 400) sources = [...sources, created];
        return reply(options.createPayload ?? created, status);
      }
      return reply(sources, options.listStatus ?? 200);
    }
    if (url.endsWith("/events")) return reply(options.eventsPayload ?? externalEvents, options.eventsStatus ?? 200);
    if (method === "DELETE") {
      const status = options.removeStatus ?? 204;
      if (status < 400) sources = sources.filter((entry) => !url.endsWith(`/${entry.id}`));
      return reply({}, status);
    }
    return reply({}, 204);
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

const openSection = (label: string) => {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sections des réglages" })).getByRole("button", { name: label }),
  );
};

function renderSettings() {
  const view = render(
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
  openSection("Calendriers");
  return view;
}

const section = () => document.getElementById("reglages-calendriers") as HTMLElement;

const addCaldav = async (input: { url?: string; username?: string; password?: string; name?: string }) => {
  if (input.name) fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: input.name } });
  fireEvent.change(screen.getByLabelText("URL du serveur CalDAV"), { target: { value: input.url ?? URL_CALDAV } });
  fireEvent.change(screen.getByLabelText("Identifiant CalDAV"), { target: { value: input.username ?? "romain" } });
  fireEvent.change(screen.getByLabelText("Mot de passe CalDAV"), { target: { value: input.password ?? PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Connecter" }));
};

describe("Réglages · sources CalDAV", () => {
  it("ajoute une source, range ses événements et n'envoie les identifiants qu'une fois", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await addCaldav({ name: "Travail" });

    await waitFor(() => expect(storedIcs().events.travail).toHaveLength(2));
    const [createUrl, createInit] = calls(fetchMock, "/calendars/caldav/sources", "POST")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(createUrl).toBe("/api/calendars/caldav/sources");
    expect(createInit.body).toBe(
      JSON.stringify({ url: URL_CALDAV, username: "romain", password: PASSWORD, name: "Travail" }),
    );
    expect(storedCalendars()[3]).toEqual({
      id: "travail",
      name: "Travail",
      tone: 0,
      source: { kind: "caldav", sourceId: "travail" },
    });
    expect(storedIcs().events.travail).toEqual([
      {
        id: "caldav:travail:abc-123",
        date: "2026-03-15",
        start: "09:00",
        end: "10:00",
        title: "Réunion équipe",
        location: "Bureau",
        calendar: "Travail",
        external: true,
        caldav: { sourceId: "travail", uid: "abc-123" },
      },
      {
        id: "caldav:travail:jour-6",
        date: "2026-03-20",
        start: "",
        end: "",
        title: "Journée off",
        calendar: "Travail",
        external: true,
        recurring: true,
        caldav: { sourceId: "travail", uid: "jour-6" },
      },
    ]);
    expect(calls(fetchMock, "/calendars/caldav/sources/travail/events", "POST")).toHaveLength(1);
    expect(within(section()).getByText("CalDAV")).toBeTruthy();
    expect(within(section()).getByText(URL_CALDAV)).toBeTruthy();
    expect(within(section()).getByText(/· 2 événements/)).toBeTruthy();
    expect((screen.getByLabelText("Mot de passe CalDAV") as HTMLInputElement).value).toBe("");
  });

  it("ne garde ni le mot de passe ni l'identifiant côté front", async () => {
    stubDaemon();
    renderSettings();

    await addCaldav({ name: "Travail" });
    await waitFor(() => expect(storedIcs().events.travail).toHaveLength(2));

    expect(storedText()).not.toContain(PASSWORD);
    expect(storedText()).not.toContain("romain");
    expect(JSON.parse(window.localStorage.getItem(CALENDARS_KEY) ?? "[]")[3]).not.toHaveProperty("password");
  });

  it("déduit le nom du serveur quand le champ est vide", async () => {
    const fetchMock = stubDaemon({ created: { id: "caldav-exemple-tld", name: "caldav.exemple.tld", url: URL_CALDAV } });
    renderSettings();

    await addCaldav({});

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    expect(storedCalendars()[3]).toEqual({
      id: "caldav-exemple-tld",
      name: "caldav.exemple.tld",
      tone: 0,
      source: { kind: "caldav", sourceId: "caldav-exemple-tld" },
    });
    const [, init] = calls(fetchMock, "/calendars/caldav/sources", "POST")[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).name).toBe("caldav.exemple.tld");
  });

  it("refuse une URL ou des identifiants manquants sans appeler le démon", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await addCaldav({ url: "pas une url" });
    expect(screen.getByRole("alert").textContent).toBe("URL invalide");

    await addCaldav({ username: " " });
    expect(screen.getByRole("alert").textContent).toBe("Identifiant CalDAV requis");

    await addCaldav({ password: "" });
    expect(screen.getByRole("alert").textContent).toBe("Mot de passe CalDAV requis");

    expect(calls(fetchMock, "/calendars/caldav/sources", "POST")).toHaveLength(0);
    expect(window.localStorage.getItem(CALENDARS_KEY)).toBeNull();
  });

  it("remonte le refus du démon et n'ajoute rien", async () => {
    stubDaemon({ createStatus: 502, createPayload: { error: "identifiants refusés", kind: "caldav" } });
    renderSettings();

    await addCaldav({ name: "Travail" });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("identifiants refusés"));
    expect(screen.getByRole("alert").textContent).toContain("caldav");
    expect(window.localStorage.getItem(CALENDARS_KEY)).toBeNull();
    expect(window.localStorage.getItem(ICS_KEY)).toBeNull();
  });

  it("garde la source quand seuls les événements échouent", async () => {
    const fetchMock = stubDaemon({
      eventsPayload: { error: "serveur muet", kind: "caldav" },
      eventsStatus: 502,
    });
    renderSettings();

    await addCaldav({ name: "Travail" });

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    expect(storedCalendars()[3].source).toEqual({ kind: "caldav", sourceId: "travail" });
    expect(window.localStorage.getItem(ICS_KEY)).toBeNull();
    expect(calls(fetchMock, "/calendars/caldav/sources", "POST")).toHaveLength(1);
  });

  it("refuse un nom déjà pris", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await addCaldav({ name: " pro " });

    expect(screen.getByRole("alert").textContent).toBe("Calendrier déjà présent · pro");
    expect(calls(fetchMock, "/calendars/caldav/sources", "POST")).toHaveLength(0);
  });

  it("supprime la source du démon, le calendrier local et ses événements cachés", async () => {
    const fetchMock = stubDaemon({ sources: [SOURCE] });
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([{ id: "pro", name: "Pro", tone: 0 }, { id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } }]),
    );
    window.localStorage.setItem(
      ICS_KEY,
      JSON.stringify({
        events: { travail: [{ id: "caldav:travail:abc-123", date: "2026-03-15", start: "09:00", end: "10:00", title: "Réunion équipe", calendar: "Travail", external: true }] },
        synced: { travail: Date.now() },
      }),
    );
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le calendrier Travail" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(storedCalendars().map((entry) => entry.name)).toEqual(["Pro"]));
    expect(calls(fetchMock, "/calendars/caldav/sources/travail", "DELETE")).toHaveLength(1);
    expect(storedIcs().events.travail).toBeUndefined();
    expect(storedIcs().synced.travail).toBeUndefined();
    expect(within(section()).queryByText("Travail")).toBeNull();
  });

  it("garde la source quand le démon refuse de la supprimer", async () => {
    stubDaemon({ sources: [SOURCE], removeStatus: 500 });
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([{ id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } }]),
    );
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le calendrier Travail" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("500"));
    expect(storedCalendars().map((entry) => entry.name)).toEqual(["Travail"]);
  });

  it("lie l'agenda d'un compte mail sans ressaisir de mot de passe", async () => {
    const linked: CaldavSource = {
      id: "mail-exemple-tld",
      name: "mail.exemple.tld",
      url: "https://mail.exemple.tld/dav/",
      account_id: "perso",
    };
    const fetchMock = stubDaemon({ accounts: [ACCOUNT], created: linked });
    renderSettings();

    fireEvent.change(await screen.findByLabelText("Compte mail pour l'agenda"), { target: { value: "perso" } });
    fireEvent.click(screen.getByRole("button", { name: "Connecter l'agenda du compte sélectionné" }));

    await waitFor(() => expect(storedIcs().events["mail-exemple-tld"]).toHaveLength(2));
    const [url, init] = calls(fetchMock, "/calendars/caldav/sources/from-account", "POST")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/calendars/caldav/sources/from-account");
    expect(init.body).toBe(JSON.stringify({ account_id: "perso" }));
    expect(storedCalendars()[3]).toEqual({
      id: "mail-exemple-tld",
      name: "mail.exemple.tld",
      tone: 0,
      source: { kind: "caldav", sourceId: "mail-exemple-tld", accountId: "perso" },
    });
    expect(storedText()).not.toContain("motdepasse");
    expect(
      within(section()).getAllByText(/roman@exemple\.tld · https:\/\/mail\.exemple\.tld\/dav\//),
    ).toHaveLength(1);
  });

  it("affiche les trois types et reste utilisable sans liste du démon", async () => {
    stubDaemon({ listStatus: 500 });
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 0 },
        { id: "google", name: "Google", tone: 1, source: { kind: "ics", url: "https://exemple.tld/c.ics" } },
        { id: "travail", name: "Travail", tone: 2, source: { kind: "caldav", sourceId: "travail" } },
      ]),
    );
    renderSettings();

    const list = within(section());
    expect(list.getByText("local")).toBeTruthy();
    expect(list.getByText("ICS")).toBeTruthy();
    expect(list.getByText("CalDAV")).toBeTruthy();
    expect(list.getByText("https://exemple.tld/c.ics")).toBeTruthy();
    expect(list.getByText("URL inconnue")).toBeTruthy();
  });
});
