import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMailDecision, ApiMessage, ApiThread } from "@/lib/api";
import { decisionDb } from "@/lib/decision-db";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { formatDueDate, isoToday } from "@/lib/tasks";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };
const DECISION_CFG = {
  enabled: true,
  endpoint: "https://decision.test/v1/systemone",
  model: "mammoth-1",
  apiKey: "nw-test",
};
const H = 3_600_000;

const apiAccount = (accountId = ALPHA): ApiAccount => ({
  id: accountId,
  label: accountId,
  email: `${accountId}@test.fr`,
  username: `${accountId}@test.fr`,
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 1,
});

const apiFolder = (accountId = ALPHA): ApiFolder => ({
  account_id: accountId,
  path: "INBOX",
  name: "Boîte de réception",
  role: "inbox",
  uidvalidity: 1,
  uidnext: 4,
  last_sync_at: null,
});

const apiThread = (
  uid: number,
  from: string,
  subject: string,
  date: string,
  accountId = ALPHA,
  answered = false,
): ApiThread => {
  const primary: ApiMessage = {
    account_id: accountId,
    folder_path: "INBOX",
    uid,
    uidvalidity: 1,
    thread_id: `t-${accountId}-${uid}`,
    message_id: `<${accountId}-${uid}@test.fr>`,
    in_reply_to: null,
    references: [],
    from: { name: from, email: `${from.toLowerCase()}@test.fr` },
    to: [{ name: null, email: `${accountId}@test.fr` }],
    cc: [],
    subject,
    date,
    flags: { unread: true, starred: false, answered },
    size: 512,
    pgp: "none",
    preview: `Aperçu ${uid}`,
    body_text: `Corps ${uid}`,
    body_html: null,
    attachments: [],
  };
  return {
    id: primary.thread_id,
    account_id: accountId,
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
const DUE_ISO = isoToday(4);
const DUE_LABEL = formatDueDate(DUE_ISO);

const TASKS_JSON = {
  taches: [{ titre: "Envoyer le compte rendu", echeance: DUE_ISO, de: "Camille", mailId: MAIL_ID }],
};

const apiDecision = (
  accountId: string,
  uid: number,
  overrides: Partial<ApiMailDecision> = {},
): ApiMailDecision => ({
  account_id: accountId,
  folder_path: "INBOX",
  uid,
  message_id: `<${accountId}-${uid}@test.fr>`,
  content_hash: `h-${accountId}-${uid}`,
  schema_version: 1,
  model: "mammoth-1",
  category: "important",
  category_conf: 0.92,
  category_probs: { important: 0.92 },
  urgency: 1.5,
  needs_reply: 0.5,
  has_task: 0.9,
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

function mockBackend(
  threads: ApiThread[],
  tasksJson: unknown = TASKS_JSON,
  failChat = false,
  decisionsByUid: Record<number, Partial<ApiMailDecision>> = {},
) {
  const llmCalls: { system: string; user: string }[] = [];
  const accountIds = threads.length > 0 ? [...new Set(threads.map((thread) => thread.account_id))] : [ALPHA];
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
      if (failChat) throw new Error("réseau");
      return reply({ choices: [{ message: { content: JSON.stringify(tasksJson) } }] });
    }
    if (path.endsWith("/api/ai/decisions/triage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        targets?: { account_id: string; uid: number }[];
      };
      return reply({
        results: (body.targets ?? []).map((t) => ({
          decision: apiDecision(t.account_id, t.uid, decisionsByUid[t.uid]),
          cached: false,
        })),
        errors: [],
      });
    }
    if (path.endsWith("/api/accounts")) return reply(accountIds.map((accountId) => apiAccount(accountId)));
    const folders = path.match(/\/api\/accounts\/([^/]+)\/folders$/);
    if (folders) return reply([apiFolder(folders[1])]);
    const list = path.match(/\/api\/accounts\/([^/]+)\/folders\/INBOX\/threads$/);
    if (list) return reply(threads.filter((thread) => thread.account_id === list[1]));
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

const seedPrefs = (
  aiTasks: Record<string, unknown>,
  summary: Record<string, unknown> = { enabled: false },
  withDecision = true,
) =>
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({
      llm: LLM,
      summary,
      aiTasks,
      ...(withDecision ? { decision: DECISION_CFG } : {}),
    }),
  );

const suggestionDoc = (id: string, proposal: string, timestamp?: number, account = "perso"): Doc => ({
  id,
  kind: "suggestion",
  v: LOCAL_SCHEMA_VERSION,
  raw: {
    status: "pending",
    mailId: `mail-${id}`,
    account,
    from: "Camille",
    subject: "Maquettes",
    proposal,
    due: "",
    dueTone: "none",
    tone: 0,
    description: "",
    ...(timestamp === undefined ? {} : { timestamp }),
  },
  fields: {},
  readOnly: false,
  updatedAt: new Date(0).toISOString(),
});

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

describe("suggestions de tâches IA · fenêtre des 48 h et modèle de décision", () => {
  it("n'émet aucun appel LLM automatique sans modèle de décision ni décisions en cache", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 }, { enabled: false }, false);
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();

    await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 40));

    expect(llmCalls).toHaveLength(0);
    expect(result.current.suggestions).toHaveLength(0);
  });

  it("filtre promo, spam et auth_totp avant le LLM et propose les tâches qualifiées", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    const llmCalls = mockBackend(
      [
        apiThread(1, "Camille", "Maquettes v3", RECEIVED),
        apiThread(2, "Boutique X", "Promo flash -50%", RECEIVED),
        apiThread(3, "GitHub", "Code 482917", RECEIVED),
      ],
      TASKS_JSON,
      false,
      {
        1: { category: "important", has_task: 0.9 },
        2: { category: "promo", has_task: 0.95 },
        3: { category: "auth_totp", has_task: 0.95, totp_code: "482917" },
      },
    );
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.proposal === "Envoyer le compte rendu")).toBe(true),
      { timeout: 3000 },
    );

    const proposal = result.current.suggestions.find((entry) => entry.proposal === "Envoyer le compte rendu");
    expect(proposal?.mailId).toBe(MAIL_ID);
    expect(proposal?.due).toBe(DUE_LABEL);
    expect(proposal?.dueTone).toBe("soft");
    expect(proposal?.description).toBe(`Suggestion IA · échéance ${DUE_LABEL}`);
    expect(proposal?.timestamp).toBe(Date.parse(RECEIVED));
    expect(proposal?.ai).toBe(true);
    expect(proposal?.account).toBe(ALPHA);
    expect(result.current.tasks.some((task) => task.title === "Envoyer le compte rendu")).toBe(false);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].system).toContain("NON FIABLE");
    expect(llmCalls[0].user).toContain("Maquettes v3");
    expect(llmCalls[0].user).not.toContain("Promo flash");
    expect(llmCalls[0].user).not.toContain("482917");
  });

  it("n'invente ni date ni mention quand le modèle ne donne pas d'échéance", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], {
      taches: [{ titre: "Envoyer le compte rendu", de: "Camille", mailId: MAIL_ID }],
    });
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.proposal === "Envoyer le compte rendu")).toBe(true),
      { timeout: 3000 },
    );

    const proposal = result.current.suggestions.find((entry) => entry.proposal === "Envoyer le compte rendu");
    expect(proposal?.due).toBe("");
    expect(proposal?.dueTone).toBe("none");
    expect(proposal?.description).toBe("Suggestion IA");
    expect(proposal?.description).not.toContain("sans échéance");
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

  it("ne propose aucune tâche pour un mail déjà traité, sans l'écarter du modèle", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED, ALPHA, true)]);
    const { result } = mount();

    await waitFor(() => expect(llmCalls).toHaveLength(1), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(llmCalls[0].user).toContain("Maquettes v3");
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

describe("suggestions de tâches IA · dédup et mémoire des passages", () => {
  it("ne crée qu'une suggestion pour une action reformulée du même mail", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], {
      taches: [
        { titre: "Envoyer le compte rendu", echeance: DUE_ISO, de: "Camille", mailId: MAIL_ID },
        { titre: "Compte rendu à envoyer", echeance: DUE_ISO, de: "Camille", mailId: MAIL_ID },
      ],
    });
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.proposal === "Envoyer le compte rendu")).toBe(true),
      { timeout: 3000 },
    );
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(result.current.suggestions).toHaveLength(1);
  });

  it("un passage en échec n'est pas mémoïsé : nouvelle tentative au remontage", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    const firstCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], TASKS_JSON, true);
    const first = mount();
    await waitFor(() => expect(firstCalls).toHaveLength(1), { timeout: 3000 });
    expect(window.localStorage.getItem("lavande.ai.runs.v1")).toBeNull();
    first.unmount();
    const secondCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], TASKS_JSON, true);
    mount();
    await waitFor(() => expect(secondCalls).toHaveLength(1), { timeout: 3000 });
  });

  it("ignore une mémoire de passages corrompue et rappelle le modèle", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    window.localStorage.setItem("lavande.ai.runs.v1", "{pas du json");
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.proposal === "Envoyer le compte rendu")).toBe(true),
      { timeout: 3000 },
    );

    expect(llmCalls).toHaveLength(1);
  });

  it("ne rappelle pas le modèle pour le même passage après un remontage", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const first = mount();

    await waitFor(
      () => expect(first.result.current.suggestions.some((entry) => entry.proposal === "Envoyer le compte rendu")).toBe(true),
      { timeout: 3000 },
    );
    expect(llmCalls).toHaveLength(1);

    const runs = JSON.parse(window.localStorage.getItem("lavande.ai.runs.v1") ?? "{}") as {
      tasks?: Record<string, number>;
    };
    expect(Object.keys(runs.tasks ?? {})).toHaveLength(1);

    first.unmount();
    const second = mount();

    await waitFor(() => expect(second.result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(llmCalls).toHaveLength(1);
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

  it("masque une suggestion dont le mail source a été traité depuis", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: false, windowHours: 48 });
    mockBackend([
      apiThread(1, "Camille", "Maquettes v3", RECEIVED, ALPHA, true),
      apiThread(2, "Marc", "Accès serveur", RECEIVED),
    ]);
    const base = emptyState(createDevice("test", "test"));
    const traitee = suggestionDoc("sg:traitee", "Envoyer le compte rendu", Date.now() - H);
    const ouverte = suggestionDoc("sg:ouverte", "Relancer Marc", Date.now() - H);
    const docs = {
      [docKey("suggestion", "sg:traitee")]: {
        ...traitee,
        raw: { ...traitee.raw, mailId: MAIL_ID, account: ALPHA },
      },
      [docKey("suggestion", "sg:ouverte")]: {
        ...ouverte,
        raw: { ...ouverte.raw, mailId: `${ALPHA}:INBOX:2`, account: ALPHA },
      },
    };
    const { result } = mount(createMemoryStorage({ ...base, docs }));

    await waitFor(() => expect(result.current.mails).toHaveLength(2), { timeout: 3000 });
    await waitFor(() => expect(result.current.suggestions.map((entry) => entry.proposal)).toEqual(["Relancer Marc"]));
  });

  it("masque les suggestions déjà stockées d'un compte exclu", () => {
    seedPrefs({ enabled: true, windowHours: 48, excludedAccounts: ["perso"] });
    const base = emptyState(createDevice("test", "test"));
    const docs = {
      [docKey("suggestion", "sg:perso")]: suggestionDoc("sg:perso", "Relance perso", Date.now() - H, "perso"),
      [docKey("suggestion", "sg:pro")]: suggestionDoc("sg:pro", "Relance pro", Date.now() - H, "pro"),
    };
    const storage = createMemoryStorage({ ...base, docs });
    const { result } = mount(storage);

    expect(result.current.suggestions.map((entry) => entry.proposal)).toEqual(["Relance pro"]);
  });
});

