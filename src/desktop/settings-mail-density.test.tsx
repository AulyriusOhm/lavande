import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { DEFAULT_DECISION, NEURALWATT_ENDPOINT } from "@/lib/decision";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const DECISION_READY = {
  ...DEFAULT_DECISION,
  enabled: true,
  endpoint: NEURALWATT_ENDPOINT,
  model: "mammoth-1",
  apiKey: "nw-test",
};

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 204, text: async () => "", json: async () => ({}) }) as unknown as Response),
  );
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

describe("Réglages PC · affichage des mails", () => {
  it("choisit le confort par défaut et bascule vers le compact", async () => {
    renderSettings();

    const cozy = screen.getByRole("button", { name: "Confort" });
    const compact = screen.getByRole("button", { name: "Compact" });
    expect(cozy.getAttribute("aria-pressed")).toBe("true");
    expect(compact.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Carte aérée avec aperçu configurable")).toBeTruthy();

    fireEvent.click(compact);

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(compact.getAttribute("aria-pressed")).toBe("true");
    expect(cozy.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Lignes serrées avec aperçu configurable")).toBeTruthy();

    fireEvent.click(cozy);
    await waitFor(() => expect(stored().mailDensity).toBe("cozy"));
  });
});

describe("Réglages PC · aperçu de la liste", () => {
  it("propose les trois aperçus et désactive la description IA sans modèle", async () => {
    renderSettings();

    const excerpt = screen.getByRole("button", { name: "Extrait" });
    const ai = screen.getByRole("button", { name: "Description IA" });
    const none = screen.getByRole("button", { name: "Aucun" });

    expect(ai.getAttribute("aria-pressed")).toBe("true");
    expect(ai.hasAttribute("disabled")).toBe(true);
    expect(ai.getAttribute("aria-disabled")).toBe("true");
    expect(excerpt.hasAttribute("disabled")).toBe(false);
    expect(none.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText("Modèle de décision non configuré : l'aperçu reste l'extrait du message."),
    ).toBeTruthy();

    fireEvent.click(excerpt);
    await waitFor(() => expect(stored().mailPreview).toBe("excerpt"));
    expect(excerpt.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText("Modèle de décision non configuré : l'aperçu reste l'extrait du message."),
    ).toBeTruthy();
    expect(screen.queryByText("Style de description")).toBeNull();

    fireEvent.click(none);
    await waitFor(() => expect(stored().mailPreview).toBe("none"));
    expect(none.getAttribute("aria-pressed")).toBe("true");
  });

  it("active la description IA quand le modèle est configuré", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ decision: DECISION_READY }));
    renderSettings();

    const ai = screen.getByRole("button", { name: "Description IA" });
    expect(ai.hasAttribute("disabled")).toBe(false);
    expect(ai.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText("La description du modèle de décision remplace l'aperçu."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Extrait" }));
    await waitFor(() => expect(stored().mailPreview).toBe("excerpt"));
    expect(screen.getByText("Aperçu du message, comme aujourd'hui.")).toBeTruthy();
    fireEvent.click(ai);
    await waitFor(() => expect(stored().mailPreview).toBe("ai"));
  });

  it("choisit le style de description et bascule depuis les exemples", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ decision: DECISION_READY }));
    renderSettings();

    expect(screen.getByText("Style de description")).toBeTruthy();
    const signaux = screen.getByRole("button", { name: "Signaux" });
    const phrase = screen.getByRole("button", { name: "Description rapide" });
    expect(signaux.getAttribute("aria-pressed")).toBe("true");
    expect(phrase.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByText("Étiquettes courtes : urgence, réponse attendue, code de vérification…"),
    ).toBeTruthy();

    expect(screen.getByText("Exemple — mail de Marc Delaunay")).toBeTruthy();
    expect(screen.getByText("Devis signé — retour de ma part")).toBeTruthy();

    const exemples = screen.getAllByRole("button", { name: /Réponse attendue · Tâche détectée/ });
    expect(exemples).toHaveLength(1);
    expect(exemples[0].getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(phrase);
    await waitFor(() => expect(stored().mailPreviewStyle).toBe("phrase"));
    expect(phrase.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText("Phrase de synthèse générée par le modèle de décision ou le LLM."),
    ).toBeTruthy();

    const phraseRow = screen.getByRole("button", {
      name: /Avenant signé : confirmer le lancement de la phase 2 lundi\./,
    });
    expect(phraseRow.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Réponse attendue · Tâche détectée/ }));
    await waitFor(() => expect(stored().mailPreviewStyle).toBe("signaux"));
  });
});
