import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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

function stubFetch(chat: () => Response) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
    if (url.endsWith("/chat/completions")) return chat();
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

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages · section IA", () => {
  it("désactive le test tant que la configuration est incomplète", async () => {
    stubFetch(() => response({}));
    mount();

    const button = (await screen.findByText("Tester la connexion")).closest("button");
    expect(button?.disabled).toBe(true);
  });

  it("teste la connexion et affiche la réponse du modèle", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
    const fetchMock = stubFetch(() => response({ choices: [{ message: { content: "OK" } }] }));
    mount();

    fireEvent.click(await screen.findByText("Tester la connexion"));

    expect(await screen.findByText("Réponse du modèle · OK")).toBeTruthy();
    expect(screen.getByText("connexion établie")).toBeTruthy();

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
    expect(call).toBeTruthy();
    const init = call?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "x-opencode-session": expect.stringMatching(/^lavande-/) as unknown as string,
    });
  });

  it("affiche une erreur claire quand le modèle refuse", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
    stubFetch(() => response({ error: "MissingSessionID" }, 401));
    mount();

    fireEvent.click(await screen.findByText("Tester la connexion"));

    expect(
      await screen.findByText(/Échec · Le modèle a répondu 401 · \{"error":"MissingSessionID"\}/),
    ).toBeTruthy();
    expect(screen.getAllByText("échec").length).toBeGreaterThan(0);
  });
});
