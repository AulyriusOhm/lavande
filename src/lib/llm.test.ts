import { describe, expect, it, vi } from "vitest";
import { llmChat, llmProbe, llmReady } from "@/lib/llm";

const CONFIG = {
  endpoint: "https://opencode.ai/inference/go/openai/v1/",
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

describe("llmChat", () => {
  it("signe la requête du jeton et de l'en-tête de session opencode", async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: " OK " } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(llmChat(CONFIG, "système", "utilisateur")).resolves.toBe("OK");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer sk-test",
      "x-opencode-session": expect.stringMatching(/^lavande-/) as unknown as string,
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "qwen3-coder",
      messages: [
        { role: "system", content: "système" },
        { role: "user", content: "utilisateur" },
      ],
    });
  });

  it("réutilise la même session d'un appel à l'autre", async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await llmChat(CONFIG, "s", "u");
    await llmChat(CONFIG, "s", "u");

    const sessions = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => (init.headers as Record<string, string>)["x-opencode-session"],
    );
    expect(sessions[0]).toBe(sessions[1]);
  });

  it("remonte le statut et le corps d'une réponse en erreur", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "MissingSessionID" }, 401)),
    );

    await expect(llmChat(CONFIG, "s", "u")).rejects.toThrow(
      'Le modèle a répondu 401 · {"error":"MissingSessionID"}',
    );
  });

  it("refuse une réponse vide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ choices: [{ message: { content: "  " } }] })));

    await expect(llmChat(CONFIG, "s", "u")).rejects.toThrow("Réponse du modèle vide");
  });
});

describe("llmProbe", () => {
  it("rend la réponse du modèle pour le test de connexion", async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: "OK" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(llmProbe(CONFIG)).resolves.toBe("OK");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).messages[1]).toEqual({ role: "user", content: "Réponds OK" });
  });

  it("relaie l'erreur du modèle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "quotas" }, 429)));

    await expect(llmProbe(CONFIG)).rejects.toThrow(/Le modèle a répondu 429/);
  });
});

describe("llmReady", () => {
  it("exige endpoint, modèle et clé", () => {
    expect(llmReady(CONFIG)).toBe(true);
    expect(llmReady({ ...CONFIG, apiKey: "  " })).toBe(false);
    expect(llmReady({ ...CONFIG, model: "" })).toBe(false);
    expect(llmReady(null)).toBe(false);
  });
});
