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
const storedDecision = () => (stored().decision ?? {}) as Record<string, unknown>;

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
        descriptionSource: "decision",
        descriptionModel: "nw-flash",
      },
    }),
  );
}

function mount(group: "ia" | "apparence" = "ia") {
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
  fireEvent.click(
    screen.getByRole("button", { name: group === "ia" ? /^IA/ : /^Apparence/ }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages mobile · description des mails", () => {
  it("part du modèle de décision et montre son modèle de description", () => {
    enableDecisionLayer();
    mount();

    expect(screen.getByText("Description des mails")).toBeTruthy();
    expect(screen.getByText("Source de la phrase de résumé")).toBeTruthy();

    const source = screen.getByRole("button", { name: "Modèle de décision" });
    expect(source.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText("Phrase rédigée par le modèle de chat du provider de décision."),
    ).toBeTruthy();

    const input = screen.getByLabelText("Modèle de description") as HTMLInputElement;
    expect(input.value).toBe("nw-flash");
    expect(input.getAttribute("placeholder")).toBe("nw-flash");
    expect(screen.getByText("Vide = signaux uniquement. nw-flash pour NeuralWatt.")).toBeTruthy();
  });

  it("bascule la source sur LLM, masque le modèle et le persiste", async () => {
    enableDecisionLayer();
    mount();

    const llm = screen.getByRole("button", { name: "LLM" });
    expect(llm.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(llm);

    await waitFor(() => expect(storedDecision().descriptionSource).toBe("llm"));
    expect(llm.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText("Phrase rédigée par le LLM conversationnel configuré dans les Réglages IA."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Modèle de description")).toBeNull();
    expect(
      screen.getByText("Aucun modèle supplémentaire : la phrase utilise le LLM configuré ci-dessus."),
    ).toBeTruthy();
  });

  it("revient au modèle de décision et retrouve le champ", async () => {
    enableDecisionLayer();
    mount();

    fireEvent.click(screen.getByRole("button", { name: "LLM" }));
    await waitFor(() => expect(storedDecision().descriptionSource).toBe("llm"));

    fireEvent.click(screen.getByRole("button", { name: "Modèle de décision" }));

    await waitFor(() => expect(storedDecision().descriptionSource).toBe("decision"));
    expect(screen.getByLabelText("Modèle de description")).toBeTruthy();
  });

  it("enregistre le modèle de description saisi", async () => {
    enableDecisionLayer();
    mount();

    const input = screen.getByLabelText("Modèle de description");
    fireEvent.change(input, { target: { value: "nw-mini" } });

    await waitFor(() => expect(storedDecision().descriptionModel).toBe("nw-mini"));
    expect((input as HTMLInputElement).value).toBe("nw-mini");
  });

  it("accepte un modèle vide pour ne garder que les signaux", async () => {
    enableDecisionLayer();
    mount();

    fireEvent.change(screen.getByLabelText("Modèle de description"), { target: { value: "" } });

    await waitFor(() => expect(storedDecision().descriptionModel).toBe(""));
  });
});

describe("Réglages mobile · exemple de style de description", () => {
  it("étiquette la ligne d'exemple « Description rapide »", () => {
    enableDecisionLayer();
    mount("apparence");

    const sample = screen.getByRole("button", {
      name: "Description rapide — Avenant signé : confirmer le lancement de la phase 2 lundi.",
    });
    expect(sample.textContent).toContain("Description rapide");
    expect(screen.getByRole("button", { name: "Description rapide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Signaux" })).toBeTruthy();
  });
});
