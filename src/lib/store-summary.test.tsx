import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMailDecision, ApiMessage, ApiThread } from "@/lib/api";
import { decisionDb } from "@/lib/decision-db";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { DEFAULT_SUMMARY, currentPeriod } from "@/lib/summary";
import { MAIL_SUGGESTIONS, TASKS, formatDueDate, isoToday } from "@/lib/tasks";
import { createMemoryStorage } from "@/lib/sync/storage";

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

const THREADS = [
  apiThread(1, "Camille", "Maquettes v3"),
  apiThread(2, "Marc", "Avenant signé"),
  apiThread(3, "OVH", "Facture F2026-1187"),
];

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

const DUE_ISO = isoToday(4);

const SUMMARY_JSON = {
  accroche: "Camille attend un retour sur la v3, la facture OVH est arrivée.",
  actions: [{ mailId: `${ALPHA}:INBOX:1`, raison: "Répondre à Camille sur la v3", echeance: DUE_ISO }],
  infos: [{ mailId: `${ALPHA}:INBOX:2`, raison: "Avenant à lire" }],
  notifications: [],
  taches: [
    { titre: "Répondre à Camille", echeance: DUE_ISO, de: "Camille", mailId: `${ALPHA}:INBOX:1` },
    { titre: "Classer la facture OVH", echeance: "aucune", de: "OVH" },
  ],
};

function mockBackend(
  threads: ApiThread[] = THREADS,
  decisionsByUid: Record<number, Partial<ApiMailDecision>> = {
    1: { category: "important", needs_reply: 0.9, has_task: 0.85, urgency: 2.2 },
    2: { category: "info", urgency: 0.8 },
    3: { category: "info", urgency: 0.6 },
  },
) {
  const llmCalls: { url: string; user: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { pathname } = new URL(url, "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { role?: string; content?: string }[];
      };
      llmCalls.push({ url, user: body.messages?.[1]?.content ?? "" });
      return reply({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) } }] });
    }
    if (path.endsWith("/api/ai/decisions/triage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        targets?: { uid: number }[];
      };
      return reply({
        results: (body.targets ?? []).map((t) => ({
          decision: apiDecision(t.uid, decisionsByUid[t.uid]),
          cached: false,
        })),
        errors: [],
      });
    }
    if (path.endsWith("/api/accounts")) return reply([apiAccount()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders`)) return reply([apiFolder()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders/INBOX/threads`)) return reply(threads);
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

const seedPrefs = (
  summary: Record<string, unknown>,
  decision: Record<string, unknown> = DECISION_CFG,
) =>
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({ llm: LLM, summary, ...(decision ? { decision } : {}) }),
  );

beforeEach(async () => {
  window.localStorage.clear();
  await decisionDb().clearDecisions();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("résumé périodique · repli local et règle d'or #3", () => {
  it("produit un résumé de démonstration sans appel réseau", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    seedPrefs({ ...DEFAULT_SUMMARY, llmConsent: true });
    const llmCalls = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary).not.toBeNull());

    const summary = result.current.summary!;
    expect(summary.source).toBe("fallback");
    expect(summary.period.label).toBe(currentPeriod(DEFAULT_SUMMARY).label);
    expect(summary.headline.length).toBeGreaterThan(0);
    expect(summary.groups.actions).toEqual([]);
    expect(summary.groups.infos.length).toBeGreaterThan(0);
    expect(summary.tasks).toHaveLength(0);
    expect(llmCalls).toHaveLength(0);
    expect(result.current.tasks).toHaveLength(TASKS.length);
  });

  it("n'émet aucun appel LLM automatique sans modèle de décision ni décisions en cache", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ llm: LLM, summary: { ...DEFAULT_SUMMARY, llmConsent: true } }),
    );
    const llmCalls = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.mails).toHaveLength(THREADS.length), { timeout: 3000 });
    await waitFor(() => expect(result.current.summary?.source).toBe("fallback"), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(llmCalls).toHaveLength(0);
  });

  it("ne crée aucun résumé quand la préférence est désactivée", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    seedPrefs({ ...DEFAULT_SUMMARY, enabled: false });
    const { result } = mount();

    await waitFor(() => expect(result.current.summaryLoading).toBe(false));
    expect(result.current.summary).toBeNull();
  });
});

describe("résumé périodique · pipeline hybride et tâches proposées", () => {
  it("filtre les pubs, spams et codes TOTP avant le LLM et garde les tâches en suggestions", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ ...DEFAULT_SUMMARY, llmConsent: true });
    const threads = [
      ...THREADS,
      apiThread(4, "Boutique X", "Soldes -70% maintenant"),
      apiThread(5, "GitHub", "Code de vérification 482917"),
    ];
    const llmCalls = mockBackend(threads, {
      1: { category: "important", needs_reply: 0.9, has_task: 0.85, urgency: 2.2 },
      2: { category: "info", urgency: 0.8 },
      3: { category: "info", urgency: 0.6 },
      4: { category: "promo", urgency: 0.1 },
      5: { category: "auth_totp", totp_code: "482917", urgency: 1.8 },
    });
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });

    expect(llmCalls.length).toBeGreaterThan(0);
    expect(llmCalls.every((c) => !c.user.includes("Soldes -70%"))).toBe(true);
    expect(llmCalls.every((c) => !c.user.includes("482917"))).toBe(true);

    expect(result.current.summary?.headline).toBe(SUMMARY_JSON.accroche);
    expect(result.current.summary?.groups.actions[0].mailId).toBe(`${ALPHA}:INBOX:1`);
    expect(result.current.summary?.groups.infos[0].mailId).toBe(`${ALPHA}:INBOX:2`);
    expect(result.current.summary?.mailCount).toBe(threads.length);
    expect(result.current.tasks).toHaveLength(0);
    expect(result.current.tasks.some((task) => task.title === "Répondre à Camille")).toBe(false);

    expect(result.current.suggestions).toHaveLength(2);
    const proposals = result.current.suggestions.map((entry) => entry.proposal);
    expect(proposals).toContain("Répondre à Camille");
    expect(proposals).toContain("Classer la facture OVH");
    const linked = result.current.suggestions.find((entry) => entry.proposal === "Répondre à Camille");
    expect(linked?.mailId).toBe(`${ALPHA}:INBOX:1`);
    expect(linked?.subject).toBe("Maquettes v3");
    expect(linked?.due).toBe(formatDueDate(DUE_ISO));
    expect(linked?.ai).toBe(true);
    expect(linked?.account).toBe(ALPHA);
    expect(MAIL_SUGGESTIONS.every((entry) => entry.ai === undefined)).toBe(true);
  });

  it("ne propose pas deux fois la même tâche lors d'une régénération", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ ...DEFAULT_SUMMARY, llmConsent: true });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });
    expect(result.current.suggestions).toHaveLength(2);

    await act(async () => {
      await result.current.refreshSummary(true);
    });

    expect(result.current.suggestions).toHaveLength(2);
    expect(result.current.tasks).toHaveLength(0);
    expect(result.current.summary?.generatedAt).toBeGreaterThan(0);
  });
});
