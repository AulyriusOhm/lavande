import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

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
  it("n'expose plus de source ni de modèle de description, même avec des prefs héritées", () => {
    enableDecisionLayer();
    mount();

    expect(screen.queryByText("Description des mails")).toBeNull();
    expect(screen.queryByText("Source de la phrase de résumé")).toBeNull();
    expect(screen.queryByLabelText("Modèle de description")).toBeNull();
    expect(screen.queryByRole("button", { name: "Modèle de décision" })).toBeNull();
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

  it("annonce que la phrase vient du LLM des Réglages IA", () => {
    enableDecisionLayer();
    mount("apparence");

    fireEvent.click(screen.getByRole("button", { name: "Description rapide" }));
    expect(
      screen.getByText("Phrase de synthèse générée par le LLM configuré dans les Réglages IA."),
    ).toBeTruthy();
  });
});