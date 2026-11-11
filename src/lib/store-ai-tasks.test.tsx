import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { DEFAULT_SUMMARY } from "@/lib/summary";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };
const H = 3_600_000;

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

const apiThread = (uid: number, from: string, subject: string, date: string): ApiThread => {
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
    date,
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

const RECEIVED = new Date(Date.now() - H).toISOString();
const OLD = new Date(Date.now() - 72 * H).toISOString();
const MAIL_ID = `${ALPHA}:INBOX:1`;

const TASKS_JSON = {
  taches: [{ titre: "Envoyer le compte rendu", echeance: "2026-11-20", de: "Camille", mailId: MAIL_ID }],
};

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend(threads: ApiThread[]) {
  const llmCalls: { system: string; user: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { pathname } = new URL(url, "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { role?: string; content?: string }[];
      };
      llmCalls.push({
        system: body.messages?.[0]?.content ?? "",
        user: body.messages?.[1]?.content ?? "",
      });
      return reply({ choices: [{ message: { content: JSON.stringify(TASKS_JSON) } }] });
    }
    if (path.endsWith("/api/accounts")) return reply([apiAccount()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders`)) return reply([apiFolder()]);
    if (path.endsWith(`/api/accounts/${ALPHA}/folders/INBOX/threads`)) return reply(threads);
    return reply([]);
  });
  return llmCalls;
}

function mount(storage?: SyncStorage) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={storage ?? createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return renderHook(() => useMailStore(), { wrapper });
}

const seedPrefs = (aiTasks: Record<string, unknown>, summary: Record<string, unknown> = { enabled: false }) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ llm: LLM, summary, aiTasks }));

const suggestionDoc = (id: string, proposal: string, timestamp?: number): Doc => ({
  id,
  kind: "suggestion",
  v: LOCAL_SCHEMA_VERSION,
  raw: {
    status: "pending",
    mailId: `mail-${id}`,
    account: "perso",
    from: "Camille",
    subject: "Maquettes",
    proposal,
    due: "sans échéance",
    dueTone: "soft",
    tone: 0,
    description: "",
    ...(timestamp === undefined ? {} : { timestamp }),
  },
  fields: {},
  readOnly: false,
  updatedAt: new Date(0).toISOString(),
});

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("suggestions de tâches IA · fenêtre des 48 h", () => {
  it("propose les tâches du modèle pour les mails de la fenêtre, horodatées", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.proposal === "Envoyer le compte rendu")).toBe(true),
      { timeout: 3000 },
    );

    const proposal = result.current.suggestions.find((entry) => entry.proposal === "Envoyer le compte rendu");
    expect(proposal?.mailId).toBe(MAIL_ID);
    expect(proposal?.due).toBe("ven 20 nov");
    expect(proposal?.timestamp).toBe(Date.parse(RECEIVED));
    expect(proposal?.ai).toBe(true);
    expect(proposal?.account).toBe(ALPHA);
    expect(result.current.tasks.some((task) => task.title === "Envoyer le compte rendu")).toBe(false);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].system).toContain("NON FIABLE");
    expect(llmCalls[0].user).toContain("<<<MAILS>>>");
  });

  it("n'envoie rien au modèle quand aucun mail n'est dans la fenêtre", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", OLD)]);
    const { result } = mount();

    await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(llmCalls).toHaveLength(0);
    expect(result.current.suggestions).toHaveLength(0);
  });

  it("respecte une fenêtre personnalisée plus courte", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 1 });
    const llmCalls = mockBackend([
      apiThread(1, "Camille", "Maquettes v3", new Date(Date.now() - 2 * H).toISOString()),
    ]);
    const { result } = mount();

    await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(llmCalls).toHaveLength(0);
    expect(result.current.suggestions).toHaveLength(0);
  });

  it("ne sollicite pas le modèle quand la préférence est désactivée", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: false, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();

    await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(llmCalls).toHaveLength(0);
    expect(result.current.suggestions).toHaveLength(0);
  });
});

describe("suggestions de tâches IA · filtre d'affichage", () => {
  it("masque une suggestion dont le mail source est sorti de la fenêtre", async () => {
    seedPrefs({ enabled: true, windowHours: 48 });
    const base = emptyState(createDevice("test", "test"));
    const docs = {
      [docKey("suggestion", "sg:vieille")]: suggestionDoc("sg:vieille", "Ancienne relance", Date.now() - 60 * H),
      [docKey("suggestion", "sg:recente")]: suggestionDoc("sg:recente", "Relance du jour", Date.now() - H),
      [docKey("suggestion", "sg:demo")]: suggestionDoc("sg:demo", "Sans horodatage"),
    };
    const storage = createMemoryStorage({ ...base, docs });
    const { result } = mount(storage);

    expect(result.current.suggestions.map((entry) => entry.proposal).sort()).toEqual([
      "Relance du jour",
      "Sans horodatage",
    ]);
  });

  it("suit la fenêtre configurée", async () => {
    seedPrefs({ enabled: true, windowHours: 1 });
    const base = emptyState(createDevice("test", "test"));
    const docs = {
      [docKey("suggestion", "sg:vieille")]: suggestionDoc("sg:vieille", "Ancienne relance", Date.now() - 2 * H),
      [docKey("suggestion", "sg:recente")]: suggestionDoc("sg:recente", "Relance du jour", Date.now() - 60_000),
    };
    const storage = createMemoryStorage({ ...base, docs });
    const { result } = mount(storage);

    expect(result.current.suggestions.map((entry) => entry.proposal)).toEqual(["Relance du jour"]);
  });
});
