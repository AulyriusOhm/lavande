import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore, type MailStoreValue } from "@/lib/store";
import { isoToday } from "@/lib/tasks";
import { createMemoryStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };
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

const apiThread = (uid: number, from: string, subject: string, date: string, accountId = ALPHA): ApiThread => {
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
    date,
    flags: { unread: true, starred: false, answered: false },
    size: 512,
    pgp: "none",
    preview: `Aperçu ${uid}`,
    body_text: `Bonjour, peux-tu envoyer le compte rendu de la réunion ?\n\nMerci.\n\n${from}`,
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
const MAIL_ID = `${ALPHA}:INBOX:1`;
const DUE_ISO = isoToday(4);
const EVENT_DATE = isoToday(2);

const ANALYSIS_JSON = {
  taches: [
    { titre: "Envoyer le compte rendu", echeance: DUE_ISO, de: "Camille", mailId: MAIL_ID, assigne: "Camille" },
  ],
  evenements: [
    {
      titre: "Point maquettes",
      date: EVENT_DATE,
      debut: "14:00",
      fin: "15:00",
      lieu: "Visio",
      de: "Camille",
      mailId: MAIL_ID,
    },
  ],
};

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend(threads: ApiThread[], analysisJson: unknown = ANALYSIS_JSON, failChat = false) {
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
      return reply({ choices: [{ message: { content: JSON.stringify(analysisJson) } }] });
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
    JSON.stringify({ llm: LLM, summary: { enabled: false }, aiTasks: { enabled: false } }),
  );

async function openMailOf(result: { current: MailStoreValue }) {
  await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
  return result.current.mails[0];
}

const run = async (result: { current: MailStoreValue }, force?: boolean) => {
  const mail = result.current.openMail ?? result.current.mails[0];
  await act(async () => {
    await result.current.runAnalyse(mail, force);
  });
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

describe("analyse à la demande · appels au modèle", () => {
  it("analyse le mail ouvert et rend tâches, rendez-vous et créneaux", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    await openMailOf(result);

    await run(result);

    const analyse = result.current.analyse;
    expect(analyse?.mailId).toBe(MAIL_ID);
    expect(analyse?.status).toBe("ready");
    expect(analyse?.result?.source).toBe("llm");
    expect(analyse?.result?.tasks.map((task) => task.title)).toEqual(["Envoyer le compte rendu"]);
    expect(analyse?.result?.tasks[0].assignee).toBe("Camille");
    expect(analyse?.result?.events.map((event) => event.title)).toEqual(["Point maquettes"]);
    expect(analyse?.result?.slots.length).toBeGreaterThan(0);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].system).toContain("NON FIABLE");
    expect(llmCalls[0].user).toContain("<<<MAIL>>>");
    expect(llmCalls[0].user).toContain("compte rendu");
  });

  it("ne rappelle pas le modèle pour le même mail : cache local", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    await openMailOf(result);

    await run(result);
    expect(llmCalls).toHaveLength(1);

    act(() => {
      result.current.closeAnalyse();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(result.current.analyse).toBeNull();

    await run(result);

    expect(llmCalls).toHaveLength(1);
    expect(result.current.analyse?.status).toBe("ready");
    expect(result.current.analyse?.result?.tasks).toHaveLength(1);
  });

  it("force un nouveau passage sur « Réanalyser »", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    await openMailOf(result);

    await run(result);
    await run(result, true);

    expect(llmCalls).toHaveLength(2);
    expect(result.current.analyse?.status).toBe("ready");
  });

  it("ne fait aucun appel réseau en démo", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    const llmCalls = mockBackend([]);
    const { result } = mount();
    await openMailOf(result);

    await run(result);

    expect(llmCalls).toHaveLength(0);
    expect(result.current.analyse?.status).toBe("ready");
    expect(result.current.analyse?.result?.source).toBe("local");
    expect(result.current.analyse?.result?.tasks).toHaveLength(0);
  });

  it("passe en erreur quand le modèle échoue, puis réussit sur nouvelle tentative", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const failing = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], ANALYSIS_JSON, true);
    const { result } = mount();
    await openMailOf(result);

    await run(result);

    expect(failing).toHaveLength(1);
    expect(result.current.analyse?.status).toBe("error");
    expect(result.current.analyse?.error).toContain("exploitable");

    const working = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    await run(result, true);

    expect(working).toHaveLength(1);
    expect(result.current.analyse?.status).toBe("ready");
    expect(result.current.analyse?.result?.tasks).toHaveLength(1);
  });
});

