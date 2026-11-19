import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { refreshCopilotSession } from "@/lib/copilot";

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const START = {
  session: "s-1",
  verification_uri: "https://github.com/login/device",
  user_code: "WXYZ-9876",
  interval: 1,
  expires_in: 900,
};

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

function stubFetch() {
  let connected = false;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/ai/copilot/start")) return response(START, 201);
    if (url.includes("/ai/copilot/status")) {
      connected = true;
      return response({ status: "done", interval: 1, login: "lavande-fan" });
    }
    if (url.endsWith("/ai/copilot/logout") && init?.method === "POST") {
      connected = false;
      return response({ ok: true });
    }
    if (url.endsWith("/ai/copilot/session"))
      return response({ connected, login: connected ? "lavande-fan" : null });
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

const provider = (label: string) => screen.getByRole("button", { name: label });

beforeEach(async () => {
  window.localStorage.clear();
  vi.stubGlobal("open", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async () => response({ connected: false, login: null })));
  await refreshCopilotSession();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  vi.unstubAllGlobals();
});

describe("Réglages mobile · fournisseur du modèle IA", () => {
  it("garde les champs custom intacts et propose les trois fournisseurs", () => {
    stubFetch();
    mount();

    expect(screen.getByRole("group", { name: "Fournisseur du modèle IA" })).toBeTruthy();
    expect(provider("Custom").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Endpoint du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Nom du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Clé API")).toBeTruthy();
    expect(screen.getByText("Charger les modèles")).toBeTruthy();
  });

  it("préremplit OpenAI seulement quand l'endpoint est vide", async () => {
    stubFetch();
    mount();

    fireEvent.click(provider("OpenAI"));
    await waitFor(() =>
      expect((stored().llm as { endpoint?: string }).endpoint).toBe("https://api.openai.com/v1"),
    );

    fireEvent.change(screen.getByLabelText("Endpoint du modèle"), {
      target: { value: "https://proxy.exemple.fr/v1" },
    });
    fireEvent.click(provider("Custom"));
    fireEvent.click(provider("OpenAI"));
    await waitFor(() => expect(provider("OpenAI").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByLabelText("Endpoint du modèle")).toHaveProperty(
      "value",
      "https://proxy.exemple.fr/v1",
    );
  });

  it("connecte puis déconnecte un compte GitHub Copilot", async () => {
    const fetchMock = stubFetch();
    mount();

    fireEvent.click(provider("GitHub Copilot"));

    expect(await screen.findByText("Se connecter à GitHub")).toBeTruthy();
    expect(screen.queryByLabelText("Endpoint du modèle")).toBeNull();
    expect(screen.queryByText("Charger les modèles")).toBeNull();
    expect(screen.getByLabelText("Nom du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Client ID GitHub Copilot")).toBeTruthy();
    expect(screen.getByText(/IA inactive/)).toBeTruthy();

    fireEvent.click(screen.getByText("Se connecter à GitHub"));

    expect(await screen.findByText("WXYZ-9876")).toBeTruthy();
    expect(screen.getByText("Ouvrir la page GitHub")).toBeTruthy();
    expect(await screen.findByText("Connecté · lavande-fan", {}, { timeout: 4_000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Nom du modèle"), { target: { value: "gpt-4o" } });
    await waitFor(() => expect(screen.getByText(/IA active/)).toBeTruthy());

    fireEvent.click(screen.getByText("Se déconnecter"));
    expect(await screen.findByText("Se connecter à GitHub")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith("/ai/copilot/logout") && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("garde le client_id Copilot saisi entre deux réglages", async () => {
    stubFetch();
    mount();

    fireEvent.click(provider("GitHub Copilot"));
    fireEvent.change(await screen.findByLabelText("Client ID GitHub Copilot"), {
      target: { value: "Iv1.maison" },
    });

    await waitFor(() =>
      expect((stored().llm as { copilotClientId?: string }).copilotClientId).toBe("Iv1.maison"),
    );
    expect((stored().llm as { provider?: string }).provider).toBe("copilot");
  });
});
