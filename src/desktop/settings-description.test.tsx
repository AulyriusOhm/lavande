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

const storedDecision = () => (stored().decision ?? {}) as Record<string, unknown>;

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
  it("choisit la source de la description et la persiste", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ decision: DECISION_READY }));
    renderSettings();

    expect(screen.getByText("Description des mails")).toBeTruthy();
    expect(screen.getByText("Source de la description")).toBeTruthy();

    const decisionSource = screen.getByRole("button", { name: "Modèle de décision" });
    const llmSource = screen.getByRole("button", { name: "LLM" });
    expect(decisionSource.getAttribute("aria-pressed")).toBe("true");
    expect(llmSource.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByText("La phrase est rédigée par le modèle de chat du provider de décision."),
    ).toBeTruthy();

    fireEvent.click(llmSource);

    await waitFor(() => expect(storedDecision().descriptionSource).toBe("llm"));
    expect(llmSource.getAttribute("aria-pressed")).toBe("true");
    expect(decisionSource.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByText(
        "La phrase est rédigée par le LLM conversationnel (Copilot, OpenAI ou custom) configuré dans les Réglages IA.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Modèle de description")).toBeNull();
    expect(
      screen.getByText("Aucun modèle supplémentaire : la phrase utilise le LLM configuré ci-dessus."),
    ).toBeTruthy();

    fireEvent.click(decisionSource);
    await waitFor(() => expect(storedDecision().descriptionSource).toBe("decision"));
    expect(screen.getByLabelText("Modèle de description")).toBeTruthy();
  });

  it("édite le modèle de description et le persiste", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ decision: DECISION_READY }));
    renderSettings();

    expect(screen.getByText("Modèle de description")).toBeTruthy();
    const input = screen.getByLabelText("Modèle de description") as HTMLInputElement;
    expect(input.value).toBe(DECISION_READY.descriptionModel);
    expect(input.getAttribute("placeholder")).toBe("nw-flash");
    expect(
      screen.getByText(
        "Modèle de chat qui rédige la phrase. Vide = signaux uniquement. nw-flash pour NeuralWatt.",
      ),
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: "nw-flash" } });

    await waitFor(() => expect(storedDecision().descriptionModel).toBe("nw-flash"));

    fireEvent.change(screen.getByLabelText("Modèle de description"), { target: { value: "" } });
    await waitFor(() => expect(storedDecision().descriptionModel).toBe(""));
  });

  it("nomme l'exemple d'aperçu « Description rapide » dans l'Apparence", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ decision: DECISION_READY }));
    renderSettings();

    expect(screen.getByText("Exemple — mail de Marc Delaunay")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Description rapideAvenant signé/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /SignauxRéponse attendue · Tâche détectée/ })).toBeTruthy();
  });
});
