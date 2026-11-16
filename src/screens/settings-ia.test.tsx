import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

const LLM = {
  endpoint: "https://api.exemple.fr/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const MODELS = { data: [{ id: "qwen3-coder" }, { id: "gpt-4o-mini" }] };

function stubFetch(models: () => Response = () => response(MODELS)) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      return response({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      });
    }
    if (url.endsWith("/models")) return models();
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function configure() {
  fireEvent.change(screen.getByLabelText("Endpoint du modèle"), { target: { value: LLM.endpoint } });
  fireEvent.change(screen.getByLabelText("Nom du modèle"), { target: { value: LLM.model } });
  fireEvent.change(screen.getByLabelText("Clé API"), { target: { value: LLM.apiKey } });
  await waitFor(() => expect(stored().llm).toMatchObject(LLM));
}

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

describe("Réglages mobile · section IA accessible sur Android", () => {
  it("sous VITE_PLATFORM=android : configuration du modèle et bascules IA proposées, MCP absent", () => {
    stubFetch();
    vi.stubEnv("VITE_PLATFORM", "android");
    mount();

    expect(screen.getByText("Intelligence artificielle")).toBeTruthy();
    expect(screen.getByLabelText("Endpoint du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Nom du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Clé API")).toBeTruthy();
    expect(screen.getByText("Tester la connexion")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Suggestions de réponse IA/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Résumés périodiques/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Suggestions de tâches IA/ })).toBeTruthy();
    expect(screen.queryByText("Serveurs MCP")).toBeNull();
  });

  it("teste la connexion au modèle et mémorise la configuration", async () => {
    const fetchMock = stubFetch();
    vi.stubEnv("VITE_PLATFORM", "android");
    mount();

    fireEvent.change(screen.getByLabelText("Endpoint du modèle"), { target: { value: LLM.endpoint } });
    fireEvent.change(screen.getByLabelText("Nom du modèle"), { target: { value: LLM.model } });
    fireEvent.change(screen.getByLabelText("Clé API"), { target: { value: LLM.apiKey } });
    await waitFor(() => expect(stored().llm).toMatchObject(LLM));

    fireEvent.click(screen.getByText("Tester la connexion"));

    expect(await screen.findByText("Réponse du modèle · OK")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/chat/completions"))).toBe(true);
  });

  it("exclut une boîte des suggestions IA depuis la section IA", async () => {
    stubFetch();
    vi.stubEnv("VITE_PLATFORM", "android");
    mount();

    expect(screen.getByText("Suggestions par compte")).toBeTruthy();
    const studio = screen.getByRole("switch", { name: /^Studio/ });
    expect(studio.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(studio);
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ excludedAccounts: ["pro"] }));

    fireEvent.click(screen.getByRole("switch", { name: /^Studio/ }));
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ excludedAccounts: [] }));
  });

  it("charge les modèles de l'endpoint et les propose sans bloquer la saisie libre", async () => {
    const fetchMock = stubFetch();
    vi.stubEnv("VITE_PLATFORM", "android");
    const view = mount();
    await configure();

    fireEvent.click(screen.getByText("Charger les modèles"));

    await waitFor(() => expect(view.container.querySelectorAll("#llm-models option")).toHaveLength(2));
    const options = [...view.container.querySelectorAll("#llm-models option")].map((node) =>
      node.getAttribute("value"),
    );
    expect(options).toEqual(["gpt-4o-mini", "qwen3-coder"]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/models"))).toBe(true);

    fireEvent.change(screen.getByLabelText("Nom du modèle"), { target: { value: "modele-maison" } });
    await waitFor(() => expect(stored().llm).toMatchObject({ model: "modele-maison" }));
  });

  it("affiche une erreur propre quand la liste des modèles échoue", async () => {
    stubFetch(() => response({ error: "invalid_api_key" }, 401));
    vi.stubEnv("VITE_PLATFORM", "android");
    const view = mount();
    await configure();

    fireEvent.click(screen.getByText("Charger les modèles"));

    expect(await screen.findByText(/Liste indisponible · Liste des modèles indisponible \(401\)/)).toBeTruthy();
    expect(view.container.querySelectorAll("#llm-models option")).toHaveLength(0);
    expect(screen.getByText("Tester la connexion")).toBeTruthy();
  });

  it("affiche la consommation de tokens et la réinitialise", async () => {
    stubFetch();
    vi.stubEnv("VITE_PLATFORM", "android");
    mount();
    await configure();

    expect(screen.getByText("Consommation")).toBeTruthy();
    expect(screen.getByText("Aucun appel enregistré · les tokens sont comptés à chaque réponse du modèle.")).toBeTruthy();

    fireEvent.click(screen.getByText("Tester la connexion"));
    await screen.findByText("Réponse du modèle · OK");

    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    expect(screen.getByText(/1 appel\(s\) · 1\s500 tokens/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Réinitialiser la consommation"));
    await waitFor(() =>
      expect(screen.getByText("Aucun appel enregistré · les tokens sont comptés à chaque réponse du modèle.")).toBeTruthy(),
    );
    expect(window.localStorage.getItem("lavande.ai.stats")).toBeNull();
  });

  it("bascule les options IA et les persiste", async () => {
    stubFetch();
    vi.stubEnv("VITE_PLATFORM", "android");
    mount();

    fireEvent.click(screen.getByRole("switch", { name: /Suggestions de réponse IA/ }));
    await waitFor(() => expect(stored().aiReplyEnabled).toBe(false));

    fireEvent.click(screen.getByRole("switch", { name: /Résumés périodiques/ }));
    await waitFor(() => expect(stored().summary).toMatchObject({ enabled: false }));

    fireEvent.click(screen.getByRole("switch", { name: /Suggestions de rendez-vous IA/ }));
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ events: true }));
  });
});
