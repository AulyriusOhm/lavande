import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const LLM = {
  endpoint: "https://opencode.ai/inference/go/openai/v1",
  apiKey: "sk-test",
  model: "qwen3-coder",
};

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const MODELS = { data: [{ id: "qwen3-coder" }, { id: "gpt-4o-mini" }] };

function stubFetch(chat: () => Response, models: () => Response = () => response(MODELS)) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
    if (url.endsWith("/chat/completions")) return chat();
    if (url.endsWith("/models")) return models();
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount() {
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

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
});

describe("Réglages · section IA sous VITE_PLATFORM=android", () => {
  it("garde la configuration du modèle et les bascules IA", () => {
    vi.stubEnv("VITE_PLATFORM", "android");
    stubFetch(() => response({}));
    mount();
    openSection("Intelligence artificielle");

    expect(screen.getAllByText("Intelligence artificielle").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Endpoint du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Nom du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Clé API")).toBeTruthy();
    expect(screen.getByText("Tester la connexion")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Suggestions de réponse IA/ })).toBeTruthy();

    openSection("Suggestions de tâches");
    expect(screen.getByRole("switch", { name: /Suggestions de tâches IA/ })).toBeTruthy();
  });
});

describe("Réglages · section IA", () => {
  it("désactive le test tant que la configuration est incomplète", async () => {
    stubFetch(() => response({}));
    mount();
    openSection("Intelligence artificielle");

    const button = (await screen.findByText("Tester la connexion")).closest("button");
    expect(button?.disabled).toBe(true);
  });

  it("teste la connexion et affiche la réponse du modèle", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
    const fetchMock = stubFetch(() => response({ choices: [{ message: { content: "OK" } }] }));
    mount();
    openSection("Intelligence artificielle");

    fireEvent.click(await screen.findByText("Tester la connexion"));

    expect(await screen.findByText("Réponse du modèle · OK")).toBeTruthy();
    expect(screen.getByText("connexion établie")).toBeTruthy();

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
    expect(call).toBeTruthy();
    const init = (call as unknown[] | undefined)?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "x-opencode-session": expect.stringMatching(/^lavande-/) as unknown as string,
    });
  });

  it("affiche une erreur claire quand le modèle refuse", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
    stubFetch(() => response({ error: "MissingSessionID" }, 401));
    mount();
    openSection("Intelligence artificielle");

    fireEvent.click(await screen.findByText("Tester la connexion"));

    expect(
      await screen.findByText(/Échec · Le modèle a répondu 401 · \{"error":"MissingSessionID"\}/),
    ).toBeTruthy();
    expect(screen.getAllByText("échec").length).toBeGreaterThan(0);
  });
});

