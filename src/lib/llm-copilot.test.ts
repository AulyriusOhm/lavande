import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmChat, llmDomain, llmModels, llmProbe, llmReady, setUsageSink } from "@/lib/llm";
import { NOT_CONNECTED, refreshCopilotSession } from "@/lib/copilot";

const COPILOT = {
  provider: "copilot" as const,
  endpoint: "",
  apiKey: "",
  model: "gpt-4o",
};

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubFetch(route: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => route(String(input), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const session = (connected: boolean, login: string | null = connected ? "lavande-fan" : null) => () =>
  response({ connected, login });

beforeEach(async () => {
  stubFetch(session(true));
  await refreshCopilotSession();
});

afterEach(() => {
  setUsageSink(null);
  vi.unstubAllGlobals();
});

describe("llmChat · provider copilot", () => {
  it("passe par le démon et mappe la consommation", async () => {
    const seen: { prompt: number; completion: number }[] = [];
    setUsageSink((usage) => seen.push(usage));
    const fetchMock = stubFetch((url) => {
      if (url.endsWith("/api/ai/chat"))
        return response({
          choices: [{ message: { content: " Bonjour " } }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        });
      return response({ connected: true, login: "lavande-fan" });
    });

    await expect(llmChat(COPILOT, "système", "utilisateur")).resolves.toBe("Bonjour");

    expect(fetchMock.mock.calls).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "système" },
        { role: "user", content: "utilisateur" },
      ],
      temperature: 0.6,
    });
    expect(seen).toEqual([{ prompt: 42, completion: 7 }]);
  });

  it("explique une session absente plutôt que de relayer 409", async () => {
    stubFetch(() => response({ error: "copilot non connecté", kind: "copilot" }, 409));

    await expect(llmChat(COPILOT, "s", "u")).rejects.toThrow(NOT_CONNECTED);
  });

  it("refuse une réponse vide du proxy", async () => {
    stubFetch(() => response({ choices: [{ message: { content: "  " } }] }));

    await expect(llmChat(COPILOT, "s", "u")).rejects.toThrow("Réponse du modèle vide");
  });

  it("relaie une erreur du proxy", async () => {
    stubFetch(() => response({ error: "quota Copilot épuisé", kind: "copilot" }, 502));

    await expect(llmChat(COPILOT, "s", "u")).rejects.toThrow("quota Copilot épuisé");
  });
});

describe("llmModels · provider copilot", () => {
  it("rend la liste statique sans appeler le réseau", async () => {
    const fetchMock = stubFetch(() => response({}));

    await expect(llmModels(COPILOT)).resolves.toEqual([
      "gpt-4o",
      "gpt-4.1",
      "claude-sonnet-4",
      "o3-mini",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("llmProbe · provider copilot", () => {
  it("confirme la session GitHub connectée", async () => {
    stubFetch((url) =>
      url.endsWith("/ai/copilot/session")
        ? response({ connected: true, login: "lavande-fan" })
        : response({}),
    );

    await expect(llmProbe(COPILOT)).resolves.toBe("Compte GitHub connecté · lavande-fan");
  });

  it("donne la marche à suivre quand aucun compte n'est connecté", async () => {
    stubFetch(() => response({ connected: false, login: null }));

    await expect(llmProbe(COPILOT)).rejects.toThrow(NOT_CONNECTED);
  });
});

describe("llmReady · provider copilot", () => {
  it("exige un modèle et une session connectée", async () => {
    expect(llmReady(COPILOT)).toBe(true);
    expect(llmReady({ ...COPILOT, model: " " })).toBe(false);

    stubFetch(session(false));
    await refreshCopilotSession();
    expect(llmReady(COPILOT)).toBe(false);

    stubFetch(session(true));
    await refreshCopilotSession();
    expect(llmReady(COPILOT)).toBe(true);
  });

  it("laisse custom et openai sur endpoint + clé", () => {
    const config = { endpoint: "https://api.exemple.fr/v1", apiKey: "sk-test", model: "gpt-4o" };
    expect(llmReady(config)).toBe(true);
    expect(llmReady({ ...config, provider: "openai" })).toBe(true);
    expect(llmReady({ ...config, provider: "openai", apiKey: "" })).toBe(false);
  });
});

describe("llmDomain", () => {
  it("compte Copilot sous api.githubcopilot.com", () => {
    expect(llmDomain(COPILOT)).toBe("api.githubcopilot.com");
    expect(llmDomain({ ...COPILOT, provider: "custom" })).toBe("");
    expect(
      llmDomain({
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o",
      }),
    ).toBe("api.openai.com");
  });
});
