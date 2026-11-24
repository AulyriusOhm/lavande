import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { NEURALWATT_ENDPOINT } from "@/lib/decision";

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function mount() {
  const view = render(
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
  fireEvent.click(screen.getByRole("button", { name: /^IA/ }));
  return view;
}

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Réglages IA · segmentation Modèle de décision (Système 1) vs LLM", () => {
  it("propose NeuralWatt par défaut, teste la connexion et mémorise les seuils + vue Inbox", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === NEURALWATT_ENDPOINT) {
        return response({
          model: "mammoth-1",
          answers: { urgent: { type: "noul", noul: 0.96 } },
          usage: { input_tokens: 42, output_tokens: 0 },
          energy: { energy_joules: 14.3, energy_kwh: 0.000004, avg_power_watts: 3200, duration_seconds: 0.05 },
        });
      }
      return response([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    mount();

    expect(screen.getByText("Modèle de décision · Système 1")).toBeTruthy();
    expect((screen.getByLabelText("Endpoint du modèle de décision") as HTMLInputElement).value).toBe(
      NEURALWATT_ENDPOINT,
    );
    expect((screen.getByLabelText("Nom du modèle de décision") as HTMLInputElement).value).toBe("mammoth-1");

    fireEvent.click(screen.getByRole("switch", { name: /Activer le modèle de décision/ }));
    fireEvent.change(screen.getByLabelText("Clé API du modèle de décision"), {
      target: { value: "nw-test-key" },
    });
    await waitFor(() =>
      expect(stored().decision).toMatchObject({
        enabled: true,
        provider: "neuralwatt",
        model: "mammoth-1",
        apiKey: "nw-test-key",
        defaultInboxFilter: "all",
      }),
    );

    fireEvent.click(screen.getByText("Tester le modèle de décision"));
    expect(await screen.findByText(/Modèle de décision · mammoth-1 · .*14\.3 J/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Strict" }));
    fireEvent.click(screen.getByRole("button", { name: "Prioritaire" }));
    await waitFor(() =>
      expect(stored().decision).toMatchObject({
        defaultInboxFilter: "priority",
        thresholds: { llmEscalate: 0.68, category: 0.6, security: 0.72, folder: 0.78 },
      }),
    );

    const trustInput = screen.getByLabelText("Expéditeur ou domaine de confiance");
    fireEvent.change(trustInput, { target: { value: "alice@banque.fr" } });
    fireEvent.click(screen.getByRole("button", { name: "Approuver" }));
    fireEvent.change(trustInput, { target: { value: "@boursorama.fr" } });
    fireEvent.click(screen.getByRole("button", { name: "Approuver" }));

    await waitFor(() =>
      expect(stored().decision).toMatchObject({
        trustedSenders: ["alice@banque.fr"],
        trustedDomains: ["boursorama.fr"],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retirer alice@banque.fr" }));
    await waitFor(() =>
      expect(stored().decision).toMatchObject({
        trustedSenders: [],
        trustedDomains: ["boursorama.fr"],
      }),
    );
  });

  it("règle le nombre de mails récents analysés, borné à 10–200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([])),
    );

    mount();

    const field = (await screen.findByLabelText(
      "Nombre de mails récents analysés par le modèle de décision",
    )) as HTMLInputElement;
    expect(field.value).toBe("40");
    expect(screen.getByText(/Les 40 mails les plus récents passés au modèle de décision/)).toBeTruthy();

    fireEvent.change(field, { target: { value: "120" } });
    await waitFor(() => expect(stored().decision).toMatchObject({ recentMailCount: 120 }));
    expect(screen.getByText(/Les 120 mails les plus récents passés au modèle de décision/)).toBeTruthy();

    fireEvent.change(field, { target: { value: "5" } });
    await waitFor(() => expect(stored().decision).toMatchObject({ recentMailCount: 10 }));

    fireEvent.change(field, { target: { value: "900" } });
    await waitFor(() => expect(stored().decision).toMatchObject({ recentMailCount: 200 }));
  });

  it("laisse la catégorisation spam coupée par défaut et persiste la bascule", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([])),
    );

    mount();

    const toggle = screen.getByRole("switch", { name: /Catégorisation spam/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(stored().decision).toMatchObject({ spamEnabled: false }));

    fireEvent.click(toggle);
    await waitFor(() => expect(stored().decision).toMatchObject({ spamEnabled: true }));
    expect(screen.getByRole("switch", { name: /Catégorisation spam/ }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("switch", { name: /Catégorisation spam/ }));
    await waitFor(() => expect(stored().decision).toMatchObject({ spamEnabled: false }));
  });
});
