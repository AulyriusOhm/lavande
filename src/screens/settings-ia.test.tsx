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

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) return response({ choices: [{ message: { content: "OK" } }] });
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
