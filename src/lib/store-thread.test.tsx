import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";
import { baseDraft } from "@/lib/draft";

const ACCOUNT = "perso";
const INBOX = "INBOX";
const SENT = "Sent";
const THREAD = "t1";
const LOCAL_ID = `${ACCOUNT}:${INBOX}:1`;
const SENT_ID = `${ACCOUNT}:${SENT}:2`;

const apiAccount: ApiAccount = {
  id: ACCOUNT,
  label: "Perso",
  email: "roman@test.fr",
  username: "roman@test.fr",
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 2,
};

const apiFolder = (path: string, role: ApiFolder["role"]): ApiFolder => ({
  account_id: ACCOUNT,
  path,
  name: path,
  role,
  uidvalidity: 1,
  uidnext: 3,
  last_sync_at: null,
});

const apiMessage = (overrides: Partial<ApiMessage> = {}): ApiMessage => ({
  account_id: ACCOUNT,
  folder_path: INBOX,
  uid: 1,
  uidvalidity: 1,
  thread_id: THREAD,
  message_id: "<m1@test.fr>",
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: "roman@test.fr" }],
  cc: [],
  subject: "Planning",
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: "Aperçu",
  body_text: "Corps local",
  body_html: null,
  attachments: [],
  ...overrides,
});

const sentMessage = (overrides: Partial<ApiMessage> = {}): ApiMessage =>
  apiMessage({
    folder_path: SENT,
    uid: 2,
    message_id: "<m2@test.fr>",
    from: { name: "Roman", email: "roman@test.fr" },
    subject: "Re: Planning",
    date: "2026-01-06T10:00:00Z",
    preview: "Ma réponse",
    body_text: null,
    ...overrides,
  });

const apiThread = (messages: ApiMessage[]): ApiThread => {
  const primary = messages[messages.length - 1] ?? apiMessage();
  return {
    id: THREAD,
    account_id: ACCOUNT,
    messages,
    primary,
    count: messages.length,
    unread: messages.filter((message) => message.flags.unread).length,
    starred: messages.some((message) => message.flags.starred),
    encrypted: messages.filter((message) => message.pgp === "encrypted").length,
    attachments: 0,
    participants: messages.map((message) => message.from.email),
    subject: primary.subject,
    preview: primary.preview,
  };
};

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, statusText: "", json: async () => body }) as unknown as Response;

type Backend = {
  /** Requêtes vues, chemin décodé et query comprise. */
  calls: string[];
  /** Messages servis par la route de fil complet. */
  threadMessages: ApiMessage[];
  threadStatus: number;
  /** Corps des envois reçus par la route d'envoi. */
  sent: unknown[];
};

function mockBackend(options: { threadMessages?: ApiMessage[]; threadStatus?: number } = {}): Backend {
  const backend: Backend = {
    calls: [],
    threadMessages: options.threadMessages ?? [sentMessage(), apiMessage()],
    threadStatus: options.threadStatus ?? 200,
    sent: [],
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(url.pathname) + url.search;
    backend.calls.push(path);
    if (/\/send$/.test(path) && init?.method === "POST") {
      backend.sent.push(JSON.parse(String(init.body)));
      return reply({});
    }
    if (path === "/api/accounts") return reply([apiAccount]);
    if (path === `/api/accounts/${ACCOUNT}/folders`) {
      return reply([apiFolder(INBOX, "inbox"), apiFolder(SENT, "sent")]);
    }
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${INBOX}/threads`)) {
      return reply([apiThread([apiMessage({ flags: { unread: false, starred: true, answered: false } })])]);
    }
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${SENT}/threads`)) return reply([]);
    if (path === `/api/accounts/${ACCOUNT}/threads/${THREAD}`) {
      return backend.threadStatus === 200
        ? reply(apiThread(backend.threadMessages))
        : reply({ error: "fil indisponible", kind: "store" }, backend.threadStatus);
    }
    const message = /\/folders\/([^/]+)\/messages\/(\d+)\?/.exec(path);
    if (message) {
      return reply(
        sentMessage({ body_text: "Corps envoyé", body_html: null, preview: "Corps envoyé" }),
      );
    }
    return reply([]);
  });
  return backend;
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

