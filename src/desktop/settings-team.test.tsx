import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const teamContext = () => (stored().teamContext ?? {}) as Record<string, Record<string, unknown>>;

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

function openSection(label: string) {
  const nav = screen.getByRole("navigation", { name: "Sections des réglages" });
  fireEvent.click(within(nav).getByRole("button", { name: label }));
}

const panel = () => document.getElementById("reglages-moi-equipe") as HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  Element.prototype.scrollIntoView = () => {};
});

describe("Réglages · moi et mon équipe", () => {
  it("atteint la fiche depuis le sommaire", () => {
    renderSettings();

    const nav = screen.getByRole("navigation", { name: "Sections des réglages" });
    const entry = within(nav).getByRole("button", { name: "Moi et mon équipe" });
    expect(entry.getAttribute("aria-current")).toBe("false");

    fireEvent.click(entry);

    expect(entry.getAttribute("aria-current")).toBe("true");
    expect(panel()).toBeTruthy();
    expect(within(panel()).getByText("identité, rôle, équipe par boîte")).toBeTruthy();
  });

  it("enregistre l'identité, le rôle et le contexte de la boîte", async () => {
    renderSettings();
    openSection("Moi et mon équipe");

    const fiche = within(panel());
    fireEvent.change(fiche.getByLabelText("Votre nom"), { target: { value: "Roman FELDEN" } });
    await waitFor(() => expect(teamContext().perso).toMatchObject({ identity: "Roman FELDEN" }));

    fireEvent.change(fiche.getByLabelText("Votre rôle"), { target: { value: "DSI" } });
    await waitFor(() => expect(teamContext().perso).toMatchObject({ role: "DSI" }));

    fireEvent.change(fiche.getByLabelText("Contexte de la boîte"), {
      target: { value: "Je suis Roman FELDEN, DSI de l'ENSAG." },
    });
    await waitFor(() =>
      expect(teamContext().perso).toMatchObject({
        identity: "Roman FELDEN",
        role: "DSI",
        context: "Je suis Roman FELDEN, DSI de l'ENSAG.",
      }),
    );
  });

  it("ajoute, renseigne puis retire un membre", async () => {
    renderSettings();
    openSection("Moi et mon équipe");

    const fiche = within(panel());
    expect(fiche.queryByLabelText("Nom du membre 1")).toBeNull();

    fireEvent.click(fiche.getByRole("button", { name: /Ajouter un membre/ }));
    fireEvent.change(fiche.getByLabelText("Nom du membre 1"), { target: { value: "Camille" } });
    fireEvent.change(fiche.getByLabelText("Périmètre du membre 1"), { target: { value: "Ateliers" } });

    await waitFor(() =>
      expect(teamContext().perso?.members).toEqual([{ name: "Camille", scope: "Ateliers" }]),
    );

    fireEvent.click(fiche.getByRole("button", { name: "Retirer le membre 1" }));

    await waitFor(() => expect(teamContext().perso?.members).toEqual([]));
    expect(fiche.queryByLabelText("Nom du membre 1")).toBeNull();
  });

  it("garde une fiche distincte par boîte", async () => {
    renderSettings();
    openSection("Moi et mon équipe");

    const fiche = within(panel());
    fireEvent.change(fiche.getByLabelText("Votre nom"), { target: { value: "Roman perso" } });
    await waitFor(() => expect(teamContext().perso).toMatchObject({ identity: "Roman perso" }));

    fireEvent.click(fiche.getByRole("button", { name: "Studio" }));

    expect((fiche.getByLabelText("Votre nom") as HTMLInputElement).value).toBe("");
    fireEvent.change(fiche.getByLabelText("Votre nom"), { target: { value: "Roman studio" } });

    await waitFor(() => expect(teamContext().pro).toMatchObject({ identity: "Roman studio" }));
    expect(teamContext().perso).toMatchObject({ identity: "Roman perso" });
  });
});
