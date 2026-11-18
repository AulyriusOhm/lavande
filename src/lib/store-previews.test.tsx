import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PREVIEW_PENDING } from "@/lib/mail-backend";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const ACCOUNT = "perso";
const INBOX = "INBOX";
const THREAD = "t1";
const PENDING_UID = 1;
const ENCRYPTED_UID = 2;
const KNOWN_UID = 3;
const FILLED = "Aperçu venu du serveur";

const apiAccount: ApiAccount = {
  id: ACCOUNT,
  label: "Perso",
  email: "roman@test.fr",
  username: "roman@test.fr",
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 1,
};

const apiFolder: ApiFolder = {
  account_id: ACCOUNT,
  path: INBOX,
  name: "Boîte de réception",
  role: "inbox",
  uidvalidity: 1,
  uidnext: 4,
  last_sync_at: null,
};

const apiMessage = (overrides: Partial<ApiMessage> = {}): ApiMessage => ({
  account_id: ACCOUNT,
  folder_path: INBOX,
  uid: PENDING_UID,
  uidvalidity: 1,
  thread_id: THREAD,
  message_id: "<m1@test.fr>",
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: "roman@test.fr" }],
  cc: [],
  subject: "Sans aperçu",
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: "",
  body_text: null,
  body_html: null,
  attachments: [],
  ...overrides,
});

const apiThread = (messages: ApiMessage[]): ApiThread => {
  const primary = messages[0] ?? apiMessage();
  return {
    id: THREAD,
    account_id: ACCOUNT,
    messages,
    primary,
    count: messages.length,
    unread: 0,
    starred: false,
    encrypted: messages.filter((message) => message.pgp === "encrypted").length,
    attachments: 0,
    participants: messages.map((message) => message.from.email),
    subject: primary.subject,
    preview: primary.preview,
  };
};

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, statusText: "", json: async () => body }) as unknown as Response;

type PreviewCall = { folderPath: string; uids: number[] };

type Backend = {
  /** Corps des requêtes d'aperçus, une entrée par appel. */
  previews: PreviewCall[];
  /** Ce que le démon a rempli en base : la liste suivante le sert tel quel. */
  filled: Map<number, string>;
  previewStatus: number;
  /** Faux : le serveur ne rend rien, comme un message sans texte lisible. */
  fills: boolean;
};

function mockBackend(options: { previewStatus?: number; fills?: boolean } = {}): Backend {
  const backend: Backend = {
    previews: [],
    filled: new Map(),
    previewStatus: options.previewStatus ?? 200,
    fills: options.fills ?? true,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
    if (path === "/api/accounts") return reply([apiAccount]);
    if (path === `/api/accounts/${ACCOUNT}/folders`) return reply([apiFolder]);
    if (path === `/api/accounts/${ACCOUNT}/folders/${INBOX}/threads`) {
      return reply([
        apiThread([
          apiMessage({ preview: backend.filled.get(PENDING_UID) ?? "" }),
          apiMessage({
            uid: ENCRYPTED_UID,
            message_id: "<m2@test.fr>",
            subject: "Chiffré",
            date: "2026-01-04T10:00:00Z",
            pgp: "encrypted",
          }),
          apiMessage({
            uid: KNOWN_UID,
            message_id: "<m3@test.fr>",
            subject: "Aperçu déjà là",
            date: "2026-01-03T10:00:00Z",
            preview: "Aperçu déjà là",
          }),
        ]),
      ]);
    }
    if (path === `/api/accounts/${ACCOUNT}/folders/${INBOX}/previews`) {
      const { uids } = JSON.parse(String(init?.body ?? "{}")) as { uids: number[] };
      backend.previews.push({ folderPath: INBOX, uids });
      if (backend.previewStatus !== 200) {
        return reply({ error: "serveur muet", kind: "imap" }, backend.previewStatus);
      }
      const entries = (backend.fills ? uids : [])
        .filter((uid) => uid !== ENCRYPTED_UID)
        .map((uid) => {
          backend.filled.set(uid, FILLED);
          return { uid, preview: FILLED };
        });
      return reply(entries);
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

const previewOf = (mails: { source?: { uid: number }; preview: string }[], uid: number) =>
  mails.find((mail) => mail.source?.uid === uid)?.preview;

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

describe("aperçus de la liste", () => {
  it("remplit les aperçus manquants après le chargement des fils", async () => {
    const backend = mockBackend();
    const hook = mount();

    await waitFor(() => expect(hook.result.current.mails).toHaveLength(3));
    await waitFor(() => expect(previewOf(hook.result.current.mails, PENDING_UID)).toBe(FILLED));

    expect(backend.previews).toEqual([{ folderPath: INBOX, uids: [PENDING_UID] }]);
    expect(previewOf(hook.result.current.mails, KNOWN_UID)).toBe("Aperçu déjà là");
    expect(previewOf(hook.result.current.mails, ENCRYPTED_UID)).toBe(PREVIEW_PENDING);
    expect(hook.result.current.notices).toHaveLength(0);
  });

  it("ne redemande pas un uid déjà tenté quand la liste est rechargée", async () => {
    const backend = mockBackend();
    const hook = mount();

    await waitFor(() => expect(previewOf(hook.result.current.mails, PENDING_UID)).toBe(FILLED));
    expect(backend.previews).toHaveLength(1);

    act(() => hook.result.current.setAccount(ACCOUNT));
    await waitFor(() => expect(hook.result.current.account).toBe(ACCOUNT));
    await waitFor(() => expect(hook.result.current.mails).toHaveLength(3));

    expect(backend.previews).toHaveLength(1);
    expect(previewOf(hook.result.current.mails, PENDING_UID)).toBe(FILLED);
  });

  it("garde le placeholder quand le serveur ne rend aucun aperçu, sans le redemander", async () => {
    const backend = mockBackend({ fills: false });
    const hook = mount();

    await waitFor(() => expect(backend.previews).toHaveLength(1));
    await waitFor(() => expect(hook.result.current.mails).toHaveLength(3));
    expect(previewOf(hook.result.current.mails, PENDING_UID)).toBe(PREVIEW_PENDING);
    expect(previewOf(hook.result.current.mails, KNOWN_UID)).toBe("Aperçu déjà là");
    expect(hook.result.current.notices).toHaveLength(0);

    act(() => hook.result.current.setAccount(ACCOUNT));
    await waitFor(() => expect(hook.result.current.mails).toHaveLength(3));
    expect(backend.previews).toHaveLength(1);
    expect(previewOf(hook.result.current.mails, PENDING_UID)).toBe(PREVIEW_PENDING);
  });

  it("ignore un échec de la route sans le notifier et sans réessayer", async () => {
    const backend = mockBackend({ previewStatus: 502 });
    const hook = mount();

    await waitFor(() => expect(hook.result.current.mails).toHaveLength(3));
    await waitFor(() => expect(backend.previews).toHaveLength(1));

    expect(previewOf(hook.result.current.mails, PENDING_UID)).toBe(PREVIEW_PENDING);
    expect(hook.result.current.notices).toHaveLength(0);

    act(() => hook.result.current.setAccount(ACCOUNT));
    await waitFor(() => expect(hook.result.current.mails).toHaveLength(3));
    expect(backend.previews).toHaveLength(1);
  });
});
