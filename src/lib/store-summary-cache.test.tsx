import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMailDecision, ApiMessage, ApiThread } from "@/lib/api";
import { decisionDb } from "@/lib/decision-db";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { DEFAULT_SUMMARY, SUMMARY_CACHE_KEY, currentPeriod } from "@/lib/summary";
import { formatBytes } from "@/lib/draft";
import { createMemoryStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const BETA = "beta";
const ALL = "all";
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };
const DECISION_CFG = {
  enabled: true,
  endpoint: "https://decision.test/v1/systemone",
  model: "mammoth-1",
  apiKey: "nw-test",
};
const H = 3_600_000;
const RECEIVED = new Date(Date.now() - H).toISOString();
const ATTACHMENT_BYTES = 317_440;

const apiAccount = (accountId: string, aiFolders?: string[] | null): ApiAccount => ({
  id: accountId,
  label: accountId,
  email: `${accountId}@test.fr`,
  username: `${accountId}@test.fr`,
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 1,
  ...(aiFolders === undefined ? {} : { ai_folders: aiFolders }),
});

const apiFolder = (accountId: string): ApiFolder => ({
  account_id: accountId,
  path: "INBOX",
  name: "Boîte de réception",
  role: "inbox",
  uidvalidity: 1,
  uidnext: 4,
  last_sync_at: null,
});

/** Sous-dossier perso du compte de travail : le cas qui échappait au résumé. */
const SUB_FOLDER = "INBOX/Informatique";

const subFolder = (accountId: string): ApiFolder => ({
  account_id: accountId,
  path: SUB_FOLDER,
  name: "Informatique",
  role: "other",
  uidvalidity: 2,
  uidnext: 2,
  last_sync_at: null,
});

const apiThread = (
  uid: number,
  from: string,
  subject: string,
  accountId: string,
  withFile = false,
  folderPath = "INBOX",
): ApiThread => {
  const primary: ApiMessage = {
    account_id: accountId,
    folder_path: folderPath,
    uid,
    uidvalidity: 1,
    thread_id: `t-${accountId}-${uid}`,
    message_id: `<${uid}@test.fr>`,
    in_reply_to: null,
    references: [],
    from: { name: from, email: `${from.toLowerCase()}@test.fr` },
    to: [{ name: null, email: `${accountId}@test.fr` }],
    cc: [],
    subject,
    date: RECEIVED,
    flags: { unread: true, starred: false, answered: false },
    size: 512,
    pgp: "none",
    preview: `Aperçu ${uid}`,
    body_text: `Corps ${uid}`,
    body_html: null,
    attachments: withFile
      ? [{ filename: "avenant-phase2.pdf", mime: "application/pdf", size: ATTACHMENT_BYTES, inline: false }]
      : [],
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
    attachments: withFile ? 1 : 0,
    participants: [primary.from.email],
    subject,
    preview: primary.preview,
  };
};

const THREADS = [
  apiThread(1, "Camille", "Maquettes v3", ALPHA, true),
  apiThread(2, "Marc", "Accès serveur", ALPHA),
  apiThread(3, "Léa", "Devis Léa", BETA),
];

const summaryPrompt = (system: string) => system.includes("briefing d'emails");

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

const SUMMARY_JSON = {
  accroche: "Camille attend un retour sur la v3.",
  actions: [{ mailId: `${ALPHA}:INBOX:1`, raison: "Répondre à Camille sur la v3", echeance: "2026-11-20" }],
  infos: [{ mailId: `${ALPHA}:INBOX:2`, raison: "Accès serveur" }],
  notifications: [],
  taches: [{ titre: "Répondre à Camille", echeance: "2026-11-20", de: "Camille", mailId: `${ALPHA}:INBOX:1` }],
};

const apiDecision = (
  accountId: string,
  uid: number,
  overrides: Partial<ApiMailDecision> = {},
): ApiMailDecision => ({
  account_id: accountId,
  folder_path: "INBOX",
  uid,
  message_id: `<${uid}@test.fr>`,
  content_hash: `h-${accountId}-${uid}`,
  schema_version: 1,
  model: "mammoth-1",
  category: uid === 1 ? "important" : "info",
  category_conf: 0.92,
  category_probs: { [uid === 1 ? "important" : "info"]: 0.92 },
  urgency: uid === 1 ? 2.2 : 0.8,
  needs_reply: uid === 1 ? 0.9 : 0.2,
  has_task: uid === 1 ? 0.85 : 0.2,
  has_event: 0.1,
  security: "safe",
  security_conf: 0.99,
  cleanup_score: 0.05,
  decided_at: Math.floor(Date.now() / 1000),
  source: "local",
  ...overrides,
});

const SUB_THREAD = apiThread(9, "Nadia", "Badge d'accès", ALPHA, false, SUB_FOLDER);

