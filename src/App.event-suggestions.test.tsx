import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "@/App";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const STORAGE_KEY = "lavande.sync.v1";

/** Injecte une suggestion de RDV en attente dans l'état de synchro persisté. */
function seedEventSuggestion(proposal: string): boolean {
  const state = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
    docs: Record<string, unknown>;
  } | null;
  if (!state) return false;
  state.docs["suggestion:event:atelier"] = {
    id: "event:atelier",
    kind: "suggestion",
    v: 1,
    raw: {
      status: "pending",
      kind: "event",
      mailId: "1",
      account: "perso",
      from: "Camille Rousseau",
      subject: "Maquettes mobiles — version 3",
      proposal,
      due: "",
      dueTone: "none",
      tone: 0,
      description: "Rendez-vous IA · visio",
      date: "2026-11-20",
      start: "10:00",
      end: "10:30",
      location: "Visio",
      timestamp: Date.now(),
    },
    fields: {},
    readOnly: false,
    updatedAt: new Date(0).toISOString(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return true;
}

const titleInput = () => screen.getByLabelText("Titre") as HTMLInputElement;
const locationInput = () => screen.getByLabelText("Lieu") as HTMLInputElement;
const dateInput = () => screen.getByLabelText("Choisir une date") as HTMLInputElement;

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

describe("Mobile · accepter une suggestion de RDV ouvre la feuille préremplie", () => {
  it("préremplit titre, jour, heures et lieu depuis la suggestion", async () => {
    const first = render(<App />);
    await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull(), { timeout: 5000 });
    first.unmount();

    expect(seedEventSuggestion("Atelier budget")).toBe(true);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));

    const card = await screen.findByTestId("event-suggestion-card", {}, { timeout: 5000 });
    expect(card.textContent).toContain("Atelier budget");
    fireEvent.click(screen.getByRole("button", { name: "Accepter : Atelier budget" }));

    await waitFor(() => expect(titleInput().value).toBe("Atelier budget"), { timeout: 5000 });
    expect(screen.getByText("Nouveau rendez-vous")).toBeTruthy();
    expect(dateInput().value).toBe("2026-11-20");
    expect(locationInput().value).toBe("Visio");
    expect(screen.getByText("→ 10:30")).toBeTruthy();
  });

  it("oublie le brouillon une fois la feuille fermée", async () => {
    const first = render(<App />);
    await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull(), { timeout: 5000 });
    first.unmount();
    seedEventSuggestion("Atelier budget");

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Accepter : Atelier budget" }, { timeout: 5000 }));
    await waitFor(() => expect(titleInput().value).toBe("Atelier budget"), { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(screen.queryByLabelText("Titre")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Nouveau rendez-vous" }));

    await waitFor(() => expect(screen.getByLabelText("Titre")).toBeTruthy());
    expect(titleInput().value).toBe("");
    expect(locationInput().value).toBe("");
  });

  it("ouvre la feuille vide depuis le raccourci du dock", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }, { timeout: 5000 }));

    fireEvent.click(screen.getByRole("button", { name: "Nouveau rendez-vous" }));

    await waitFor(() => expect(screen.getByLabelText("Titre")).toBeTruthy(), { timeout: 5000 });
    expect(titleInput().value).toBe("");
    expect(locationInput().value).toBe("");
  });
});
