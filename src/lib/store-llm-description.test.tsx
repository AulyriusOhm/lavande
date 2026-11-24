import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMailDecision, ApiMessage, ApiThread } from "@/lib/api";
import { llmChat } from "@/lib/llm";
import { decisionDb } from "@/lib/decision-db";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return { ...actual, llmChat: vi.fn() };
});

const ALPHA = "alpha";
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };
const DECISION_CFG = {
  enabled: true,
  endpoint: "https://decision.test/v1/systemone",
  model: "mammoth-1",
  apiKey: "nw-test",
};

const apiAccount = (): ApiAccount => ({
  id: ALPHA,
  label: ALPHA,
  email: `${ALPHA}@test.fr`,
  username: `${ALPHA}@test.fr`,
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 1,
});

const apiFolder = (): ApiFolder => ({
  account_id: ALPHA,
  path: "INBOX",
  name: "Boîte de réception",
  role: "inbox",
  uidvalidity: 1,
  uidnext: 5,
  last_sync_at: null,
});

const RECEIVED = new Date(Date.now() - 3_600_000).toISOString();

const apiThread = (uid: number, from: string, subject: string): ApiThread => {
  const primary: ApiMessage = {
    account_id: ALPHA,
    folder_path: "INBOX",
    uid,
    uidvalidity: 1,
    thread_id: `t-${uid}`,
    message_id: `<${uid}@test.fr>`,
    in_reply_to: null,
    references: [],
    from: { name: from, email: `${from.toLowerCase()}@test.fr` },
    to: [{ name: null, email: `${ALPHA}@test.fr` }],
    cc: [],
    subject,
    date: RECEIVED,
    flags: { unread: true, starred: false, answered: false },
    size: 512,
    pgp: "none",
    preview: `Aperçu ${uid}`,
    body_text: `Corps ${uid}`,
    body_html: null,
    attachments: [],
  };
  return {
    id: primary.thread_id,
    account_id: ALPHA,
    messages: [primary],
    primary,
    count: 1,
    unread: 1,
    starred: false,
    encrypted: 0,
    attachments: 0,
    participants: [primary.from.email],
    subject,
    preview: primary.preview,
  };
};

const THREADS = [apiThread(1, "Camille", "Maquettes v3"), apiThread(2, "Marc", "Avenant signé")];

const apiDecision = (
  uid: number,
  overrides: Partial<ApiMailDecision> = {},
): ApiMailDecision => ({
  account_id: ALPHA,
  folder_path: "INBOX",
  uid,
  message_id: `<${uid}@test.fr>`,
  content_hash: `h-${uid}`,
  schema_version: 1,
  model: "mammoth-1",
  category: "important",
  category_conf: 0.92,
  category_probs: { important: 0.92 },
  urgency: 1.5,
  needs_reply: 0.2,
  has_task: 0.2,
  has_event: 0.1,
  security: "safe",
  security_conf: 0.99,
  cleanup_score: 0.05,
  decided_at: Math.floor(Date.now() / 1000),
  source: "local",
  ...overrides,
});

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend() {
  const imported: ApiMailDecision[][] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/ai/decisions/import")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { decisions?: ApiMailDecision[] };
      imported.push(body.decisions ?? []);
      return reply({ imported: body.decisions?.length ?? 0, skipped: 0 });
    }
    if (path.endsWith("/ai/decisions/triage")) return reply({ results: [], errors: [] });
    if (path.endsWith("/ai/decisions")) {
      return reply([apiDecision(1), apiDecision(2, { category: "info", urgency: 0.6 })]);
    }
    if (path.endsWith("/ai/decision/config")) {
      return reply({ ...DECISION_CFG, has_api_key: true, ready: true });
    }
    if (path.endsWith("/api/accounts")) return reply([apiAccount()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders`)) return reply([apiFolder()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders/INBOX/threads`)) return reply(THREADS);
    if (path.includes("/messages/counts") || path.endsWith("/counts")) return reply([]);
    return reply([]);
  });
  return imported;
}

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return renderHook(() => useMailStore(), { wrapper });
}

const seedPrefs = (decision: Record<string, unknown>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM, decision }));

const describedKeys = (result: { current: ReturnType<typeof useMailStore> }) =>
  Object.values(result.current.decisions)
    .filter((dec) => dec.description)
    .map((dec) => dec.uid)
    .sort();

beforeEach(async () => {
  window.localStorage.clear();
  await decisionDb().clearDecisions();
  await decisionDb().clearLlmExtractions();
  vi.stubGlobal("EventSource", undefined);
  vi.mocked(llmChat).mockReset();
  vi.mocked(llmChat).mockResolvedValue("Camille attend ton retour sur la v3 avant vendredi.");
});

afterEach(() => {
  vi.mocked(llmChat).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("description IA · source llm", () => {
  it("décrit les mails triés une seule fois et publie la phrase", async () => {
    seedPrefs({ ...DECISION_CFG, descriptionSource: "llm" });
    const imported = mockBackend();
    const { result, rerender } = mount();

    await waitFor(() => expect(describedKeys(result)).toEqual([1, 2]));

    expect(vi.mocked(llmChat)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(llmChat).mock.calls[0];
    expect(first[1]).toContain("<<<MAIL>>>");
    expect(first[2]).toContain("Objet : Maquettes v3");
    expect(result.current.decisions[`${ALPHA}:INBOX:1`]?.description).toBe(
      "Camille attend ton retour sur la v3 avant vendredi.",
    );

    await waitFor(() => expect(imported.flat()).toHaveLength(2));
    expect(imported.flat().map((entry) => entry.description)).toEqual([
      "Camille attend ton retour sur la v3 avant vendredi.",
      "Camille attend ton retour sur la v3 avant vendredi.",
    ]);

    const stored = await decisionDb().getDecision(`${ALPHA}:INBOX:1`);
    expect(stored?.description).toBe("Camille attend ton retour sur la v3 avant vendredi.");

    // Chaque fusion a déjà relancé l'effet (decisionIndex a changé) : aucun nouvel appel.
    const calls = vi.mocked(llmChat).mock.calls.length;
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vi.mocked(llmChat).mock.calls.length).toBe(calls);
  });

  it("ne rappelle pas le modèle après un échec, même sans description", async () => {
    seedPrefs({ ...DECISION_CFG, descriptionSource: "llm" });
    mockBackend();
    vi.mocked(llmChat).mockRejectedValue(new Error("réseau"));
    const { result, rerender } = mount();

    await waitFor(() => expect(vi.mocked(llmChat).mock.calls.length).toBe(2));
    expect(describedKeys(result)).toEqual([]);

    // La clé est mémorisée avant l'appel : un échec ne se rejoue pas dans la session.

    rerender();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vi.mocked(llmChat).mock.calls.length).toBe(2);
  });

  it("n'appelle pas le LLM quand la source reste le modèle de décision", async () => {
    seedPrefs(DECISION_CFG);
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(Object.keys(result.current.decisions)).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(llmChat)).not.toHaveBeenCalled();
    expect(describedKeys(result)).toEqual([]);
  });

  it("n'appelle pas le LLM sans modèle configuré", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        llm: { endpoint: "", apiKey: "", model: "" },
        decision: { ...DECISION_CFG, descriptionSource: "llm" },
      }),
    );
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(Object.keys(result.current.decisions)).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(llmChat)).not.toHaveBeenCalled();
    expect(describedKeys(result)).toEqual([]);
  });
});
