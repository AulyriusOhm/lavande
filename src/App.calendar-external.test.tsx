import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "@/App";
import { TODAY_ISO } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

/** Une source ICS abonnée depuis les réglages mobiles, avec son cache d'événements. */
function seedIcsSource() {
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
      synced: { "exemple-tld": Date.now() },
    }),
  );
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
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
    expect(screen.getByText("exemple.tld")).toBeTruthy();
    expect(screen.getByText("11:00")).toBeTruthy();
  });

  it("suit une source ajoutée après le montage, sans recharger", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));
    expect(screen.queryByText("Réunion externe")).toBeNull();

    seedIcsSource();
    window.dispatchEvent(new Event("storage"));

    expect(await screen.findByText("Réunion externe", {}, { timeout: 5000 })).toBeTruthy();
  });
});
