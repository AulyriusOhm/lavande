import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { TODAY_ISO } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

/** Une source ICS abonnée, avec son cache d'événements du jour. */
function seedIcsSource() {
  window.localStorage.setItem(
    "lavande.calendars.v1",
    JSON.stringify([
      { id: "pro", name: "Pro", tone: 0 },
      { id: "exemple-tld", name: "exemple.tld", tone: 1, source: { kind: "ics", url: "https://exemple.tld/cal.ics" } },
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

const openAgenda = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));
};

const rowOf = (title: string) =>
  screen.getAllByTestId("calendar-event").find((row) => row.textContent?.includes(title));

const detail = () => screen.getByRole("dialog", { name: "Détail du rendez-vous" });
const deleteDialog = () => screen.getByRole("alertdialog", { name: "Supprimer ce rendez-vous ?" });

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

describe("Mobile · détail d'un rendez-vous", () => {
  it("ouvre une source ICS en lecture seule, sans Modifier ni Supprimer", async () => {
    seedIcsSource();
    render(<App />);
    await openAgenda();

    fireEvent.click((await waitFor(() => rowOf("Réunion externe")))!);

    const sheet = await screen.findByRole("dialog", { name: "Détail du rendez-vous" }, { timeout: 5000 });
    expect(within(sheet).getByText("exemple.tld")).toBeTruthy();
    expect(within(sheet).getByText("Lecture seule — géré par la source")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Modifier" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Supprimer" })).toBeNull();
  });

  it("ne retire pas un rendez-vous local quand la confirmation est annulée", async () => {
    render(<App />);
    await openAgenda();

    fireEvent.click((await waitFor(() => rowOf("Point maquettes v3")))!);
    const sheet = await screen.findByRole("dialog", { name: "Détail du rendez-vous" }, { timeout: 5000 });

    fireEvent.click(within(sheet).getByRole("button", { name: "Supprimer" }));
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Annuler" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(rowOf("Point maquettes v3")).toBeTruthy();
  });

  it("retire un rendez-vous local après confirmation", async () => {
    render(<App />);
    await openAgenda();

    fireEvent.click((await waitFor(() => rowOf("Point maquettes v3")))!);
    await screen.findByRole("dialog", { name: "Détail du rendez-vous" }, { timeout: 5000 });
    fireEvent.click(within(detail()).getByRole("button", { name: "Supprimer" }));
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Supprimer" }));

    await waitFor(() => expect(rowOf("Point maquettes v3")).toBeUndefined(), { timeout: 5000 });
    expect(await screen.findByText("Rendez-vous supprimé", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("préremplit la feuille d'édition et enregistre la modification", async () => {
    render(<App />);
    await openAgenda();

    fireEvent.click((await waitFor(() => rowOf("Point maquettes v3")))!);
    const sheet = await screen.findByRole("dialog", { name: "Détail du rendez-vous" }, { timeout: 5000 });
    fireEvent.click(within(sheet).getByRole("button", { name: "Modifier" }));

    await waitFor(() => expect(screen.getByText("Modifier le rendez-vous")).toBeTruthy(), { timeout: 5000 });
    expect((screen.getByLabelText("Titre") as HTMLInputElement).value).toBe("Point maquettes v3");
    expect((screen.getByLabelText("Lieu") as HTMLInputElement).value).toBe("Visio · Meet");

    fireEvent.change(screen.getByLabelText("Titre"), { target: { value: "Point maquettes v4" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(rowOf("Point maquettes v4")).toBeTruthy(), { timeout: 5000 });
    expect(rowOf("Point maquettes v3")).toBeUndefined();
    expect(await screen.findByText("Rendez-vous mis à jour", {}, { timeout: 5000 })).toBeTruthy();
  });
});
