import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { CalendarDef } from "@/lib/calendars";

const KEY = "lavande.calendars.v1";

const stored = (): CalendarDef[] => JSON.parse(window.localStorage.getItem(KEY) ?? "null") as CalendarDef[];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 204, text: async () => "", json: async () => ({}) }) as unknown as Response),
  );
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

describe("Réglages · section calendriers", () => {
  it("propose la section dans le sommaire", () => {
    renderSettings();

    expect(screen.getAllByText("Calendriers").length).toBeGreaterThan(1);
    expect(section()).toBeTruthy();
  });

  it("liste les calendriers par défaut sans les enregistrer", () => {
    renderSettings();

    expect(within(section()).getByText("Pro")).toBeTruthy();
    expect(within(section()).getByText("Perso")).toBeTruthy();
    expect(within(section()).getByText("Clients")).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("ajoute un calendrier avec le ton choisi", () => {
    renderSettings();

    fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: "Famille" } });
    fireEvent.click(screen.getByRole("button", { name: "Ton du nouveau calendrier · ton 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));

    expect(stored()).toEqual([
      { id: "pro", name: "Pro", tone: 0 },
      { id: "perso", name: "Perso", tone: 2 },
      { id: "clients", name: "Clients", tone: 3 },
      { id: "famille", name: "Famille", tone: 4 },
    ]);
    expect(within(section()).getByText("Famille")).toBeTruthy();
    expect((screen.getByLabelText("Nom du nouveau calendrier") as HTMLInputElement).value).toBe("");
  });

  it("dédoublonne l'identifiant d'un calendrier homonyme", () => {
    window.localStorage.setItem(KEY, JSON.stringify([{ id: "famille", name: "Famille", tone: 1 }]));
    renderSettings();

    fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: "Famille 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));

    expect(stored().map((entry) => entry.id)).toEqual(["famille", "famille-2"]);
  });

  it("refuse un nom déjà pris", () => {
    renderSettings();

    fireEvent.change(screen.getByLabelText("Nom du nouveau calendrier"), { target: { value: " pro " } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(within(section()).getAllByText("Pro")).toHaveLength(1);
  });

  it("renomme un calendrier", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Renommer le calendrier Perso" }));

    const field = screen.getByLabelText("Nouveau nom pour Perso") as HTMLInputElement;
    expect(field.value).toBe("Perso");
    fireEvent.change(field, { target: { value: "Famille" } });
    fireEvent.click(screen.getByRole("button", { name: "Valider" }));

    expect(stored().map((entry) => entry.name)).toEqual(["Pro", "Famille", "Clients"]);
    expect(within(section()).queryByText("Perso")).toBeNull();
    expect(within(section()).getByText("Famille")).toBeTruthy();
  });

  it("refuse de renommer vers un nom déjà pris", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Renommer le calendrier Perso" }));
    fireEvent.change(screen.getByLabelText("Nouveau nom pour Perso"), { target: { value: " pro " } });
    fireEvent.click(screen.getByRole("button", { name: "Valider" }));

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(screen.getByLabelText("Nouveau nom pour Perso")).toBeTruthy();
  });

  it("valide un renommage à la touche Entrée et l'annule avec Échap", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Renommer le calendrier Pro" }));
    fireEvent.keyDown(screen.getByLabelText("Nouveau nom pour Pro"), { key: "Escape" });
    expect(screen.queryByLabelText("Nouveau nom pour Pro")).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Renommer le calendrier Pro" }));
    fireEvent.change(screen.getByLabelText("Nouveau nom pour Pro"), { target: { value: "Bureau" } });
    fireEvent.keyDown(screen.getByLabelText("Nouveau nom pour Pro"), { key: "Enter" });

    expect(stored()[0]).toEqual({ id: "pro", name: "Bureau", tone: 0 });
  });

  it("change le ton d'un calendrier", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Ton de Clients · ton 2" }));

    expect(stored()).toEqual([
      { id: "pro", name: "Pro", tone: 0 },
      { id: "perso", name: "Perso", tone: 2 },
      { id: "clients", name: "Clients", tone: 1 },
    ]);
    expect(screen.getByRole("button", { name: "Ton de Clients · ton 2" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("supprime un calendrier après confirmation", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le calendrier Clients" }));

    expect(within(section()).getByText("Supprimer ?")).toBeTruthy();
    expect(within(section()).getByText("Clients")).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    expect(stored().map((entry) => entry.name)).toEqual(["Pro", "Perso"]);
    expect(within(section()).queryByText("Clients")).toBeNull();
  });

  it("annule une suppression", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le calendrier Clients" }));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

    expect(within(section()).queryByText("Supprimer ?")).toBeNull();
    expect(within(section()).getByText("Clients")).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("reprend la liste enregistrée au démarrage", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 1 },
        { id: "famille", name: "Famille", tone: 4 },
      ]),
    );
    renderSettings();

    expect(within(section()).getByText("Famille")).toBeTruthy();
    expect(within(section()).queryByText("Clients")).toBeNull();
    expect(screen.getByRole("button", { name: "Ton de Pro · ton 2" }).getAttribute("aria-pressed")).toBe("true");
  });
});
