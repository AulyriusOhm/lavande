import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { DEFAULT_DECISION, NEURALWATT_ENDPOINT } from "@/lib/decision";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

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

describe("Réglages PC · description des mails", () => {
  it("n'expose plus de source ni de modèle de description, même avec des prefs héritées", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        decision: { ...DECISION_READY, descriptionSource: "decision", descriptionModel: "nw-flash" },
      }),
    );
    renderSettings();

    expect(screen.queryByText("Description des mails")).toBeNull();
    expect(screen.queryByText("Source de la description")).toBeNull();
    expect(screen.queryByLabelText("Modèle de description")).toBeNull();
    expect(screen.queryByRole("button", { name: "Modèle de décision" })).toBeNull();
  });

  it("annonce que la Description rapide vient du LLM des Réglages IA", () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ decision: DECISION_READY }));
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Description rapide" }));
    expect(
      screen.getByText("Phrase de synthèse générée par le LLM configuré dans les Réglages IA."),
    ).toBeTruthy();
  });

  it("nomme l'exemple d'aperçu « Description rapide » dans l'Apparence", () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ decision: DECISION_READY }));
    renderSettings();

    expect(screen.getByText("Exemple — mail de Marc Delaunay")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Description rapideAvenant signé/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /SignauxRéponse attendue · Tâche détectée/ })).toBeTruthy();
  });
});