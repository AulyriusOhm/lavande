import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
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
const H = 3_600_000;
const RECEIVED = new Date(Date.now() - H).toISOString();
const ATTACHMENT_BYTES = 317_440;

const apiAccount = (accountId: string): ApiAccount => ({
  id: accountId,
  label: accountId,
  email: `${accountId}@test.fr`,
  username: `${accountId}@test.fr`,
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 1,
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

const apiThread = (uid: number, from: string, subject: string, accountId: string, withFile = false): ApiThread => {
  const primary: ApiMessage = {
    account_id: accountId,
    folder_path: "INBOX",
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

function mockBackend() {
  const prompts: { system: string; user: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content?: string }[] };
      prompts.push({ system: body.messages?.[0]?.content ?? "", user: body.messages?.[1]?.content ?? "" });
      return reply({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) } }] });
    }
    if (path.endsWith("/api/accounts")) return reply([apiAccount(ALPHA), apiAccount(BETA)]);
    if (/\/api\/accounts\/[^/]+\/folders$/.test(path)) {
      return reply([apiFolder(ALPHA), apiFolder(BETA)]);
    }
    const list = path.match(/\/api\/accounts\/([^/]+)\/folders\/INBOX\/threads$/);
    if (list) return reply(THREADS.filter((thread) => thread.account_id === list[1]));
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
      summary: { ...DEFAULT_SUMMARY, llmConsent: true },
      aiTasks: { enabled: false },
    }),
  );

const cachedResult = () => {
  const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, { result: { headline: string } }>) : {};
};

beforeEach(() => {
  window.localStorage.clear();
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

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });
    expect(result.current.summary?.mailCount).toBe(THREADS.length);
    expect(summaryCalls(prompts).at(-1)?.user).toContain("Devis Léa");

    act(() => result.current.setAccount(ALPHA));

    await waitFor(() => expect(result.current.summary?.mailCount).toBe(2), { timeout: 3000 });
    expect(summaryCalls(prompts).at(-1)?.user).not.toContain("Devis Léa");
    expect(summaryCalls(prompts).at(-1)?.user).toContain("Maquettes v3");
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

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });
    act(() => result.current.setAccount(BETA));
    await waitFor(() => expect(result.current.summary?.mailCount).toBe(1), { timeout: 3000 });
    expect(summaryCalls(prompts)).toHaveLength(2);

    act(() => result.current.setAccount(ALL));

    await waitFor(() => expect(result.current.summary?.mailCount).toBe(THREADS.length), { timeout: 3000 });
    expect(summaryCalls(prompts).length).toBeLessThanOrEqual(3);
  });
});

describe("résumé IA · cache du passage", () => {
  it("réutilise le résultat persisté après un remontage, sans nouvelle requête", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const prompts = mockBackend();
    const first = mount();

    await waitFor(() => expect(first.result.current.summary?.source).toBe("llm"), { timeout: 3000 });
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
        summary: { ...DEFAULT_SUMMARY, llmConsent: true },
        aiTasks: { enabled: false },
        teamContext: {
          [ALPHA]: { identity: "Camille", role: "Produit", context: "", members: [{ name: "Marc", scope: "Dev" }] },
        },
      }),
    );
    const prompts = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });

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

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });
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

    await waitFor(() => expect(result.current.summary?.source).toBe("llm"), { timeout: 3000 });

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