describe("analyse à la demande · suggestions validées par l'humain", () => {
  it("une tâche acceptée devient une suggestion en attente, jamais une tâche", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    await openMailOf(result);
    await run(result);

    const task = result.current.analyse?.result?.tasks[0];
    expect(task).toBeDefined();
    act(() => {
      result.current.acceptAnalyseTask(task!);
    });

    const suggestion = result.current.suggestions.find((entry) => entry.proposal === "Envoyer le compte rendu");
    expect(suggestion?.mailId).toBe(MAIL_ID);
    expect(suggestion?.account).toBe(ALPHA);
    expect(suggestion?.assignee).toBe("Camille");
    expect(suggestion?.description).toContain("Analyse IA");
    expect(result.current.tasks.some((entry) => entry.title === "Envoyer le compte rendu")).toBe(false);
  });

  it("un rendez-vous accepté devient une suggestion en attente, jamais un événement", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    await openMailOf(result);
    await run(result);

    const event = result.current.analyse?.result?.events[0];
    expect(event).toBeDefined();
    act(() => {
      result.current.acceptAnalyseEvent(event!);
    });

    const suggestion = result.current.suggestions.find((entry) => entry.proposal === "Point maquettes");
    expect(suggestion?.mailId).toBe(MAIL_ID);
    expect(suggestion?.date).toBe(EVENT_DATE);
    expect(result.current.events.some((entry) => entry.title === "Point maquettes")).toBe(false);
    expect(result.current.notices.some((entry) => entry.message === "Rendez-vous proposé dans l'agenda")).toBe(true);
  });

  it("affiche un rendez-vous accepté même si le mail est plus vieux que la fenêtre", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const stale = new Date(Date.now() - 100 * H).toISOString();
    mockBackend([apiThread(1, "Camille", "Maquettes v3", stale)]);
    const { result } = mount();
    await openMailOf(result);
    await run(result);

    const event = result.current.analyse?.result?.events[0];
    expect(event).toBeDefined();
    act(() => {
      result.current.acceptAnalyseEvent(event!);
    });

    const shown = () => result.current.suggestions.filter((entry) => entry.proposal === "Point maquettes");
    expect(shown()).toHaveLength(1);
    expect(shown()[0].description).toContain("Analyse IA");
    const first = shown()[0].timestamp;
    expect(typeof first).toBe("number");
    expect(first!).toBeGreaterThan(Date.now() - H);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    });
    act(() => {
      result.current.acceptAnalyseEvent(event!);
    });

    expect(shown()).toHaveLength(1);
    expect(shown()[0].timestamp!).toBeGreaterThan(first!);
    expect(result.current.events.some((entry) => entry.title === "Point maquettes")).toBe(false);
    expect(
      result.current.notices.filter((entry) => entry.message === "Rendez-vous déjà proposé dans l'agenda"),
    ).toHaveLength(0);
    expect(
      result.current.notices.filter((entry) => entry.message === "Rendez-vous proposé dans l'agenda"),
    ).toHaveLength(2);
  });

  it("affiche un rendez-vous accepté même si le mail est déjà répondu", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    const thread = apiThread(1, "Camille", "Maquettes v3", RECEIVED);
    thread.primary.flags.answered = true;
    mockBackend([thread]);
    const { result } = mount();
    await openMailOf(result);
    await run(result);

    const event = result.current.analyse?.result?.events[0];
    expect(event).toBeDefined();
    act(() => {
      result.current.acceptAnalyseEvent(event!);
    });

    const shown = result.current.suggestions.filter((entry) => entry.proposal === "Point maquettes");
    expect(shown).toHaveLength(1);
    expect(shown[0].explicit).toBe(true);
    expect(result.current.notices.some((entry) => entry.message === "Rendez-vous proposé dans l'agenda")).toBe(true);
  });

  it("ouvre une réponse pré-remplie avec le corps suggéré", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    const mail = await openMailOf(result);

    act(() => {
      result.current.openReplyWithBody(mail, "Bonjour Camille,\n\nJe te confirme le créneau.");
    });

    expect(result.current.composeOpen).toBe(true);
    expect(result.current.composeTitle).toBe("Répondre");
    expect(result.current.composeDraft?.to).toBe("camille@test.fr");
    expect(result.current.composeDraft?.body).toContain("Je te confirme le créneau.");
    expect(result.current.composeDraft?.quoted).toContain("a écrit");
  });

  it("demande confirmation avant d'écraser un brouillon en cours", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    const mail = await openMailOf(result);

    act(() => {
      result.current.startBlankDraft();
    });
    act(() => {
      result.current.setComposeDraft({
        ...result.current.composeDraft!,
        to: "marc@test.fr",
        subject: "Note en cours",
        body: "Brouillon déjà écrit",
      });
    });
    act(() => {
      result.current.openReplyWithBody(mail, "Bonjour Camille,");
    });

    expect(result.current.composeDraft?.body).toBe("Brouillon déjà écrit");
    expect(result.current.notices.some((entry) => entry.message === "Abandonner le brouillon actuel ?")).toBe(true);

    const notice = result.current.notices.find((entry) => entry.message === "Abandonner le brouillon actuel ?");
    act(() => {
      notice?.onAction?.();
    });
    expect(result.current.composeDraft?.subject).toBe("Re: Maquettes v3");
    expect(result.current.composeDraft?.body).toContain("Bonjour Camille,");
    expect(
      result.current.notices.filter((entry) => entry.message === "Abandonner le brouillon actuel ?"),
    ).toHaveLength(1);
  });

  it("n'ajoute pas deux fois la même tâche acceptée", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs();
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)]);
    const { result } = mount();
    await openMailOf(result);
    await run(result);

    const task = result.current.analyse?.result?.tasks[0];
    act(() => {
      result.current.acceptAnalyseTask(task!);
      result.current.acceptAnalyseTask(task!);
    });

    expect(result.current.suggestions.filter((entry) => entry.proposal === "Envoyer le compte rendu")).toHaveLength(1);
  });
});