/** `informatique` ajoute au compte ALPHA un sous-dossier perso et son message. */
function mockBackend(
  options: { informatique?: boolean; aiFolders?: Record<string, string[] | null> } = {},
) {
  const prompts: { system: string; user: string }[] = [];
  const folders = [apiFolder(ALPHA), apiFolder(BETA)];
  if (options.informatique) folders.push(subFolder(ALPHA));
  const threads = options.informatique ? [...THREADS, SUB_THREAD] : THREADS;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content?: string }[] };
      prompts.push({ system: body.messages?.[0]?.content ?? "", user: body.messages?.[1]?.content ?? "" });
      return reply({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) } }] });
    }
    if (path.endsWith("/api/ai/decisions/triage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        targets?: { account_id: string; uid: number }[];
      };
      return reply({
        results: (body.targets ?? []).map((target) => ({
          decision: apiDecision(target.account_id, target.uid),
          cached: false,
        })),
        errors: [],
      });
    }
    if (path.endsWith("/api/accounts")) {
      const account = (id: string) => apiAccount(id, options.aiFolders?.[id]);
      return reply([account(ALPHA), account(BETA)]);
    }
    if (/\/api\/accounts\/[^/]+\/folders$/.test(path)) return reply(folders);
    const list = path.match(/\/api\/accounts\/([^/]+)\/folders\/(.+)\/threads$/);
    if (list) {
      return reply(
        threads.filter(
          (thread) => thread.account_id === list[1] && thread.primary.folder_path === list[2],
        ),
      );
    }
    return reply([]);
  });
  return prompts;
}

const summaryCalls = (prompts: { system: string; user: string }[]) =>
  prompts.filter((prompt) => summaryPrompt(prompt.system));

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

const seedPrefs = () =>
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({
      llm: LLM,
      decision: DECISION_CFG,
      summary: { ...DEFAULT_SUMMARY, llmConsent: true },
      aiTasks: { enabled: false },
    }),
  );

const cachedResult = () => {
  const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, { result: { headline: string } }>) : {};
};

beforeEach(async () => {
  window.localStorage.clear();
  await decisionDb().clearDecisions();
  await decisionDb().clearLlmExtractions();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("résumé IA · portée de la boîte sélectionnée", () => {
  it("analyse tous les comptes, puis seulement le compte sélectionné", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const prompts = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });
    expect(result.current.summary?.mailCount).toBe(THREADS.length);
    expect(summaryCalls(prompts).at(-1)?.user).toContain("Devis Léa");

    act(() => result.current.setAccount(ALPHA));

    await waitFor(() => expect(result.current.summary?.mailCount).toBe(2), { timeout: 3000 });
    expect(result.current.summary?.mailIds).toEqual([`${ALPHA}:INBOX:1`, `${ALPHA}:INBOX:2`]);
    expect(summaryCalls(prompts)).toHaveLength(1);
    expect(Object.keys(cachedResult()).some((key) => key.startsWith(`${ALPHA}:${currentPeriod(DEFAULT_SUMMARY).id}:`))).toBe(
      true,
    );
  });

  it("restreint le passage aux mails de la boîte choisie en démo", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    seedPrefs();
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(new Set(result.current.summaryMails.map((mail) => mail.account)).size).toBeGreaterThan(1);

    act(() => result.current.setAccount("perso"));

    await waitFor(() =>
      expect(result.current.summaryMails.every((mail) => mail.account === "perso")).toBe(true),
    );
    expect(result.current.summary?.mailCount).toBe(result.current.summaryMails.length);
    expect(result.current.summaryMails.length).toBeGreaterThan(0);
  });

  it("retrouve le cache d'un compte sans rappeler le modèle en revenant dessus", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const prompts = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });
    act(() => result.current.setAccount(BETA));
    await waitFor(() => expect(result.current.summary?.mailCount).toBe(1), { timeout: 3000 });
    expect(summaryCalls(prompts)).toHaveLength(1);

    act(() => result.current.setAccount(ALL));

    await waitFor(() => expect(result.current.summary?.mailCount).toBe(THREADS.length), { timeout: 3000 });
    expect(summaryCalls(prompts)).toHaveLength(1);
  });
});

