import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopSearch } from "@/desktop/search";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const RECENT_KEY = "lavande.recent-searches";

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return render(<DesktopSearch open onClose={() => {}} />, { wrapper });
}

const input = () => screen.getByLabelText("Rechercher dans tous les comptes");
const status = () => screen.getByRole("status").textContent ?? "";

function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("palette PC · historique et contacts", () => {
  it("lit l'historique partagé et le vide sur place", async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["facture"]));
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Tout effacer" }));

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(RECENT_KEY)!)).toEqual([]));
    expect(screen.queryByRole("button", { name: "facture" })).toBeNull();
  });

  it("liste les expéditeurs de la boîte en démo", async () => {
    mount();

    await waitFor(() => expect(screen.getByText("Marc Delaunay")).toBeTruthy());
  });

  it("remplit le champ depuis une recherche récente", () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["facture"]));
    mount();

    fireEvent.click(screen.getByRole("button", { name: "facture" }));

    expect((input() as HTMLInputElement).value).toBe("facture");
  });

  it("garde les recherches récentes en une seule entrée par requête", async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["facture", "camille"]));
    mount();

    fireEvent.click(screen.getByRole("button", { name: "camille" }));
    await waitFor(() => expect(status()).toMatch(/résultats? pour « camille »$/));

    fireEvent.keyDown(screen.getByTestId("desktop-search"), { key: "Enter" });

    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(RECENT_KEY)!)).toEqual(["camille", "facture"]),
    );
  });
});

describe("palette PC · résultats", () => {
  it("surligne les mots du texte libre dans l'objet et l'aperçu", async () => {
    mount();
    type("maquettes");

    await waitFor(() => expect(document.querySelectorAll("mark").length).toBeGreaterThan(0));
    const marks = Array.from(document.querySelectorAll("mark")).map((mark) => mark.textContent);
    expect(marks.some((text) => text?.toLowerCase() === "maquettes")).toBe(true);
  });

  it("compte les résultats et rappelle les opérateurs", async () => {
    mount();

    expect(screen.getByText(/Opérateurs : from: to: subject: in:/)).toBeTruthy();

    type("maquettes");
    await waitFor(() => expect(status()).toContain("pour « maquettes »"));
    expect(status()).toMatch(/^\d+ résultats? pour « maquettes »$/);
  });

  it("applique un opérateur de la grammaire", async () => {
    mount();
    type("from:camille");

    await waitFor(() => expect(document.querySelectorAll("[data-selected]").length).toBeGreaterThan(0));
    expect(status()).toContain("from:camille");
  });
});
