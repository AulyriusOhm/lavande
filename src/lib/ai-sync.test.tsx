import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { recordUsage } from "@/lib/ai-stats";
import { useAiSync, useAiUsage, usageDocId } from "@/lib/ai-sync";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { createSyncEngine } from "@/lib/sync/engine";
import { docKey, type Doc } from "@/lib/sync/merge";
import { createMemoryStorage, type SyncStorage } from "@/lib/sync/storage";

const LLM = { endpoint: "https://api.exemple.fr/v1", apiKey: "sk-tres-secret", model: "gpt-4o-mini" };

function json(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function stubServer() {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/register")) {
      return json(201, {
        userId: "user-1",
        token: "jeton",
        expiresAt: "2030-01-01T00:00:00.000Z",
        accountSalt: "sel",
      });
    }
    if (url.endsWith("/api/v1/devices")) return json(201, { deviceId: "appareil-1" });
    if (url.endsWith("/auth/envelope")) return json(204);
    if (url.includes("/api/v1/ops") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { ops: { opId: string }[] };
      return json(200, { acked: body.ops.map((op) => op.opId), nextSeq: body.ops.length });
    }
    if (url.includes("/api/v1/ops")) return json(200, { ops: [], nextSeq: 0, hasMore: false });
    return json(404, { code: "not_found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function configuredStorage(): Promise<SyncStorage> {
  const storage = createMemoryStorage();
  const engine = createSyncEngine(storage, {
    fetchImpl: globalThis.fetch,
    deriveMasterKey: () => new Uint8Array(32).fill(7),
  });
  await engine.createAccount({ serverUrl: "https://sync.test", email: "a@b.c", password: "motdepasse" });
  return storage;
}

function AiProbe() {
  useAiSync();
  const usage = useAiUsage();
  const { llm } = usePrefs();
  return (
    <div>
      <span data-testid="calls">{usage.combined.total.calls}</span>
      <span data-testid="devices">{usage.devices}</span>
      <span data-testid="model">{llm.model}</span>
    </div>
  );
}

function mount(storage: SyncStorage) {
  return render(
    <PrefsProvider>
      <PlanningProvider storage={storage}>
        <AiProbe />
      </PlanningProvider>
    </PrefsProvider>,
  );
}

const settingsKey = docKey("ai", "settings");

function remoteDoc(id: string, raw: Record<string, unknown>, updatedAt = new Date().toISOString()): Doc {
  return { id, kind: "ai", v: 1, raw, fields: {}, readOnly: false, updatedAt };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAiSync", () => {
  it("émet un doc usage par appareil et un doc settings sans la clé API", async () => {
    stubServer();
    const storage = await configuredStorage();
    mount(storage);
    const deviceId = storage.read().device.id;

    await act(async () => {
      recordUsage(LLM.model, "api.exemple.fr", { prompt: 120, completion: 30 });
    });

    const usage = storage.read().docs[docKey("ai", usageDocId(deviceId))];
    expect(usage?.raw.usage).toEqual({ prompt: 120, completion: 30, calls: 1 });
    expect(usage?.raw.byModel).toEqual({ "gpt-4o-mini": { prompt: 120, completion: 30, calls: 1 } });
    expect(usage?.raw.byDomain).toEqual({ "api.exemple.fr": { prompt: 120, completion: 30, calls: 1 } });

    const settings = storage.read().docs[settingsKey];
    expect(settings?.raw).toEqual({ endpoint: LLM.endpoint, model: LLM.model });

    const serialized = JSON.stringify(storage.read().docs);
    expect(serialized).not.toContain(LLM.apiKey);
    expect(serialized).not.toContain("sk-tres-secret");
    expect(JSON.stringify(storage.read().outbox)).not.toContain("sk-tres-secret");
  });

  it("somme la consommation locale et celle des autres appareils", async () => {
    stubServer();
    const storage = await configuredStorage();
    mount(storage);

    await act(async () => {
      recordUsage(LLM.model, "api.exemple.fr", { prompt: 10, completion: 5 });
    });
    expect(screen.getByTestId("calls").textContent).toBe("1");
    expect(screen.getByTestId("devices").textContent).toBe("1");

    await act(async () => {
      const state = storage.read();
      const doc = remoteDoc("usage:autre-appareil", { usage: { prompt: 40, completion: 8, calls: 3 } });
      storage.write({ ...state, docs: { ...state.docs, [docKey("ai", doc.id)]: doc } });
    });

    expect(screen.getByTestId("calls").textContent).toBe("4");
    expect(screen.getByTestId("devices").textContent).toBe("2");
  });

  it("porte la description du modèle de décision dans le doc decision:settings", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        llm: LLM,
        decision: { enabled: true, descriptionModel: "my-chat-model", descriptionSource: "llm" },
      }),
    );
    stubServer();
    const storage = await configuredStorage();
    mount(storage);

    const decisionKey = docKey("ai", "decision:settings");
    await waitFor(() => expect(storage.read().docs[decisionKey]).toBeDefined());
    const raw = storage.read().docs[decisionKey]?.raw ?? {};
    expect(raw.descriptionModel).toBe("my-chat-model");
    expect(raw.descriptionSource).toBe("llm");
    expect(JSON.stringify(raw)).not.toContain(LLM.apiKey);
  });

  it("applique un doc settings distant plus récent sans réémettre d'écho", async () => {
    stubServer();
    const storage = await configuredStorage();
    mount(storage);
    const before = storage.read().docs[settingsKey];
    expect(before?.raw).toEqual({ endpoint: LLM.endpoint, model: LLM.model });
    const fieldsBefore = before?.fields;

    await act(async () => {
      const state = storage.read();
      const doc = {
        ...remoteDoc(
          "settings",
          { endpoint: "https://opencode.ai/inference/go/openai/v1", model: "qwen3-coder" },
          new Date(Date.now() + 60_000).toISOString(),
        ),
        fields: fieldsBefore ?? {},
      };
      storage.write({ ...state, docs: { ...state.docs, [settingsKey]: doc } });
    });

    await waitFor(() => expect(screen.getByTestId("model").textContent).toBe("qwen3-coder"));
    const stored = JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
      llm?: { endpoint?: string; apiKey?: string };
    };
    expect(stored.llm?.endpoint).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(stored.llm?.apiKey).toBe(LLM.apiKey);
    expect(storage.read().docs[settingsKey]?.fields).toEqual(fieldsBefore);
  });
});
