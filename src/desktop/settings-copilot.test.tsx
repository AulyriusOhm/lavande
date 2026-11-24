import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { refreshCopilotSession } from "@/lib/copilot";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

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
  user_code: "ABCD-1234",
  interval: 1,
  expires_in: 900,
};

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

function stubFetch() {
  let connected = false;
  let polled = 0;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/ai/copilot/start")) return response(START, 201);
    if (url.includes("/ai/copilot/status")) {
      polled += 1;
      if (polled < 2) return response({ status: "pending", interval: 1 });
      connected = true;
      return response({ status: "done", interval: 1, login: "lavande-fan" });
    }
    if (url.endsWith("/ai/copilot/logout") && init?.method === "POST") {
      connected = false;
      return response({ ok: true });
    }
    if (url.endsWith("/ai/copilot/session"))
      return response({ connected, login: connected ? "lavande-fan" : null });
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, setConnected: (value: boolean) => (connected = value) };
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

const provider = (label: string) => screen.getByRole("button", { name: label });
const pressed = (label: string) => provider(label).getAttribute("aria-pressed");

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

describe("Réglages PC · fournisseur du modèle IA", () => {
  it("propose les trois fournisseurs et garde le custom par défaut", () => {
    stubFetch();
    mount();
    openSection("Intelligence artificielle");

    expect(screen.getByRole("group", { name: "Fournisseur du modèle IA" })).toBeTruthy();
    expect(pressed("Custom")).toBe("true");
    expect(pressed("OpenAI")).toBe("false");
    expect(pressed("GitHub Copilot")).toBe("false");
    expect(screen.getByLabelText("Endpoint du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Nom du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Clé API")).toBeTruthy();
  });

  it("préremplit OpenAI sans écraser une configuration existante", async () => {
    stubFetch();
    mount();
    openSection("Intelligence artificielle");

    fireEvent.click(provider("OpenAI"));
    await waitFor(() =>
      expect((stored().llm as { endpoint?: string; provider?: string }).endpoint).toBe(
        "https://api.openai.com/v1",
      ),
    );
    expect((stored().llm as { provider?: string }).provider).toBe("openai");

    const field = screen.getByLabelText("Endpoint du modèle") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "https://proxy.exemple.fr/v1" } });
    await waitFor(() =>
      expect((stored().llm as { endpoint?: string }).endpoint).toBe("https://proxy.exemple.fr/v1"),
    );

    fireEvent.click(provider("Custom"));
    fireEvent.click(provider("OpenAI"));
    await waitFor(() => expect(pressed("OpenAI")).toBe("true"));
    expect(screen.getByLabelText("Endpoint du modèle")).toHaveProperty(
      "value",
      "https://proxy.exemple.fr/v1",
    );
  });
});

describe("Réglages PC · GitHub Copilot", () => {
  it("connecte le compte par device flow, puis le déconnecte", async () => {
    const { fetchMock } = stubFetch();
    mount();
    openSection("Intelligence artificielle");

    fireEvent.click(provider("GitHub Copilot"));
    expect(await screen.findByText("Se connecter à GitHub")).toBeTruthy();
    expect(screen.queryByLabelText("Endpoint du modèle")).toBeNull();
    expect(screen.queryByLabelText("Clé API")).toBeNull();
    expect(screen.getByLabelText("Nom du modèle")).toBeTruthy();
    expect(screen.getByLabelText("Client ID GitHub Copilot")).toBeTruthy();

    fireEvent.click(screen.getByText("Se connecter à GitHub"));

    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByText("Ouvrir la page GitHub")).toBeTruthy();
    expect(window.open).toHaveBeenCalledWith(
      "https://github.com/login/device",
      "_blank",
      "noopener,noreferrer",
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/ai/copilot/start"))).toBe(true);

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
    expect(screen.getByText(/IA inactive/)).toBeTruthy();
  });

  it("transmet le client_id personnalisé au démon", async () => {
    const { fetchMock } = stubFetch();
    mount();
    openSection("Intelligence artificielle");

    fireEvent.click(provider("GitHub Copilot"));
    fireEvent.change(await screen.findByLabelText("Client ID GitHub Copilot"), {
      target: { value: "Iv1.maison" },
    });
    await waitFor(() =>
      expect((stored().llm as { copilotClientId?: string }).copilotClientId).toBe("Iv1.maison"),
    );

    fireEvent.click(screen.getByText("Se connecter à GitHub"));
    await screen.findByText("ABCD-1234");

    const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/ai/copilot/start"));
    expect(JSON.parse(String((start?.[1] as RequestInit).body))).toEqual({ client_id: "Iv1.maison" });
  });

  it("teste la connexion par la session GitHub", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ llm: { provider: "copilot", endpoint: "", apiKey: "", model: "gpt-4o" } }),
    );
    const { setConnected } = stubFetch();
    setConnected(true);
    await refreshCopilotSession();
    mount();
    openSection("Intelligence artificielle");

    expect(await screen.findByText("Connecté · lavande-fan")).toBeTruthy();

    fireEvent.click(screen.getByText("Tester la connexion"));

    expect(await screen.findByText("Compte GitHub connecté · lavande-fan")).toBeTruthy();
  });
});
