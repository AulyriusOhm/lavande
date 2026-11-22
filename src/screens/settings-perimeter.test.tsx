import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";

const GMAIL: ApiAccount = {
  id: "gmail",
  label: "Gmail",
  email: "roman@gmail.com",
  username: "roman@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
  smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
  folders: 1,
};

const storedCalendars = (): CalendarDef[] =>
  JSON.parse(window.localStorage.getItem(CALENDARS_KEY) ?? "null") as CalendarDef[];
const prefs = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/carddav/sync")) return reply({ count: 3, skipped: 1 });
      if (url.endsWith("/accounts")) return reply([GMAIL]);
      if (url.endsWith("/calendars/caldav/sources")) return reply([]);
      if (url.endsWith("/calendars/google/gmail/calendars")) return reply([{ id: "primary", summary: "Privé" }]);
      return reply([]);
    }),
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
});

function mount() {
  return render(
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
}

describe("Réglages mobile · périmètre par compte", () => {
  it("persiste les mails et l'agenda coupés d'un compte", async () => {
    stubDaemon();
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Comptes/ }));

    await waitFor(() => expect(screen.getByRole("switch", { name: /^Agenda/ })).toBeTruthy());
    expect(screen.getByRole("switch", { name: /^Mails/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("switch", { name: /^Agenda/ }));
    fireEvent.click(screen.getByRole("switch", { name: /^Mails/ }));

    await waitFor(() => expect(prefs().perimeters).toMatchObject({ gmail: { calendar: false, mails: false } }));
    expect(screen.getByRole("switch", { name: /^Agenda/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("synchronise le carnet du compte à la demande", async () => {
    stubDaemon();
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Comptes/ }));

    const button = await screen.findByRole("button", { name: "Synchroniser les contacts" });
    expect(screen.queryByRole("switch", { name: /^Contacts/ })).toBeNull();

    fireEvent.click(button);

    await waitFor(() =>
      expect(
        screen.getByText("Carnet synchronisé · 3 contacts · 1 carte illisible ignorée"),
      ).toBeTruthy(),
    );
  });

  it("met en pause les calendriers Google du compte dont l'agenda est coupé", async () => {
    stubDaemon();
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 0 },
        { id: "prive", name: "Privé", tone: 1, source: { kind: "google", accountId: "gmail", calendarId: "primary" } },
      ]),
    );
    window.localStorage.setItem(
      ICS_KEY,
      JSON.stringify({
        events: {
          prive: [
            {
              id: "google:prive:g1",
              date: "2026-03-15",
              start: "09:00",
              end: "10:00",
              title: "Point",
              calendar: "Privé",
              external: true,
            },
          ],
        },
        synced: { prive: Date.now() },
      }),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Comptes/ }));

    await waitFor(() => expect(screen.getByRole("switch", { name: /^Agenda/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("switch", { name: /^Agenda/ }));

    fireEvent.click(screen.getByRole("button", { name: "Retour aux réglages" }));
    fireEvent.click(screen.getByRole("button", { name: /^Synchronisation/ }));

    const paused = screen.getByTestId("calendar-source-prive");
    await waitFor(() => expect(within(paused).getByText("En pause")).toBeTruthy());
    expect(within(paused).getByText(/agenda du compte coupé/)).toBeTruthy();
    expect(storedCalendars()).toHaveLength(2);
    expect(within(screen.getByTestId("calendar-source-pro")).queryByText("En pause")).toBeNull();
  });
});