async function openFirstMail() {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.mails).toHaveLength(1), { timeout: 3000 });
  act(() => hook.result.current.openMessage(hook.result.current.mails[0]));
  return hook;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fil complet du message ouvert", () => {
  it("ajoute les messages du fil rangés dans un autre dossier", async () => {
    const backend = mockBackend();
    const hook = await openFirstMail();

    await waitFor(() =>
      expect(hook.result.current.openThread?.messages.map((message) => message.id)).toEqual([
        LOCAL_ID,
        SENT_ID,
      ]),
    );
    expect(backend.calls).toContain(`/api/accounts/${ACCOUNT}/threads/${THREAD}`);
    const sent = hook.result.current.openThread?.messages.find((message) => message.id === SENT_ID);
    expect(sent?.folder).toBe("sent");
    expect(sent?.bodyFetched).toBe(false);
  });

  it("garde la version locale d'un message, drapeaux et corps compris", async () => {
    mockBackend({ threadMessages: [sentMessage(), apiMessage({ body_text: null })] });
    const hook = await openFirstMail();

    await waitFor(() => expect(hook.result.current.openThread?.messages).toHaveLength(2));
    const local = hook.result.current.openThread?.messages.find((message) => message.id === LOCAL_ID);
    expect(local?.starred).toBe(true);
    expect(local?.body).toEqual(["Corps local"]);
    expect(local?.bodyFetched).toBe(true);
  });

  it("garde le fil local quand le démon ne répond pas", async () => {
    mockBackend({ threadStatus: 500 });
    const hook = await openFirstMail();

    await waitFor(() => expect(hook.result.current.openThread).toBeDefined());
    expect(hook.result.current.openThread?.messages.map((message) => message.id)).toEqual([LOCAL_ID]);
    expect(hook.result.current.notices).toEqual([]);
  });

  it("retombe sur le fil local si le fil récupéré ne contient plus le message ouvert", async () => {
    const backend = mockBackend({ threadMessages: [sentMessage()] });
    const hook = await openFirstMail();

    await waitFor(() =>
      expect(backend.calls).toContain(`/api/accounts/${ACCOUNT}/threads/${THREAD}`),
    );
    await waitFor(() => expect(hook.result.current.openThread).toBeDefined());
    expect(hook.result.current.openThread?.messages.map((message) => message.id)).toEqual([LOCAL_ID]);
  });
});

describe("envoi d'une réponse dans le fil ouvert", () => {
  it("relit le fil après l'envoi et y montre la réponse, le mail ouvert restant affiché", async () => {
    const backend = mockBackend({ threadMessages: [apiMessage()] });
    const hook = await openFirstMail();
    await waitFor(() => expect(hook.result.current.openThread?.messages).toHaveLength(1));

    backend.threadMessages = [sentMessage(), apiMessage()];
    act(() =>
      hook.result.current.sendDraft({
        ...baseDraft(ACCOUNT, false, false, THREAD),
        to: "camille@test.fr",
        subject: "Re: Planning",
        body: "Ma réponse",
        inReplyTo: "<m1@test.fr>",
        references: ["<m1@test.fr>"],
      }),
    );

    await waitFor(() =>
      expect(hook.result.current.openThread?.messages.map((message) => message.id)).toEqual([
        LOCAL_ID,
        SENT_ID,
      ]),
    );
    const threadCalls = backend.calls.filter(
      (call) => call === `/api/accounts/${ACCOUNT}/threads/${THREAD}`,
    );
    expect(threadCalls.length).toBeGreaterThanOrEqual(2);
    expect(backend.sent).toHaveLength(1);
    expect(hook.result.current.openThread?.primary.id).toBe(LOCAL_ID);
  });
});

describe("corps d'un message antérieur", () => {
  it("lit le corps sur le serveur et met le fil à jour", async () => {
    const backend = mockBackend();
    const hook = await openFirstMail();
    await waitFor(() => expect(hook.result.current.openThread?.messages).toHaveLength(2));
    const sent = hook.result.current.openThread?.messages.find((message) => message.id === SENT_ID);
    if (!sent) throw new Error("message envoyé absent du fil");

    act(() => hook.result.current.fetchBody(sent));

    await waitFor(() => expect(backend.calls).toContain(
      `/api/accounts/${ACCOUNT}/folders/${SENT}/messages/2?fetch_body=true`,
    ));
    await waitFor(() => {
      const updated = hook.result.current.openThread?.messages.find(
        (message) => message.id === SENT_ID,
      );
      expect(updated?.body).toEqual(["Corps envoyé"]);
      expect(updated?.bodyFetched).toBe(true);
    });
    expect(hook.result.current.bodyFetching).toBeNull();
  });

  it("ne change pas l'état lu/non lu d'un antérieur en lisant son corps", async () => {
    mockBackend({
      threadMessages: [
        sentMessage({ flags: { unread: true, starred: false, answered: false } }),
        apiMessage(),
      ],
    });
    const hook = await openFirstMail();
    await waitFor(() => expect(hook.result.current.openThread?.messages).toHaveLength(2));
    const sent = hook.result.current.openThread?.messages.find((message) => message.id === SENT_ID);
    if (!sent) throw new Error("message envoyé absent du fil");
    expect(sent.unread).toBe(true);

    act(() => hook.result.current.fetchBody(sent));

    await waitFor(() => {
      const updated = hook.result.current.openThread?.messages.find(
        (message) => message.id === SENT_ID,
      );
      expect(updated?.bodyFetched).toBe(true);
      expect(updated?.unread).toBe(true);
    });
  });

  it("ne lit rien pour un message chiffré d'un compte dont PGP est coupé", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ pgpAccounts: { [ACCOUNT]: { enabled: false, encrypt: true, sign: true } } }),
    );
    const backend = mockBackend({
      threadMessages: [sentMessage({ pgp: "encrypted" }), apiMessage()],
    });
    const hook = await openFirstMail();
    await waitFor(() => expect(hook.result.current.openThread?.messages).toHaveLength(2));
    const sent = hook.result.current.openThread?.messages.find((message) => message.id === SENT_ID);
    if (!sent) throw new Error("message envoyé absent du fil");

    act(() => hook.result.current.fetchBody(sent));

    expect(
      backend.calls.filter((call) => call.includes(`/folders/${SENT}/messages/2`)),
    ).toEqual([]);
    expect(hook.result.current.bodyFetching).toBeNull();
  });
});