describe("Réglages · modèles et consommation", () => {
  const withUsage = () =>
    response({
      choices: [{ message: { content: "OK" } }],
      usage: { prompt_tokens: 1200, completion_tokens: 300 },
    });

  it("charge la liste des modèles dans une datalist sans bloquer la saisie libre", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
    const fetchMock = stubFetch(() => response({}));
    const view = mount();
    openSection("Intelligence artificielle");

    fireEvent.click(await screen.findByText("Charger les modèles"));

    await waitFor(() => expect(view.container.querySelectorAll("#llm-models option")).toHaveLength(2));
    const options = [...view.container.querySelectorAll("#llm-models option")].map((node) =>
      node.getAttribute("value"),
    );
    expect(options).toEqual(["gpt-4o-mini", "qwen3-coder"]);
    expect(screen.getByText("2 modèle(s) disponible(s)")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/models"))).toBe(true);

    const field = screen.getByLabelText("Nom du modèle") as HTMLInputElement;
    expect(field.getAttribute("list")).toBe("llm-models");
    fireEvent.change(field, { target: { value: "modele-maison" } });
    await waitFor(() =>
      expect(
        (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as { llm?: { model?: string } }).llm
          ?.model,
      ).toBe("modele-maison"),
    );
  });

  it("affiche une erreur propre quand l'endpoint n'expose pas /models", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
    stubFetch(() => response({}), () => response({ error: "not_found" }, 404));
    mount();
    openSection("Intelligence artificielle");

    fireEvent.click(await screen.findByText("Charger les modèles"));

    expect(await screen.findByText(/Liste indisponible · Liste des modèles indisponible \(404\)/)).toBeTruthy();
    expect(screen.getByText("Tester la connexion")).toBeTruthy();
  });

  it("affiche la consommation, le total et le bouton de remise à zéro", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
    stubFetch(withUsage);
    mount();
    openSection("Intelligence artificielle");

    expect(await screen.findByText("Consommation")).toBeTruthy();
    expect(screen.getByText("cet appareil")).toBeTruthy();
    expect(screen.getByText("Aucun appel enregistré · les tokens sont comptés à chaque réponse du modèle.")).toBeTruthy();

    fireEvent.click(screen.getByText("Tester la connexion"));
    await screen.findByText("Réponse du modèle · OK");

    await waitFor(() => expect(screen.getByText(/1 appel\(s\) · 1\s500 tokens/)).toBeTruthy());
    expect(screen.getByText("1 200")).toBeTruthy();
    expect(screen.getByText("300")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Réinitialiser la consommation"));
    await waitFor(() =>
      expect(screen.getByText("Aucun appel enregistré · les tokens sont comptés à chaque réponse du modèle.")).toBeTruthy(),
    );
    expect(window.localStorage.getItem("lavande.ai.stats")).toBeNull();
  });
});

describe("Réglages · suggestions de tâches IA", () => {
  const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

  it("bascule l'option et borne la fenêtre entre 1 et 168 heures", async () => {
    stubFetch(() => response({}));
    mount();
    openSection("Suggestions de tâches");

    const toggle = screen.getByRole("switch", { name: /Suggestions de tâches IA/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ enabled: false }));

    const field = screen.getByLabelText(
      "Fenêtre des mails analysés pour les suggestions de tâches",
    ) as HTMLInputElement;
    expect(field.value).toBe("48");

    fireEvent.change(field, { target: { value: "12" } });
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ enabled: false, windowHours: 12 }));

    fireEvent.change(field, { target: { value: "900" } });
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ windowHours: 168 }));

    fireEvent.change(field, { target: { value: "0" } });
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ windowHours: 1 }));
  });

  it("rappelle qu'aucun modèle n'est configuré et que rien n'est créé sans validation", () => {
    stubFetch(() => response({}));
    mount();
    openSection("Suggestions de tâches");

    expect(screen.getByText(/Le LLM analyse vos mails récents pour proposer des tâches/)).toBeTruthy();
    expect(
      screen.getByText("Aucun modèle configuré · aucune suggestion générée (section IA)."),
    ).toBeTruthy();
  });

  it("exclut puis réinclut un compte des suggestions IA", async () => {
    stubFetch(() => response({}));
    mount();
    openSection("Suggestions de tâches");

    expect(screen.getAllByText("Analysé par l'IA")).toHaveLength(3);

    fireEvent.click(screen.getByRole("switch", { name: /^Studio/ }));
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ excludedAccounts: ["pro"] }));
    expect(screen.getAllByText("Analysé par l'IA")).toHaveLength(2);
    expect(screen.getByText("Exclu · ses mails ne produisent aucune suggestion")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /^Studio/ }).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("switch", { name: /^Studio/ }));
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ excludedAccounts: [] }));
    expect(screen.getAllByText("Analysé par l'IA")).toHaveLength(3);
  });

  it("active puis désactive les suggestions de rendez-vous IA", async () => {
    stubFetch(() => response({}));
    mount();
    openSection("Suggestions de tâches");

    const toggle = screen.getByRole("switch", { name: /Suggestions de rendez-vous IA/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ events: true }));

    fireEvent.click(toggle);
    await waitFor(() => expect(stored().aiTasks).toMatchObject({ events: false }));
  });
});
