import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";

const CALENDARS_KEY = "lavande.calendars.v1";

const GMAIL: ApiAccount = {
  id: "gmail",
  label: "Gmail",
  email: "roman.lanro@gmail.com",
  username: "roman.lanro@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
  smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
  folders: 1,
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

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

let synced: string[] = [];

function stubDaemon() {
  synced = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/carddav/sync")) {
        synced.push(url);
        return reply({ count: 2, skipped: 0 });
      }
      if (url.endsWith("/pgp/keys")) return reply({ keys: [] });
      if (url.endsWith("/accounts")) return reply([GMAIL, OVH]);
      if (url.endsWith("/calendars/caldav/sources")) return reply([]);
      if (url.endsWith("/calendars/google/gmail/calendars")) return reply([{ id: "primary", summary: "Privé" }]);
      return reply([]);
    }),
  );
}

const prefs = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const section = () => document.getElementById("reglages-calendriers") as HTMLElement;

const openSection = (label: string) => {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sections des réglages" })).getByRole("button", { name: label }),
  );
};

const openPerimeter = async (label: string) => {
  const button = await screen.findByRole("button", { name: `Périmètre de synchronisation de ${label}` });
  fireEvent.click(button);
  return button;
};

const panel = (label: string) => screen.getByRole("group", { name: `Périmètre de synchronisation de ${label}` });
const switches = (label: string, domain: "Mails" | "Agenda") =>
  within(panel(label)).getAllByRole("switch", { name: new RegExp(`^${domain}`) });

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

describe("Réglages PC · périmètre par compte", () => {
  it("persiste les domaines coupés d'un compte", async () => {
    stubDaemon();
    renderSettings();

    await openPerimeter("Gmail");

    const mails = switches("Gmail", "Mails")[0];
    const calendar = switches("Gmail", "Agenda")[0];
    expect(mails.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(mails);
    fireEvent.click(calendar);

    await waitFor(() => expect(prefs().perimeters).toMatchObject({ gmail: { mails: false, calendar: false } }));
    expect(switches("Gmail", "Mails")[0].getAttribute("aria-checked")).toBe("false");
  });

  it("n'ouvre qu'un périmètre à la fois et le referme", async () => {
    stubDaemon();
    renderSettings();

    await openPerimeter("Gmail");
    expect(switches("Gmail", "Mails")).toHaveLength(1);

    await openPerimeter("Studio");
    expect(switches("Studio", "Mails")).toHaveLength(1);
    expect(screen.queryByRole("group", { name: "Périmètre de synchronisation de Gmail" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Périmètre de synchronisation de Studio" }));
    expect(screen.queryByRole("group", { name: "Périmètre de synchronisation de Studio" })).toBeNull();
  });

  it("synchronise le carnet du compte à la demande", async () => {
    stubDaemon();
    renderSettings();

    await openPerimeter("Gmail");
    expect(within(panel("Gmail")).queryByRole("switch", { name: /^Contacts/ })).toBeNull();

    fireEvent.click(within(panel("Gmail")).getByRole("button", { name: "Synchroniser les contacts" }));

    await waitFor(() =>
      expect(within(panel("Gmail")).getByText("Carnet synchronisé · 2 contacts")).toBeTruthy(),
    );
    expect(synced).toEqual(["/api/accounts/gmail/carddav/sync"]);
  });

  it("dit honnêtement qu'une synchronisation de carnet a échoué", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/carddav/sync")) return reply({ error: "serveur de contacts : refusé", kind: "carddav" }, 502);
        if (url.endsWith("/pgp/keys")) return reply({ keys: [] });
        if (url.endsWith("/accounts")) return reply([GMAIL, OVH]);
        return reply([]);
      }),
    );
    renderSettings();

    await openPerimeter("Gmail");
    fireEvent.click(within(panel("Gmail")).getByRole("button", { name: "Synchroniser les contacts" }));

    await waitFor(() =>
      expect(within(panel("Gmail")).getByRole("alert").textContent).toContain("Synchronisation impossible"),
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
    renderSettings();

    await openPerimeter("Gmail");
    fireEvent.click(switches("Gmail", "Agenda")[0]);
    openSection("Calendriers");

    await waitFor(() => expect(within(section()).getAllByText("En pause")).toHaveLength(1));
    expect(within(section()).getByText(/agenda du compte coupé/)).toBeTruthy();
  });
});
