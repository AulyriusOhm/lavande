import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, CaldavCollection, CaldavSource } from "@/lib/api";

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";
const URL_CALDAV = "https://caldav.exemple.tld/";

const ACCOUNT: ApiAccount = {
  id: "perso",
  label: "Perso",
  email: "roman@exemple.tld",
  username: "roman@exemple.tld",
  imap: { host: "mail.exemple.tld", port: 993, encryption: "tls" },
  smtp: { host: "mail.exemple.tld", port: 465, encryption: "tls" },
  folders: 1,
  auth_kind: "password",
};

const TRAVAIL: CaldavCollection = {
  href: `${URL_CALDAV}roman/travail/`,
  name: "Travail",
  description: "Réunions",
};
const COLLEGUE: CaldavCollection = {
  href: `${URL_CALDAV}collegue/Calendar/`,
  name: "Collègue",
};

const SOURCE: CaldavSource = { id: "travail", name: "Travail", url: URL_CALDAV };

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon(
  options: { collections?: CaldavCollection[]; collectionStatus?: number } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (pathname === "/api/accounts") return reply([ACCOUNT]);
    if (pathname.endsWith("/folders") || pathname.endsWith("/folder-counts")) return reply([]);
    if (pathname.endsWith("/zimbra/tags") || pathname.endsWith("/zimbra/filters")) return reply([]);
    if (pathname.endsWith("/zimbra/vacation")) return reply({ enabled: false, message: "" });
    if (pathname.endsWith("/caldav/collections")) {
      if ((options.collectionStatus ?? 200) >= 400) {
        return reply({ error: "serveur CalDAV muet", kind: "caldav" }, options.collectionStatus);
      }
      return reply(options.collections ?? [TRAVAIL, COLLEGUE]);
    }
    if (pathname.endsWith("/collections")) {
      if ((options.collectionStatus ?? 200) >= 400) {
        return reply({ error: "serveur CalDAV muet", kind: "caldav" }, options.collectionStatus);
      }
      return reply(options.collections ?? [TRAVAIL, COLLEGUE]);
    }
    if (pathname.endsWith("/caldav/sources/from-account")) return reply(SOURCE, 201);
    if (pathname.endsWith("/caldav/sources")) {
      if (method === "POST") return reply(SOURCE, 201);
      return reply([]);
    }
    if (pathname.endsWith("/collections")) {
      if ((options.collectionStatus ?? 200) >= 400) {
        return reply({ error: "serveur CalDAV muet", kind: "caldav" }, options.collectionStatus);
      }
      return reply(options.collections ?? [TRAVAIL, COLLEGUE]);
    }
    if (pathname.includes("/caldav/sources/")) {
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { calendar_href: string | null };
        return reply({ ...SOURCE, calendar_href: body.calendar_href ?? undefined });
      }
      return reply([]);
    }
    return reply({}, 204);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string, method?: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const request = init as RequestInit | undefined;
    const { pathname } = new URL(String(input), "http://localhost");
    return pathname.endsWith(suffix) && (method === undefined || (request?.method ?? "GET") === method);
  });

const section = () => document.getElementById("reglages-calendriers") as HTMLElement;

function renderSettings() {
  return render(
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
}

const fillCredentials = () => {
  fireEvent.change(screen.getByLabelText("URL du serveur CalDAV"), { target: { value: URL_CALDAV } });
  fireEvent.change(screen.getByLabelText("Identifiant CalDAV"), { target: { value: "roman" } });
  fireEvent.change(screen.getByLabelText("Mot de passe CalDAV"), { target: { value: "secret" } });
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
});

describe("Réglages · calendriers CalDAV partagés", () => {
  it("choisit la collection d'un serveur et l'envoie à l'ajout", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Choisir le calendrier" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Calendrier Travail" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Calendrier Collègue" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Calendrier Collègue" }));

    expect((screen.getByLabelText("Chemin du calendrier") as HTMLInputElement).value).toBe(COLLEGUE.href);
    fireEvent.click(screen.getByRole("button", { name: "Connecter" }));

    await waitFor(() => expect(calls(fetchMock, "/caldav/sources", "POST")).toHaveLength(1));
    const [, created] = calls(fetchMock, "/caldav/sources", "POST")[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(created.body)) as { calendar_href?: string; url: string };
    expect(payload.calendar_href).toBe(COLLEGUE.href);
    expect(payload.url).toBe(URL_CALDAV);
    const stored = JSON.parse(window.localStorage.getItem(CALENDARS_KEY) ?? "[]") as {
      source?: { kind: string; sourceId: string };
    }[];
    expect(stored.some((def) => def.source?.sourceId === "travail")).toBe(true);
  });

  it("accepte le chemin explicite du calendrier d'un collègue", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    fillCredentials();
    fireEvent.change(screen.getByLabelText("Chemin du calendrier"), {
      target: { value: "/dav/collegue/Calendar/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connecter" }));

    await waitFor(() => expect(calls(fetchMock, "/caldav/sources", "POST")).toHaveLength(1));
    const [, created] = calls(fetchMock, "/caldav/sources", "POST")[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(created.body)).calendar_href).toBe("/dav/collegue/Calendar/");
    expect(calls(fetchMock, "/caldav/collections", "POST")).toHaveLength(0);
  });

  it("choisit la collection de l'agenda d'un compte mail", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await waitFor(() => expect(screen.getByLabelText("Compte mail pour l'agenda")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Compte mail pour l'agenda"), { target: { value: "perso" } });
    fireEvent.click(screen.getByRole("button", { name: "Choisir le calendrier du compte" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Calendrier Travail" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Calendrier Travail" }));
    fireEvent.click(screen.getByRole("button", { name: "Connecter l'agenda du compte sélectionné" }));

    await waitFor(() => expect(calls(fetchMock, "/caldav/sources/from-account", "POST")).toHaveLength(1));
    const [, created] = calls(fetchMock, "/caldav/sources/from-account", "POST")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(created.body))).toEqual({
      account_id: "perso",
      calendar_href: TRAVAIL.href,
    });
    expect(calls(fetchMock, "/accounts/perso/caldav/collections")).toHaveLength(1);
  });

  it("change la collection d'une source existante", async () => {
    const fetchMock = stubDaemon();
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 0 },
        { id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } },
      ]),
    );
    window.localStorage.setItem(ICS_KEY, JSON.stringify({ events: {}, synced: {} }));
    renderSettings();

    await waitFor(() => expect(within(section()).getByText("Travail")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Changer de calendrier pour Travail" }));
    fireEvent.click(screen.getByRole("button", { name: "Calendrier de Travail" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Calendrier Collègue" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Calendrier Collègue" }));

    await waitFor(() => expect(calls(fetchMock, "/caldav/sources/travail", "PATCH")).toHaveLength(1));
    const [, patched] = calls(fetchMock, "/caldav/sources/travail", "PATCH")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(patched.body))).toEqual({ calendar_href: COLLEGUE.href });
    expect(calls(fetchMock, "/caldav/sources/travail/collections")).toHaveLength(1);
  });

  it("dit un serveur muet sans inventer de calendrier", async () => {
    const fetchMock = stubDaemon({ collectionStatus: 502 });
    renderSettings();

    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Choisir le calendrier" }));

    await waitFor(() =>
      expect(within(screen.getAllByTestId("caldav-collection-picker")[0]).getByRole("status").textContent).toContain(
        "Calendriers illisibles",
      ),
    );
    expect(screen.queryByRole("button", { name: "Calendrier Travail" })).toBeNull();
    expect(calls(fetchMock, "/caldav/sources", "POST")).toHaveLength(0);
  });
});
