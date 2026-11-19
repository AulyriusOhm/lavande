import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const teamContext = () => (stored().teamContext ?? {}) as Record<string, Record<string, unknown>>;

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

const open = () => fireEvent.click(screen.getByRole("button", { name: /^Moi et mon équipe/ }));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
});

describe("Réglages mobile · moi et mon équipe", () => {
  it("ouvre la fiche depuis la liste des groupes", () => {
    mount();

    expect(screen.queryByLabelText("Votre nom")).toBeNull();

    open();

    expect(screen.getAllByRole("heading", { name: "Moi et mon équipe" }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Votre nom")).toBeTruthy();
    expect(screen.getByLabelText("Votre rôle")).toBeTruthy();
    expect(screen.getByLabelText("Contexte de la boîte")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Boîte de la fiche" })).toBeTruthy();
  });

  it("enregistre l'identité, le rôle et le contexte de la boîte", async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText("Votre nom"), { target: { value: "Roman FELDEN" } });
    await waitFor(() => expect(teamContext().perso).toMatchObject({ identity: "Roman FELDEN" }));

    fireEvent.change(screen.getByLabelText("Votre rôle"), { target: { value: "DSI" } });
    fireEvent.change(screen.getByLabelText("Contexte de la boîte"), {
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
    mount();
    open();

    expect(screen.queryByLabelText("Nom du membre 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ajouter un membre/ }));
    fireEvent.change(screen.getByLabelText("Nom du membre 1"), { target: { value: "Camille" } });
    fireEvent.change(screen.getByLabelText("Périmètre du membre 1"), { target: { value: "Ateliers" } });

    await waitFor(() => expect(teamContext().perso?.members).toEqual([{ name: "Camille", scope: "Ateliers" }]));

    fireEvent.click(screen.getByRole("button", { name: "Retirer le membre 1" }));

    await waitFor(() => expect(teamContext().perso?.members).toEqual([]));
    expect(screen.queryByLabelText("Nom du membre 1")).toBeNull();
  });

  it("garde une fiche distincte par boîte", async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText("Votre nom"), { target: { value: "Roman perso" } });
    await waitFor(() => expect(teamContext().perso).toMatchObject({ identity: "Roman perso" }));

    const chips = screen.getByRole("group", { name: "Boîte de la fiche" });
    fireEvent.click(within(chips).getByRole("button", { name: "Studio" }));

    expect((screen.getByLabelText("Votre nom") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Votre nom"), { target: { value: "Roman studio" } });

    await waitFor(() => expect(teamContext().pro).toMatchObject({ identity: "Roman studio" }));
    expect(teamContext().perso).toMatchObject({ identity: "Roman perso" });
  });
});