describe("suggestions de tâches IA · exclusion par compte", () => {
  const SECOND = "beta";
  const SECOND_MAIL_ID = `${SECOND}:INBOX:2`;

  it("n'envoie pas au modèle les mails d'un compte exclu", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48, excludedAccounts: [SECOND] });
    const llmCalls = mockBackend([
      apiThread(1, "Camille", "Maquettes v3", RECEIVED),
      apiThread(2, "Marc", "Accès serveur", RECEIVED, SECOND),
    ]);
    const { result } = mount();

    await waitFor(() => expect(result.current.mails.length).toBe(2), { timeout: 3000 });
    await waitFor(() => expect(llmCalls.length).toBeGreaterThan(0), { timeout: 3000 });

    expect(llmCalls.every((call) => !call.user.includes("Accès serveur"))).toBe(true);
    expect(llmCalls[llmCalls.length - 1].user).toContain("Maquettes v3");
  });

  it("écarte la tâche proposée par le résumé quand son mail vient d'un compte exclu", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs(
      { enabled: false, windowHours: 48, excludedAccounts: [SECOND] },
      { enabled: true, llmConsent: true },
    );
    mockBackend(
      [apiThread(1, "Camille", "Maquettes v3", RECEIVED), apiThread(2, "Marc", "Accès serveur", RECEIVED, SECOND)],
      { accroche: "Deux mails", taches: [{ titre: "Relancer Marc", echeance: "2026-11-20", de: "Marc", mailId: SECOND_MAIL_ID }] },
    );
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.headline).toBe("Deux mails"), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(result.current.suggestions).toHaveLength(0);
  });

  it("garde la tâche du résumé quand son compte n'est pas exclu", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: false, windowHours: 48 }, { enabled: true, llmConsent: true });
    mockBackend(
      [apiThread(1, "Camille", "Maquettes v3", RECEIVED), apiThread(2, "Marc", "Accès serveur", RECEIVED, SECOND)],
      { accroche: "Deux mails", taches: [{ titre: "Relancer Marc", echeance: "2026-11-20", de: "Marc", mailId: SECOND_MAIL_ID }] },
    );
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.headline).toBe("Deux mails"), { timeout: 3000 });

    const proposal = result.current.suggestions.find((entry) => entry.proposal === "Relancer Marc");
    expect(proposal?.account).toBe(SECOND);
    expect(proposal?.mailId).toBe(SECOND_MAIL_ID);
  });
});
