import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { formatDueDate, isoDate } from "@/lib/tasks";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const BETA = "beta";
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };
const H = 3_600_000;
const DAY = isoDate(new Date(Date.now() + 5 * 24 * H));
const MAIL_ID = `${ALPHA}:INBOX:1`;
const BETA_MAIL_ID = `${BETA}:INBOX:2`;

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
    message_id: `<${uid}@test.fr>`,
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

const event = (overrides: Record<string, unknown> = {}) => ({
  titre: "Point maquettes v3",
  date: DAY,
  debut: "10:00",
  fin: "10:30",
  lieu: "Visio",
  de: "Camille",
  mailId: MAIL_ID,
  ...overrides,
});

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend(threads: ApiThread[], evenements: unknown[]) {
  const llmCalls: { system: string; user: string }[] = [];
  const accountIds = threads.length > 0 ? [...new Set(threads.map((thread) => thread.account_id))] : [ALPHA];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { role?: string; content?: string }[];
      };
      llmCalls.push({
        system: body.messages?.[0]?.content ?? "",
        user: body.messages?.[1]?.content ?? "",
      });
      return reply({ choices: [{ message: { content: JSON.stringify({ evenements }) } }] });
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

const seedPrefs = (aiTasks: Record<string, unknown>) =>
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({ llm: LLM, summary: { enabled: false }, aiTasks }),
  );

const eventCalls = (calls: { system: string; user: string }[]) =>
  calls.filter((call) => call.system.includes("evenements"));

const storedEvents = (storage: SyncStorage, account = ALPHA): Doc[] =>
  Object.values(storage.read().docs).filter(
    (doc) => doc.kind === "suggestion" && doc.raw.kind === "event" && doc.raw.account === account,
  );

const eventDoc = (id: string, account = "perso"): Doc => ({
  id,
  kind: "suggestion",
  v: LOCAL_SCHEMA_VERSION,
  raw: {
    status: "pending",
    kind: "event",
    mailId: `mail-${id}`,
    account,
    from: "Camille",
    subject: "Maquettes",
    proposal: "Point maquettes v3",
    due: "",
    dueTone: "none",
    tone: 0,
    description: "",
    date: DAY,
    start: "10:00",
    end: "10:30",
    timestamp: Date.now() - H,
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

describe("suggestions de rendez-vous IA · génération", () => {
  it("propose les rendez-vous du modèle pour les mails de la fenêtre", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event()]);
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.kind === "event")).toBe(true),
      { timeout: 3000 },
    );

    const proposal = result.current.suggestions.find((entry) => entry.kind === "event");
    expect(proposal?.proposal).toBe("Point maquettes v3");
    expect(proposal?.kind).toBe("event");
    expect(proposal?.date).toBe(DAY);
    expect(proposal?.start).toBe("10:00");
    expect(proposal?.end).toBe("10:30");
    expect(proposal?.location).toBe("Visio");
    expect(proposal?.mailId).toBe(MAIL_ID);
    expect(proposal?.account).toBe(ALPHA);
    expect(proposal?.ai).toBe(true);
    expect(proposal?.due).toBe(formatDueDate(DAY));
    expect(proposal?.description).toBe(`Rendez-vous IA · ${formatDueDate(DAY)} 10:00–10:30 · Visio`);
    expect(proposal?.timestamp).toBe(Date.parse(RECEIVED));
    expect(result.current.tasks).toHaveLength(0);

    const calls = eventCalls(llmCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("NON FIABLE");
    expect(calls[0].user).toContain("<<<MAILS>>>");
    expect(calls[0].user).toContain("Maquettes v3");
  });

  it("ne propose aucun rendez-vous pour un mail déjà traité, sans l'écarter du modèle", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED, ALPHA, true)], [event()]);
    const { result } = mount();

    await waitFor(() => expect(eventCalls(llmCalls)).toHaveLength(1), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(eventCalls(llmCalls)[0].user).toContain("Maquettes v3");
    expect(result.current.suggestions).toHaveLength(0);
  });

  it("ne demande aucun rendez-vous quand l'extraction n'est pas activée", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event()]);
    const { result } = mount();

    await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(eventCalls(llmCalls)).toHaveLength(0);
    expect(result.current.suggestions.filter((entry) => entry.kind === "event")).toHaveLength(0);
  });

  it("ne sollicite pas le modèle pour les rendez-vous quand l'agenda est coupé", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        llm: LLM,
        summary: { enabled: false },
        calendarEnabled: false,
        aiTasks: { enabled: true, events: true, windowHours: 48 },
      }),
    );
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event()]);
    const { result } = mount();

    await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(eventCalls(llmCalls)).toHaveLength(0);
    expect(result.current.suggestions).toHaveLength(0);
  });

  it("dédoublonne un même rendez-vous proposé deux fois", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48 });
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event(), event()]);
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.kind === "event")).toBe(true),
      { timeout: 3000 },
    );

    expect(result.current.suggestions.filter((entry) => entry.proposal === "Point maquettes v3")).toHaveLength(1);
  });

  it("dédoublonne avec une suggestion de rendez-vous déjà stockée", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48 });
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event()]);
    const base = emptyState(createDevice("test", "test"));
    const stored: Doc = {
      ...eventDoc("sg:rdv"),
      raw: {
        ...eventDoc("sg:rdv").raw,
        mailId: MAIL_ID,
        account: ALPHA,
        proposal: "Point maquettes v3",
        date: DAY,
      },
    };
    const storage = createMemoryStorage({ ...base, docs: { [docKey("suggestion", "sg:rdv")]: stored } });
    const { result } = mount(storage);

    await waitFor(() => expect(result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(result.current.suggestions.filter((entry) => entry.proposal === "Point maquettes v3")).toHaveLength(1);
    expect(storedEvents(storage)).toHaveLength(1);
  });

  it("garde deux rendez-vous de même intitulé à des jours différents", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48 });
    const second = isoDate(new Date(Date.now() + 6 * 24 * H));
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event(), event({ date: second })]);
    const { result } = mount();

    await waitFor(
      () => expect(result.current.suggestions.filter((entry) => entry.kind === "event")).toHaveLength(2),
      { timeout: 3000 },
    );

    expect(result.current.suggestions.map((entry) => entry.date).sort()).toEqual([DAY, second].sort());
  });

  it("ne rappelle pas le modèle pour le même passage après un remontage", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48 });
    const llmCalls = mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event()]);
    const first = mount();

    await waitFor(
      () => expect(first.result.current.suggestions.some((entry) => entry.kind === "event")).toBe(true),
      { timeout: 3000 },
    );
    expect(eventCalls(llmCalls)).toHaveLength(1);

    first.unmount();
    const second = mount();

    await waitFor(() => expect(second.result.current.mails.length).toBeGreaterThan(0), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(eventCalls(llmCalls)).toHaveLength(1);
  });

  it("persiste le type et les champs d'agenda de la suggestion", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48 });
    mockBackend([apiThread(1, "Camille", "Maquettes v3", RECEIVED)], [event()]);
    const storage = createMemoryStorage();
    const { result } = mount(storage);

    await waitFor(
      () => expect(result.current.suggestions.some((entry) => entry.kind === "event")).toBe(true),
      { timeout: 3000 },
    );

    const [doc] = storedEvents(storage);
    expect(doc.raw).toMatchObject({
      kind: "event",
      date: DAY,
      start: "10:00",
      end: "10:30",
      location: "Visio",
      mailId: MAIL_ID,
      account: ALPHA,
      status: "pending",
    });
    const id = doc.id;
    const remount = mount(storage);
    expect(remount.result.current.suggestions.find((entry) => entry.id === id)?.kind).toBe("event");
  });
});

