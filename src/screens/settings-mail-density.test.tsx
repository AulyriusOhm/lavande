import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

function enableDecisionLayer() {
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({
      decision: {
        enabled: true,
        endpoint: "https://decision.test/v1/systemone",
        model: "mammoth-1",
        apiKey: "nw-test",
        authHeader: "bearer",
      },
    }),
  );
}

function mount() {
  render(
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
  fireEvent.click(screen.getByRole("button", { name: /^Apparence/ }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages mobile · affichage des mails", () => {
  it("bascule vers le compact et le persiste", async () => {
    mount();

    const cozy = screen.getByRole("button", { name: "Confort" });
    const compact = screen.getByRole("button", { name: "Compact" });
    expect(cozy.getAttribute("aria-pressed")).toBe("true");
    expect(compact.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(compact);

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(compact.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Lignes serrées avec aperçu configurable")).toBeTruthy();

    fireEvent.click(cozy);
    await waitFor(() => expect(stored().mailDensity).toBe("cozy"));
    expect(cozy.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Réglages mobile · aperçu de la liste", () => {
  it("désactive la description IA sans modèle de décision et garde l'extrait", () => {
    mount();

    expect(screen.getByText("Contenu de la troisième ligne")).toBeTruthy();
    const ai = screen.getByRole("button", { name: "Description IA" });
    expect(ai.getAttribute("aria-disabled")).toBe("true");
    expect(ai.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Modèle de décision non configuré : l'aperçu reste l'extrait du message."),
    ).toBeTruthy();
  });

  it("choisit l'extrait et le persiste", async () => {
    enableDecisionLayer();
    mount();

    const excerpt = screen.getByRole("button", { name: "Extrait" });
    expect(excerpt.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(excerpt);

    await waitFor(() => expect(stored().mailPreview).toBe("excerpt"));
    expect(excerpt.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Aperçu du message, comme aujourd'hui.")).toBeTruthy();
    expect(screen.queryByText("Style de description")).toBeNull();
  });

  it("garde la description IA active quand le modèle est configuré", () => {
    enableDecisionLayer();
    mount();

    const ai = screen.getByRole("button", { name: "Description IA" });
    expect(ai.getAttribute("aria-pressed")).toBe("true");
    expect(ai.getAttribute("aria-disabled")).toBe("false");
    expect(screen.getByText("La description du modèle de décision remplace l'aperçu.")).toBeTruthy();
    expect(screen.getByText("Style de description")).toBeTruthy();
  });

  it("bascule le style de description sur Description rapide et le persiste", async () => {
    enableDecisionLayer();
    mount();

    const phrase = screen.getByRole("button", { name: "Description rapide" });
    expect(phrase.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(phrase);

    await waitFor(() => expect(stored().mailPreviewStyle).toBe("phrase"));
    expect(phrase.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText("Phrase de synthèse générée par le LLM configuré dans les Réglages IA."),
    ).toBeTruthy();
  });

  it("montre l'exemple du mail de Marc Delaunay dans les deux styles", () => {
    enableDecisionLayer();
    mount();

    expect(screen.getByText("Exemple — mail de Marc Delaunay")).toBeTruthy();
    expect(screen.getByText("Devis signé — retour de ma part")).toBeTruthy();
    expect(screen.getByText("Réponse attendue · Tâche détectée")).toBeTruthy();
    expect(
      screen.getByText("Avenant signé : confirmer le lancement de la phase 2 lundi."),
    ).toBeTruthy();
  });

  it("applique le style en cliquant une ligne d'exemple", async () => {
    enableDecisionLayer();
    mount();

    const sample = screen.getByRole("button", {
      name: "Description rapide — Avenant signé : confirmer le lancement de la phase 2 lundi.",
    });
    expect(sample.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(sample);

    await waitFor(() => expect(stored().mailPreviewStyle).toBe("phrase"));
    expect(sample.getAttribute("aria-pressed")).toBe("true");
  });
});
