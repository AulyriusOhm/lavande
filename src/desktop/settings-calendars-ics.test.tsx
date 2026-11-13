import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { CalendarDef } from "@/lib/calendars";
import type { CalendarEvent } from "@/lib/calendar";

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";
const URL_ICS = "https://exemple.tld/calendrier.ics";

type IcsState = { events: Record<string, CalendarEvent[]>; synced: Record<string, number> };

const storedCalendars = (): CalendarDef[] => JSON.parse(window.localStorage.getItem(CALENDARS_KEY) ?? "null") as CalendarDef[];
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
    source: "Google",
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
    source: "Google",
  },
];

function stubDaemon(payload: unknown = externalEvents, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/calendars/ics")) {
      return {
        ok: status < 400,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const icsCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/calendars/ics"));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
});

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

const section = () => document.getElementById("reglages-calendriers") as HTMLElement;

const addFromUrl = async (url: string, name?: string) => {
  if (name) fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("URL du calendrier ICS"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Abonner" }));
};

const addFromFile = async (file: File, name?: string) => {
  if (name) fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: name } });
  fireEvent.change(screen.getByTestId("ics-file-input"), { target: { files: [file] } });
};

describe("Réglages · sources ICS", () => {
  it("abonne un calendrier par URL et range ses événements", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await addFromUrl(URL_ICS, "Google");

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    const calls = icsCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/calendars/ics");
    expect(init.body).toBe(JSON.stringify({ url: URL_ICS, source: "Google" }));
    expect(storedCalendars()[3]).toEqual({
      id: "google",
      name: "Google",
      tone: 0,
      source: { kind: "ics", url: URL_ICS },
    });
    expect(storedIcs().events.google).toEqual([
      {
        id: "ics:google:abc-123",
        date: "2026-03-15",
        start: "09:00",
        end: "10:00",
        title: "Réunion équipe",
        location: "Bureau",
        calendar: "Google",
        external: true,
      },
      {
        id: "ics:google:jour-6",
        date: "2026-03-20",
        start: "",
        end: "",
        title: "Journée off",
        calendar: "Google",
        external: true,
        recurring: true,
      },
    ]);
    expect(within(section()).getByText("Google")).toBeTruthy();
    expect(within(section()).getByText("ICS")).toBeTruthy();
    expect(within(section()).getByText(URL_ICS)).toBeTruthy();
    expect(within(section()).getByText(/· 2 événements/)).toBeTruthy();
  });

  it("déduit le nom de l'URL quand le champ est vide", async () => {
    stubDaemon();
    renderSettings();

    await addFromUrl(URL_ICS);

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    expect(storedCalendars()[3].name).toBe("exemple.tld");
  });

  it("importe un fichier .ics et garde les événements analysés", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    const content = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    await addFromFile(new File([content], "vacances.ics", { type: "text/calendar" }), "Vacances");

    await waitFor(() => expect(storedCalendars()).toHaveLength(4));
    const calls = icsCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ content, source: "Vacances" }));
    expect(storedCalendars()[3]).toEqual({
      id: "vacances",
      name: "Vacances",
      tone: 0,
      source: { kind: "ics" },
    });
    expect(storedIcs().events.vacances).toHaveLength(2);
    expect(within(section()).getByText("fichier importé")).toBeTruthy();
  });

  it("refuse une URL invalide sans appeler le démon", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await addFromUrl("pas une url", "Cassé");

    expect(screen.getByRole("alert").textContent).toBe("URL invalide");
    expect(icsCalls(fetchMock)).toHaveLength(0);
    expect(window.localStorage.getItem(CALENDARS_KEY)).toBeNull();
  });

  it("remonte l'erreur du démon et n'ajoute rien", async () => {
    stubDaemon({ error: "calendrier vide", kind: "calendar" }, 400);
    renderSettings();

    await addFromUrl(URL_ICS, "Google");

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("calendrier vide"));
    expect(window.localStorage.getItem(CALENDARS_KEY)).toBeNull();
    expect(window.localStorage.getItem(ICS_KEY)).toBeNull();
  });

  it("refuse un nom déjà pris", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await addFromUrl(URL_ICS, " pro ");

    expect(screen.getByRole("alert").textContent).toBe("Calendrier déjà présent · pro");
    expect(icsCalls(fetchMock)).toHaveLength(0);
  });

  it("renomme puis supprime une source ICS en retirant ses événements", async () => {
    stubDaemon();
    renderSettings();

    await addFromUrl(URL_ICS, "Google");
    await waitFor(() => expect(storedIcs().events.google).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Renommer le calendrier Google" }));
    fireEvent.change(screen.getByLabelText("Nouveau nom pour Google"), { target: { value: "Travail" } });
    fireEvent.click(screen.getByRole("button", { name: "Valider" }));

    expect(storedCalendars()[3]).toEqual({
      id: "google",
      name: "Travail",
      tone: 0,
      source: { kind: "ics", url: URL_ICS },
    });

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le calendrier Travail" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    expect(storedCalendars().map((entry) => entry.name)).toEqual(["Pro", "Perso", "Clients"]);
    expect(storedIcs().events.google).toBeUndefined();
    expect(storedIcs().synced.google).toBeUndefined();
    expect(within(section()).queryByText("Travail")).toBeNull();
  });

  it("garde un calendrier local sans source et le type « local »", () => {
    renderSettings();

    fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: "Famille" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));

    expect(storedCalendars()[3]).toEqual({ id: "famille", name: "Famille", tone: 0 });
    expect(within(section()).getAllByText("local")).toHaveLength(4);
  });
});

describe("Réglages · relecture d'une source", () => {
  it("relit un abonnement à la demande et met son cache à jour", async () => {
    const fetchMock = stubDaemon();
    renderSettings();

    await addFromUrl(URL_ICS, "Google");
    await waitFor(() => expect(storedIcs().events.google).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Actualiser le calendrier Google" }));

    await waitFor(() => expect(icsCalls(fetchMock)).toHaveLength(2));
    expect(within(section()).getByText(/· 2 événements/)).toBeTruthy();
    expect(storedIcs().synced.google).toBeGreaterThan(0);
  });

  it("ne propose pas de relecture pour un calendrier local ni pour un fichier importé", async () => {
    stubDaemon();
    renderSettings();

    fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: "Famille" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));

    await addFromFile(new File(["BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"], "vacances.ics"), "Vacances");
    await waitFor(() => expect(storedCalendars()).toHaveLength(5));

    expect(screen.queryByRole("button", { name: "Actualiser le calendrier Famille" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actualiser le calendrier Vacances" })).toBeNull();
  });
});
