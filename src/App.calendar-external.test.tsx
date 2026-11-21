import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ExternalEvent } from "@/lib/api";
import App from "@/App";
import { TODAY_ISO } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const { importIcs } = vi.hoisted(() => ({
  importIcs: vi.fn(async (_input: { url: string; source: string }): Promise<ExternalEvent[]> => []),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, mailApi: { ...actual.mailApi, importIcs } };
});

/** Le démon répond un VEVENT déjà analysé pour la source relue. */
const fetched = (title: string): ExternalEvent => ({
  uid: "b1",
  title,
  date: TODAY_ISO,
  start: "11:00",
  end: "12:00",
  all_day: false,
  timezone: "UTC",
  location: null,
  description: null,
  recurring: false,
  source: "exemple.tld",
});

/** Une source ICS abonnée depuis les réglages mobiles, avec son cache d'événements. */
function seedIcsSource(syncedAt = Date.now()) {
  window.localStorage.setItem(
    "lavande.calendars.v1",
    JSON.stringify([
      { id: "pro", name: "Pro", tone: 0 },
      {
        id: "exemple-tld",
        name: "exemple.tld",
        tone: 1,
        source: { kind: "ics", url: "https://exemple.tld/cal.ics" },
      },
    ]),
  );
  window.localStorage.setItem(
    "lavande.ics.v1",
    JSON.stringify({
      events: {
        "exemple-tld": [
          {
            id: "ics:exemple-tld:b1",
            date: TODAY_ISO,
            start: "11:00",
            end: "12:00",
            title: "Réunion externe",
            external: true,
          },
        ],
      },
      synced: { "exemple-tld": syncedAt },
    }),
  );
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  importIcs.mockReset();
  importIcs.mockImplementation(async () => []);
  window.history.replaceState(null, "", "/");
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
});

describe("Mobile · agenda et sources externes", () => {
  it("affiche l'événement de la source ICS avec son badge et son calendrier", async () => {
    seedIcsSource();

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));

    expect(await screen.findByText("Réunion externe", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTestId("external-badge").textContent).toBe("ICS");
    const row = screen
      .getAllByTestId("calendar-event")
      .find((element) => element.textContent?.includes("Réunion externe"));
    expect(within(row!).getByText("11:00")).toBeTruthy();

    fireEvent.click(row!);
    const sheet = await screen.findByRole("dialog", { name: "Détail du rendez-vous" }, { timeout: 5000 });
    expect(within(sheet).getByText("exemple.tld")).toBeTruthy();
  });

  it("suit une source ajoutée après le montage, sans recharger", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));
    expect(screen.queryByText("Réunion externe")).toBeNull();

    seedIcsSource();
    window.dispatchEvent(new Event("storage"));

    expect(await screen.findByText("Réunion externe", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("relit au montage une source périmée, sans geste de l'utilisateur", async () => {
    importIcs.mockImplementation(async () => [fetched("Réunion relue")]);
    seedIcsSource(0);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));

    expect(await screen.findByText("Réunion relue", {}, { timeout: 5000 })).toBeTruthy();
    expect(importIcs).toHaveBeenCalledTimes(1);
    expect(importIcs.mock.calls[0][0]).toEqual({
      url: "https://exemple.tld/cal.ics",
      source: "exemple.tld",
    });
  });

  it("ne relit pas une source dont le cache est encore frais", async () => {
    seedIcsSource();

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));
    expect(await screen.findByText("Réunion externe", {}, { timeout: 5000 })).toBeTruthy();

    await waitFor(() => expect(importIcs).not.toHaveBeenCalled());
  });
});