describe("résumé IA · cache du passage", () => {
  it("réutilise le résultat persisté après un remontage, sans nouvelle requête", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const prompts = mockBackend();
    const first = mount();

    await waitFor(() => expect(first.result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });
    const headline = first.result.current.summary?.headline;
    expect(summaryCalls(prompts)).toHaveLength(1);
    first.unmount();

    const second = mount();

    await waitFor(() => expect(second.result.current.summary?.headline).toBe(headline), { timeout: 3000 });
    expect(second.result.current.summary?.groups.actions).toHaveLength(1);
    expect(summaryCalls(prompts)).toHaveLength(1);
    expect(second.result.current.summary?.mailCount).toBe(THREADS.length);
  });

  it("joint le contexte d'équipe fiable au prompt du résumé", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        llm: LLM,
        decision: DECISION_CFG,
        summary: { ...DEFAULT_SUMMARY, llmConsent: true },
        aiTasks: { enabled: false },
        teamContext: {
          [ALPHA]: { identity: "Camille", role: "Produit", context: "", members: [{ name: "Marc", scope: "Dev" }] },
        },
      }),
    );
    const prompts = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });

    const system = summaryCalls(prompts).at(-1)?.system ?? "";
    expect(system).toContain("CONTEXTE UTILISATEUR");
    expect(system).toContain("Marc — Dev");
    expect(system.indexOf("NON FIABLE")).toBeLessThan(system.indexOf("CONTEXTE UTILISATEUR"));
  });

  it("ne relance le modèle que sur « Régénérer »", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const prompts = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });
    await act(async () => {
      await result.current.refreshSummary(true);
    });

    expect(summaryCalls(prompts)).toHaveLength(2);
    expect(result.current.summary?.mailCount).toBe(THREADS.length);
  });

  it("n'écrit rien quand le résumé reste local", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    seedPrefs();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.summary?.source).toBe("fallback");
    expect(cachedResult()).toEqual({});
    expect(result.current.summary?.mailIds.length).toBeGreaterThan(0);
  });
});

describe("résumé IA · pièces jointes des mails analysés", () => {
  it("expose les mails analysés et leurs pièces jointes à l'affichage", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });

    const ids = result.current.summaryMails.map((mail) => mail.id).sort();
    expect(ids).toEqual(
      THREADS.map((thread) => `${thread.account_id}:INBOX:${thread.primary.uid}`).sort(),
    );
    const files = result.current.summaryMails.flatMap((mail) => mail.attachments ?? []);
    expect(files).toEqual([
      {
        name: "avenant-phase2.pdf",
        size: formatBytes(ATTACHMENT_BYTES),
        mime: "application/pdf",
        index: 0,
        inline: false,
      },
    ]);
  });
});

describe("résumé IA · dossiers analysés par compte", () => {
  const mailId = (thread: ApiThread) =>
    `${thread.account_id}:${thread.primary.folder_path}:${thread.primary.uid}`;

  it("couvre le sous-dossier perso depuis la boîte unifiée", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend({ informatique: true });
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });
    expect(result.current.folder).toBe("unified");
    expect(result.current.summary?.mailIds.sort()).toEqual(
      [
        apiThread(1, "Camille", "Maquettes v3", ALPHA),
        apiThread(2, "Marc", "Accès serveur", ALPHA),
        apiThread(3, "Léa", "Devis Léa", BETA),
        SUB_THREAD,
      ]
        .map(mailId)
        .sort(),
    );
    expect(
      result.current.summaryMails.some((mail) => mail.source?.folderPath === SUB_FOLDER),
    ).toBe(true);
  });

  it("garde le sous-dossier analysé quand la vue se réduit à la réception", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend({ informatique: true });
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });
    act(() => result.current.setFolder("inbox", null));

    await waitFor(() => expect(result.current.folder).toBe("inbox"));
    await waitFor(() =>
      expect(result.current.mails.every((mail) => mail.source?.folderPath === "INBOX")).toBe(true),
    );
    expect(result.current.mails.some((mail) => mail.source?.folderPath === SUB_FOLDER)).toBe(false);
    expect(result.current.summary?.mailIds).toContain(mailId(SUB_THREAD));
    expect(
      result.current.summaryMails.some((mail) => mail.source?.folderPath === SUB_FOLDER),
    ).toBe(true);
  });

  it("suit la sélection explicite du compte quand elle écarte le sous-dossier", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend({ informatique: true, aiFolders: { [ALPHA]: ["INBOX"] } });
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("hybrid"), { timeout: 3000 });

    expect(result.current.summary?.mailIds.sort()).toEqual(
      [
        apiThread(1, "Camille", "Maquettes v3", ALPHA),
        apiThread(2, "Marc", "Accès serveur", ALPHA),
        apiThread(3, "Léa", "Devis Léa", BETA),
      ]
        .map(mailId)
        .sort(),
    );
    expect(result.current.summary?.mailIds).not.toContain(mailId(SUB_THREAD));
  });

  it("relit la portée dès qu'un réglage change la sélection du compte", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend({ informatique: true });
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.mailIds).toContain(mailId(SUB_THREAD)), {
      timeout: 3000,
    });

    act(() => result.current.applyAiFolders(ALPHA, ["INBOX"]));

    await waitFor(
      () => expect(result.current.summary?.mailIds).not.toContain(mailId(SUB_THREAD)),
      { timeout: 3000 },
    );
    expect(result.current.summary?.mailIds).toContain(mailId(THREADS[0]));
  });

  it("n'analyse rien quand la sélection du compte est vide", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend({ informatique: true, aiFolders: { [ALPHA]: [], [BETA]: [] } });
    const { result } = mount();

    await waitFor(() => expect(result.current.summary).not.toBeNull(), { timeout: 3000 });
    expect(result.current.summary?.mailCount).toBe(0);
    expect(result.current.summary?.mailIds).toEqual([]);
  });
});