describe("suggestions de rendez-vous IA · exclusion par compte", () => {
  it("n'envoie pas au modèle les mails d'un compte exclu", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: true, events: true, windowHours: 48, excludedAccounts: [BETA] });
    const llmCalls = mockBackend(
      [apiThread(1, "Camille", "Maquettes v3", RECEIVED), apiThread(2, "Marc", "Accès serveur", RECEIVED, BETA)],
      [event(), event({ titre: "Point serveur", mailId: BETA_MAIL_ID })],
    );
    const { result } = mount();

    await waitFor(() => expect(eventCalls(llmCalls).length).toBeGreaterThan(0), { timeout: 3000 });

    expect(eventCalls(llmCalls).every((call) => !call.user.includes("Accès serveur"))).toBe(true);
    expect(result.current.suggestions.some((entry) => entry.account === BETA)).toBe(false);
  });

  it("masque un rendez-vous dont le mail source a été traité depuis", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    seedPrefs({ enabled: false, events: false, windowHours: 48 });
    mockBackend(
      [
        apiThread(1, "Camille", "Maquettes v3", RECEIVED, ALPHA, true),
        apiThread(2, "Marc", "Accès serveur", RECEIVED),
      ],
      [],
    );
    const base = emptyState(createDevice("test", "test"));
    const traite = eventDoc("sg:traite");
    const ouvert = eventDoc("sg:ouvert");
    const docs = {
      [docKey("suggestion", "sg:traite")]: {
        ...traite,
        raw: { ...traite.raw, mailId: MAIL_ID, account: ALPHA, proposal: "Point maquettes v3" },
      },
      [docKey("suggestion", "sg:ouvert")]: {
        ...ouvert,
        raw: { ...ouvert.raw, mailId: `${ALPHA}:INBOX:2`, account: ALPHA, proposal: "Point serveur" },
      },
    };
    const { result } = mount(createMemoryStorage({ ...base, docs }));

    await waitFor(() => expect(result.current.mails).toHaveLength(2), { timeout: 3000 });
    await waitFor(() => expect(result.current.suggestions.map((entry) => entry.proposal)).toEqual([
      "Point serveur",
    ]));
  });

  it("masque les rendez-vous déjà stockés d'un compte exclu", () => {
    seedPrefs({ enabled: true, events: true, windowHours: 48, excludedAccounts: ["perso"] });
    const base = emptyState(createDevice("test", "test"));
    const docs = {
      [docKey("suggestion", "sg:rdv-perso")]: eventDoc("sg:rdv-perso", "perso"),
      [docKey("suggestion", "sg:rdv-pro")]: eventDoc("sg:rdv-pro", "pro"),
    };
    const { result } = mount(createMemoryStorage({ ...base, docs }));

    expect(result.current.suggestions.filter((entry) => entry.kind === "event").map((entry) => entry.account)).toEqual([
      "pro",
    ]);
  });
});
