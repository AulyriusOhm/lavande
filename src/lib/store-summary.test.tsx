import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { DEFAULT_SUMMARY, currentPeriod } from "@/lib/summary";
import { MAIL_SUGGESTIONS, TASKS } from "@/lib/tasks";
import { createMemoryStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };

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
  uidnext: 4,
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

const THREADS = [
  apiThread(1, "Camille", "Maquettes v3"),
  apiThread(2, "Marc", "Avenant signé"),
  apiThread(3, "OVH", "Facture F2026-1187"),
];

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

const SUMMARY_JSON = {
  resume: "Camille attend un retour sur la v3, la facture OVH est arrivée.",
  taches: [
    { titre: "Répondre à Camille", echeance: "2026-11-20", de: "Camille", mailId: `${ALPHA}:INBOX:1` },
    { titre: "Classer la facture OVH", echeance: "aucune", de: "OVH" },
  ],
};

function mockBackend() {
  const llmCalls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    const { pathname } = new URL(url, "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/chat/completions")) {
      llmCalls.push(url);
      return reply({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) } }] });
    }
    if (path.endsWith("/api/accounts")) return reply([apiAccount()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders`)) return reply([apiFolder()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders/INBOX/threads`)) return reply(THREADS);
    if (path.includes("/messages/counts") || path.endsWith("/counts")) return reply([]);
    return reply([]);
  });
  return llmCalls;
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

const seedPrefs = (summary: Record<string, unknown>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM, summary }));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("résumé périodique · repli local", () => {
  it("produit un résumé de démonstration sans appel réseau", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    seedPrefs({ ...DEFAULT_SUMMARY, llmConsent: true });
    const llmCalls = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary).not.toBeNull());

    const summary = result.current.summary!;
    expect(summary.source).toBe("fallback");
    expect(summary.period.label).toBe(currentPeriod(DEFAULT_SUMMARY).label);
    expect(summary.text.length).toBeGreaterThan(0);
    expect(summary.tasks).toHaveLength(0);
    expect(llmCalls).toHaveLength(0);
    expect(result.current.tasks).toHaveLength(TASKS.length);
  });

  it("ne crée aucun résumé quand la préférence est désactivée", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    seedPrefs({ ...DEFAULT_SUMMARY, enabled: false });
    const { result } = mount();

    await waitFor(() => expect(result.current.summaryLoading).toBe(false));
    expect(result.current.summary).toBeNull();
  });
});

describe("résumé périodique · tâches proposées", () => {
  it("garde les tâches du modèle en suggestions, sans créer de tâche", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ ...DEFAULT_SUMMARY, llmConsent: true });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });

    expect(result.current.summary?.text).toBe(SUMMARY_JSON.resume);
    expect(result.current.summary?.mailCount).toBe(THREADS.length);
    expect(result.current.tasks).toHaveLength(TASKS.length);
    expect(result.current.tasks.some((task) => task.title === "Répondre à Camille")).toBe(false);

    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length + 2);
    const proposals = result.current.suggestions.map((entry) => entry.proposal);
    expect(proposals).toContain("Répondre à Camille");
    expect(proposals).toContain("Classer la facture OVH");
    const linked = result.current.suggestions.find((entry) => entry.proposal === "Répondre à Camille");
    expect(linked?.mailId).toBe(`${ALPHA}:INBOX:1`);
    expect(linked?.subject).toBe("Maquettes v3");
    expect(linked?.due).toBe("ven 20 nov");
  });

  it("ne propose pas deux fois la même tâche lors d'une régénération", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ ...DEFAULT_SUMMARY, llmConsent: true });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });
    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length + 2);

    await act(async () => {
      await result.current.refreshSummary(true);
    });

    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length + 2);
    expect(result.current.tasks).toHaveLength(TASKS.length);
    expect(result.current.summary?.generatedAt).toBeGreaterThan(0);
  });
});
